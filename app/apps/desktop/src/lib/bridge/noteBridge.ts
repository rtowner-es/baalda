// NoteBridge — one Y.Doc (a single Y.Text 'content') per note, reconciled with
// the plain-markdown file on disk (spec 03 §5). Two guards keep the loop safe:
//   • origin tags   — never react to a change we caused ('disk' egest is dropped)
//   • lastWrittenHash — the ingest side ignores the exact bytes egest just wrote
//
// This module is pure: it takes all I/O through `BridgeIO`, so it runs under
// vitest in Node with an in-memory fake and no Tauri/DOM.

import * as Y from "yjs";
import { applyDiff, changeRatio, computeDiff } from "./diff";
import {
  DEFAULT_CONFIG,
  ORIGIN_DISK,
  ORIGIN_EDITOR,
  ORIGIN_REMOTE,
  type BridgeConfig,
  type BridgeIO,
  type NoteBridgeOptions,
} from "./types";

export class NoteBridge {
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  readonly docId: string;

  private io: BridgeIO;
  private cfg: BridgeConfig;
  private _path: string;
  /** Seed from file on open when no CRDT exists (false ⇒ sync layer seeds later). */
  private seedOnOpen: boolean;

  /** Hash of the bytes we last wrote to disk; the ingest echo guard (spec 03 §5). */
  private lastWrittenHash: string | null = null;

  /** Count of updates in the persisted log since the last snapshot/compaction. */
  private logLength = 0;
  /** Monotonic count of every update ever observed on this doc (for assertions). */
  private observedUpdates = 0;
  /** True once a recovery snapshot has been taken for a large diff. */
  private recoverySnapshotTaken = false;

  private ingestTimer: number | null = null;
  private egestTimer: number | null = null;
  private ingestDirty = false;
  private destroyed = false;

  private readonly setT: (fn: () => void, ms: number) => number;
  private readonly clearT: (id: number) => void;

  private readonly onDocUpdate: (update: Uint8Array, origin: unknown) => void;
  private readonly onTextChange: (evt: Y.YTextEvent, tr: Y.Transaction) => void;

  // UndoManager scoped to local editor edits only — 'disk'/'remote' origins are
  // never undoable. y-codemirror's yCollab additionally registers its own sync
  // origin on this manager, so editor keystrokes are tracked in production too.
  readonly undoManager: Y.UndoManager;

