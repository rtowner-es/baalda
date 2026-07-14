// Production wiring: maps the bridge's injected I/O to `ipc.ts` (Tauri) and a
// Web Crypto SHA-256, plus a small manager that owns the currently-open note's
// bridge and routes watcher events into it.

import * as ipc from "../ipc";
import { NoteBridge } from "./noteBridge";
import type { BridgeIO } from "./types";

/** SHA-256 hex via the Web Crypto API (available in the Tauri webview). */
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Build the production BridgeIO backed by Rust commands. */
export function createTauriBridgeIO(): BridgeIO {
  return {
    readFile: (path) => ipc.readNote(path),
    // write_note performs the atomic temp-file+rename AND re-indexes in Rust,
    // so egest gets FTS/backlink refresh for free — no separate reindex hook.
    writeFileAtomic: (path, content) => ipc.writeNote(path, content),
    sha256: sha256Hex,
    persistence: {
      loadState: async (docId) => {
        const s = await ipc.loadYjsState(docId);
        return {
          snapshot: s.snapshot ? new Uint8Array(s.snapshot) : null,
          updates: s.updates.map((u) => new Uint8Array(u)),
          updateCount: s.updateCount,
        };
      },
      appendUpdate: (docId, update) => ipc.appendYjsUpdate(docId, update),
      saveSnapshot: (docId, snapshot, stateVector) =>
        ipc.saveYjsSnapshot(docId, snapshot, stateVector),
    },
  };
}

/**
 * Owns the bridge for the currently-open note. The editor opens a note through
 * this; the watcher subscription funnels `file-changed` events into the live
 * bridge's debounced ingest.
 */
export class BridgeManager {
  private io: BridgeIO;
  private current: { path: string; docId: string; bridge: NoteBridge } | null =
    null;

  constructor(io: BridgeIO = createTauriBridgeIO()) {
    this.io = io;
  }

  async openNote(
    path: string,
    docId: string,
    opts: { seedFromFile?: boolean } = {},
  ): Promise<NoteBridge> {
    if (this.current?.path === path && this.current.docId === docId) {
      return this.current.bridge;
    }
    await this.closeCurrent();
    const bridge = await NoteBridge.open(this.io, {
      docId,
      path,
      seedFromFile: opts.seedFromFile,
    });
    this.current = { path, docId, bridge };
    return bridge;
  }

  /** Route a watcher event: ingest if it targets the open note. */
  handleFileChanged(path: string): void {
    if (this.current?.path === path) this.current.bridge.ingest();
  }

  currentBridge(): NoteBridge | null {
    return this.current?.bridge ?? null;
  }

  currentPath(): string | null {
    return this.current?.path ?? null;
  }

  async closeCurrent(): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    try {
      await cur.bridge.flushEgest();
    } catch (e) {
      console.error("[bridge] flush on close failed", e);
    }
    cur.bridge.destroy();
  }
}

/** Process-wide singleton used by the UI. */
export const bridgeManager = new BridgeManager();
