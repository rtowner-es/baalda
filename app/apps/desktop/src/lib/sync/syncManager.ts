// Per-doc network sync (spec 03 §4/§7, 04 §4). Composes a HocuspocusProvider on
// TOP of the bridge's local-first Y.Doc: the same doc is persisted to SQLite by
// the bridge AND synced to the server here. Offline edits accumulate locally and
// merge conflict-free on reconnect via SyncStep1/2 (the provider handles backoff).
//
// Auth: each connection carries a short-lived per-doc JWT minted from the Better
// Auth session (`POST /api/sync-token`). The provider's `token` is a function, so
// every (re)connect re-mints a fresh token; a proactive timer reconnects shortly
// before expiry (Hocuspocus doesn't re-auth mid-connection — spec 03 §7).

import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { ApiClient, ApiError } from "../api";
import { TokenRefreshScheduler } from "./tokenRefresh";

export type SyncStatus =
  | "offline" // no network provider / signed out
  | "connecting" // socket up, initial sync not complete
  | "synced" // read-write, converged with server
  | "read-only" // synced but the grant is view-only
  | "no-access" // server refused a token (403) — not shared with this user
  | "error"; // transient failure (will retry)

export interface DocSyncOptions {
  api: ApiClient;
  doc: Y.Doc;
  docId: string;
  vaultId: string;
  /** Base ws:// URL. Defaults to `deriveWsUrl(api base)` (see its doc). */
  wsUrl?: string;
  onStatus?: (status: SyncStatus) => void;
  /** Injected in tests (Node lacks a global WebSocket the provider likes). */
  webSocketPolyfill?: unknown;
}

/** Decode a JWT's `exp` (seconds since epoch) without verifying the signature. */
export function jwtExpSeconds(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json =
      typeof atob === "function"
        ? atob(payload)
        : Buffer.from(payload, "base64").toString("binary");
    const claims = JSON.parse(json) as { exp?: number };
    return typeof claims.exp === "number" ? claims.exp : null;
  } catch {
    return null;
  }
}

/** Seconds until a token expires, floored at 0 (uses `nowMs` for testability). */
export function ttlFromToken(token: string, nowMs = Date.now()): number {
  const exp = jwtExpSeconds(token);
  if (exp == null) return 600; // fall back to the server default TTL
  return Math.max(0, exp - Math.floor(nowMs / 1000));
}

/**
 * Derive the sync WebSocket URL from the HTTP base.
 *
 * Two server topologies, two rules:
 *  - Local/self-hosted dev (explicit port 3010, README "Ports" default): the
 *    dedicated Hocuspocus port 3011 is still separate from the HTTP API, so we
 *    just swap scheme http→ws and bump 3010→3011, path untouched. Kept for
 *    back-compat with existing dev setups and older self-hosted servers.
 *  - Everything else — no port (a normal hosted domain) or any other explicit
 *    port (e.g. a PaaS-assigned :8080) — assumes the single-port topology: the
 *    WS upgrade is mounted at `/sync` on the SAME origin/port as the HTTP API.
 *    We swap scheme and append `/sync` after any existing path (preserving a
 *    reverse-proxy sub-path prefix), collapsing double/trailing slashes. This
 *    is what lets the server run behind one domain on PaaS hosts.
 *
 * Unparseable input falls back to the legacy local default.
 */
export function deriveWsUrl(httpBase: string): string {
  try {
    const u = new URL(httpBase);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    if (u.port === "3010") {
      u.port = "3011";
    } else {
      const prefix = u.pathname.replace(/\/+$/, "");
      u.pathname = `${prefix}/sync`;
    }
    return u.toString().replace(/\/+$/, "");
  } catch {
    return "ws://localhost:3011";
  }
}

export class DocSync {
  readonly provider: HocuspocusProvider;
  readonly awareness: Awareness;

  private readonly api: ApiClient;
  private readonly docId: string;
  private readonly onStatus?: (status: SyncStatus) => void;
  private readonly refresher: TokenRefreshScheduler;

  private _status: SyncStatus = "connecting";
  private _readOnly = false;
  private destroyed = false;

  constructor(opts: DocSyncOptions) {
    this.api = opts.api;
    this.docId = opts.docId;
    this.onStatus = opts.onStatus;

    const wsUrl = opts.wsUrl ?? deriveWsUrl(this.api.getBaseUrl());
    const name = `vault:${opts.vaultId}/note:${opts.docId}`;

    this.refresher = new TokenRefreshScheduler(() => this.reconnectWithFreshToken());

    this.provider = new HocuspocusProvider({
      url: wsUrl,
      name,
      document: opts.doc,
      // A token *function* → the provider re-mints on every (re)connect.
      token: async () => (await this.mintToken()) ?? "",
      ...(opts.webSocketPolyfill
        ? { WebSocketPolyfill: opts.webSocketPolyfill as typeof WebSocket }
        : {}),
      onAuthenticationFailed: () => {
        // Token rejected/expired. If we still have access, a reconnect re-mints;
        // if the mint itself 403s, mintToken() sets 'no-access' and we stop.
        if (!this.destroyed && this._status !== "no-access") {
          this.setStatus("error");
          this.reconnectWithFreshToken();
        }
      },
      onStatus: ({ status }) => {
        if (this.destroyed) return;
        if (status === "connected") {
          this.setStatus(this._readOnly ? "read-only" : "synced");
        } else if (status === "connecting") {
          this.setStatus("connecting");
        } else if (status === "disconnected") {
          if (this._status !== "no-access") this.setStatus("offline");
        }
      },
      onSynced: () => {
        if (!this.destroyed && this._status !== "no-access") {
          this.setStatus(this._readOnly ? "read-only" : "synced");
        }
      },
    });

    this.awareness = this.provider.awareness as Awareness;
  }

  get status(): SyncStatus {
    return this._status;
  }
  get readOnly(): boolean {
    return this._readOnly;
  }
  get isSynced(): boolean {
    return this.provider.isSynced;
  }

  /** Resolve once the initial server sync completes (or reject on no-access). */
  whenSynced(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.provider.isSynced) return resolve();
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.provider.off("synced", onSynced);
        fn();
      };
      const onSynced = () => finish(resolve);
      this.provider.on("synced", onSynced);
      const timer = setTimeout(() => finish(resolve), timeoutMs); // resolve anyway → offline-first
      // If access was already refused, don't wait the full timeout.
      if (this._status === "no-access") finish(() => reject(new Error("no access")));
    });
  }

  private async mintToken(): Promise<string | null> {
    try {
      const res = await this.api.syncToken(this.docId);
      this._readOnly = res.readOnly;
      // (Re)arm refresh based on the real token TTL.
      this.refresher.schedule(ttlFromToken(res.token));
      if (this._status !== "no-access") {
        this.setStatus(res.readOnly ? "read-only" : "synced");
      }
      return res.token;
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        this.setStatus("no-access");
        this.refresher.cancel();
        return null;
      }
      this.setStatus("error");
      return null;
    }
  }

  private reconnectWithFreshToken(): void {
    if (this.destroyed) return;
    try {
      this.provider.disconnect();
      this.provider.connect();
    } catch (e) {
      console.error("[sync] reconnect failed", e);
    }
  }

  private setStatus(s: SyncStatus): void {
    if (this._status === s) return;
    this._status = s;
    this.onStatus?.(s);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.refresher.cancel();
    try {
      this.provider.destroy();
    } catch {
      /* ignore */
    }
  }
}