  private constructor(io: BridgeIO, opts: NoteBridgeOptions) {
    this.io = io;
    this.docId = opts.docId;
    this._path = opts.path;
    this.seedOnOpen = opts.seedFromFile !== false;
    this.cfg = { ...DEFAULT_CONFIG, ...(opts.config ?? {}) };
    this.doc = new Y.Doc();
    this.text = this.doc.getText("content");
    this.undoManager = new Y.UndoManager(this.text, {
      trackedOrigins: new Set([ORIGIN_EDITOR]),
    });

    this.setT =
      io.setTimeout ??
      ((fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number);
    this.clearT =
      io.clearTimeout ?? ((id) => globalThis.clearTimeout(id));

    this.onDocUpdate = (update) => {
      // Persist every update regardless of origin — it's part of doc history.
      this.observedUpdates++;
      this.logLength++;
      void Promise.resolve(this.io.persistence.appendUpdate(this.docId, update)).catch(
        (e) => this.reportError(e, "appendUpdate"),
      );
    };

    this.onTextChange = (_evt, tr) => {
      // A change we applied from the file must not be written back (spec 03 §5.B).
      if (tr.origin === ORIGIN_DISK) return;
      this.scheduleEgest();
    };
  }

  get path(): string {
    return this._path;
  }

  /** Current serialization of the note (raw markdown). */
  serialize(): string {
    return this.text.toString();
  }

  /** For tests/observability: total updates observed since open. */
  get updatesObserved(): number {
    return this.observedUpdates;
  }
  get pendingLogLength(): number {
    return this.logLength;
  }
  get hasRecoverySnapshot(): boolean {
    return this.recoverySnapshotTaken;
  }
  get lastHash(): string | null {
    return this.lastWrittenHash;
  }

  /**
   * Open a note: hydrate the Y.Doc from persisted CRDT state, or seed it from
   * the current file if there is none, then wire the observers.
   */
  static async open(io: BridgeIO, opts: NoteBridgeOptions): Promise<NoteBridge> {
    const b = new NoteBridge(io, opts);
    await b.hydrate();
    return b;
  }

  private async hydrate(): Promise<void> {
    const state = await this.io.persistence.loadState(this.docId);
    const hasPersisted = state.snapshot != null || state.updates.length > 0;

    if (hasPersisted) {
      // Apply persisted state BEFORE subscribing, so we don't re-append what we
      // just loaded. Yjs updates are idempotent, but re-appending grows the log.
      this.doc.transact(() => {
        if (state.snapshot) Y.applyUpdate(this.doc, state.snapshot, "persistence");
        for (const u of state.updates) Y.applyUpdate(this.doc, u, "persistence");
      }, "persistence");
      this.logLength = state.updateCount;
      this.subscribe();
      // Baseline the echo guard at the current content so an identical file
      // doesn't trigger a spurious ingest, but a genuine external change does.
      this.lastWrittenHash = await this.hash(this.text.toString());
      if (state.updateCount > this.cfg.compactThreshold) await this.compact();
    } else {
      // No CRDT yet. Normally seed Y.Text from the file in a 'disk' transaction
      // (persisted but not echoed back as a write). When `seedOnOpen` is false
      // (signed in) we DEFER: leave the doc empty so the sync layer can pull the
      // server's canonical state first, then call `seedFromFileIfEmpty()` for a
      // genuine orphan (spec 03 §5 startup ordering).
      this.subscribe();
      let fileText = "";
      try {
        fileText = await this.io.readFile(this._path);
      } catch (e) {
        this.reportError(e, "seed:readFile");
        fileText = "";
      }
      if (this.seedOnOpen && fileText.length > 0) {
        this.doc.transact(() => {
          this.text.insert(0, fileText);
        }, ORIGIN_DISK);
      }
      // Baseline the echo guard at the file's current bytes either way, so a
      // later egest of server content is seen as a genuine change and no
      // spurious ingest fires before we've seeded.
      this.lastWrittenHash = await this.hash(fileText);
    }
  }

  /**
   * Orphan-seed hook for the startup-ordering rule (spec 03 §5). After the sync
   * layer has pulled the server's state, if this doc is STILL empty and the file
   * has content, seed the doc from disk (origin 'disk' → persisted locally and
   * propagated to the server as this device's contribution, but not egested back
   * to the file). Returns true if it seeded.
   */
  async seedFromFileIfEmpty(): Promise<boolean> {
    if (this.destroyed || this.text.length > 0) return false;
    let fileText = "";
    try {
      fileText = await this.io.readFile(this._path);
    } catch (e) {
      this.reportError(e, "seed:readFile");
      return false;
    }
    if (fileText.length === 0) return false;
    this.doc.transact(() => {
      this.text.insert(0, fileText);
    }, ORIGIN_DISK);
    this.lastWrittenHash = await this.hash(fileText);
    return true;
  }

  private subscribe(): void {
    this.doc.on("update", this.onDocUpdate);
    this.text.observe(this.onTextChange);
  }

  // ---- A. DISK → CRDT (ingest) -----------------------------------------

  /**
   * Signal that the file changed. Debounced (~150ms) with a dirty flag so a
   * burst of watcher events drains as one read against the CRDT's *current*
   * serialization (spec 03 §5.A).
   */
  ingest(): void {
    if (this.destroyed) return;
    this.ingestDirty = true;
    if (this.ingestTimer != null) this.clearT(this.ingestTimer);
    this.ingestTimer = this.setT(() => {
      this.ingestTimer = null;
      void this.drainIngest();
    }, this.cfg.ingestDebounceMs);
  }

  private async drainIngest(): Promise<void> {
    if (this.destroyed || !this.ingestDirty) return;
    this.ingestDirty = false;

    let fileText: string;
    try {
      fileText = await this.io.readFile(this._path);
    } catch (e) {
      this.reportError(e, "ingest:readFile");
      return;
    }

    const fileHash = await this.hash(fileText);
    if (fileHash === this.lastWrittenHash) return; // our own write echoing back → DROP

    const current = this.text.toString();
    if (current === fileText) {
      // Already converged (e.g. we ingested this exact change already).
      this.lastWrittenHash = fileHash;
      return;
    }

    const diffs = computeDiff(current, fileText);
    const ratio = changeRatio(diffs, current.length, fileText.length);

    if (ratio > this.cfg.largeDiffRatio) {
      // A coarse whole-file rewrite (e.g. an AI edit) can merge badly against a
      // concurrent edit. Snapshot the pre-diff state first so it's recoverable
      // (spec 02 §6, spec 03 §5). The snapshot row IS the recovery point; the
      // diff then lands as fresh updates on top of it.
      try {
        const snapshot = Y.encodeStateAsUpdate(this.doc);
        const stateVector = Y.encodeStateVector(this.doc);
        await this.io.persistence.saveSnapshot(this.docId, snapshot, stateVector);
        this.logLength = 0;
        this.recoverySnapshotTaken = true;
      } catch (e) {
        this.reportError(e, "ingest:recoverySnapshot");
      }
    }

    this.doc.transact(() => {
      applyDiff(this.text, diffs);
    }, ORIGIN_DISK);
  }

  // ---- B. CRDT → DISK (egest) ------------------------------------------

  private scheduleEgest(): void {
    if (this.destroyed) return;
    if (this.egestTimer != null) this.clearT(this.egestTimer);
    this.egestTimer = this.setT(() => {
      this.egestTimer = null;
      void this.drainEgest();
    }, this.cfg.egestDebounceMs);
  }

  private async drainEgest(): Promise<void> {
    if (this.destroyed) return;
    const content = this.text.toString();
    // Set the echo guard BEFORE writing so the watcher's ingest sees our bytes
    // and drops them (this is what closes the loop — spec 03 §5).
    this.lastWrittenHash = await this.hash(content);
    try {
      await this.io.writeFileAtomic(this._path, content);
      if (this.io.reindex) await this.io.reindex(this._path);
    } catch (e) {
      this.reportError(e, "egest:write");
    }
  }

  /**
   * Flush a pending egest now (used on close / explicit save). No-op when
   * nothing is pending, so closing an untouched note performs no write.
   */
  async flushEgest(): Promise<void> {
    if (this.egestTimer == null) return;
    this.clearT(this.egestTimer);
    this.egestTimer = null;
    await this.drainEgest();
  }

  // ---- Edit entry points -----------------------------------------------

  /** Apply a local editor edit (origin 'editor'); schedules an egest. */
  edit(mutator: (text: Y.Text) => void): void {
    this.doc.transact(() => mutator(this.text), ORIGIN_EDITOR);
  }

  /** Apply a remote update from the network provider (Phase 2). */
  applyRemote(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, ORIGIN_REMOTE);
  }

  // ---- Compaction -------------------------------------------------------

  /** Merge the log into one snapshot and truncate it (spec 02 §4). */
  async compact(): Promise<void> {
    const snapshot = Y.encodeStateAsUpdate(this.doc);
    const stateVector = Y.encodeStateVector(this.doc);
    await this.io.persistence.saveSnapshot(this.docId, snapshot, stateVector);
    this.logLength = 0;
  }

  // ---- Teardown ---------------------------------------------------------

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.ingestTimer != null) this.clearT(this.ingestTimer);
    if (this.egestTimer != null) this.clearT(this.egestTimer);
    this.ingestTimer = null;
    this.egestTimer = null;
    this.text.unobserve(this.onTextChange);
    this.doc.off("update", this.onDocUpdate);
    this.undoManager.destroy();
    this.doc.destroy();
  }

  // ---- helpers ----------------------------------------------------------

  private async hash(text: string): Promise<string> {
    return await this.io.sha256(text);
  }

  private reportError(err: unknown, context: string): void {
    if (this.io.onError) this.io.onError(err, context);
    else console.error(`[bridge:${context}]`, err);
  }
}
