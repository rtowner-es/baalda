// Doc-session coordinator: ties the local-first bridge (Y.Doc + disk) to the
// network provider, enforcing the startup-ordering rule (spec 03 §5) and owning
// presence for the currently-open note.
//
// Flow when signed in with an active, reconciled vault:
//   1. Open the bridge WITHOUT seeding (deferred).
//   2. Connect the provider and wait for the initial server sync.
//   3. Seed from local markdown only if the doc is still empty (orphan).
//   4. Bind the editor to the provider's awareness; read-only if the grant is view.
// When signed out / offline / unmapped, it falls back to a local Awareness and
// the bridge's normal seed-from-file (pure local-first).

import { Awareness } from "y-protocols/awareness";
import type { NoteBridge } from "../bridge";
import type { SessionInfo } from "../api";
import type { TreeNode } from "../ipc";
import * as ipc from "../ipc";
import { api } from "../auth/authManager";
import { presenceUser } from "../presence/color";
import { AttachmentSync } from "./attachments";
import { decideSeed } from "./startup";
import { DocSync, type SyncStatus } from "./syncManager";
import { VaultRegistry } from "./registry";

/** Basename of a vault-relative path (for the upload's x-file-name hint). */
function baseName(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i === -1 ? relPath : relPath.slice(i + 1);
}

export interface OpenedDoc {
  awareness: Awareness;
  sync: DocSync | null;
  readOnly: boolean;
  status: SyncStatus;
}

export class SyncManager {
  readonly registry = new VaultRegistry(api);

  private current: DocSync | null = null;
  private currentLocalAwareness: Awareness | null = null;
  private enabled = false;
  private presence: { id: string; name: string } | null = null;
  private onStatus?: (status: SyncStatus) => void;
  private attachments: AttachmentSync | null = null;

  /** UI subscribes here to render the per-note sync indicator. */
  setStatusListener(cb: ((status: SyncStatus) => void) | undefined): void {
    this.onStatus = cb;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** True if opening `relPath` will connect a network provider. */
  willSync(relPath: string): boolean {
    return this.enabled && this.registry.getMapping(relPath) != null;
  }

  /**
   * Enable networked sync for a vault: reconcile the registry so doc_ids are
   * shared across devices, and remember the presence identity. Requires an
   * active organization; a no-op (disabled) otherwise.
   */
  async enable(
    session: SessionInfo,
    tree: TreeNode,
    vaultName: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!session.activeOrganizationId) {
      this.enabled = false;
      return { ok: false, reason: "no active organization" };
    }
    this.presence = { id: session.user.id, name: session.user.name || session.user.email };
    try {
      await this.registry.reconcile(
        { organizationId: session.activeOrganizationId, vaultName },
        tree,
      );
      this.enabled = true;
      this.setupAttachments();
      // Initial attachment reconcile (fire-and-forget; errors are logged).
      void this.attachments?.reconcile();
      return { ok: true };
    } catch (e) {
      this.enabled = false;
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Sign-out / vault-switch: stop networked sync. */
  disable(): void {
    this.enabled = false;
    this.presence = null;
    this.attachments = null;
    this.closeCurrent();
  }

  /**
   * Handle a watcher `file-changed` event under `attachments/`: schedule a
   * debounced two-way reconcile. Attachments never touch the CRDT pipeline.
   */
  handleAttachmentChanged(): void {
    if (!this.enabled) return;
    this.attachments?.scheduleReconcile();
  }

  /** Build the AttachmentSync from the reconciled server vault id + ipc/api. */
  private setupAttachments(): void {
    const vaultId = this.registry.vaultId;
    if (!vaultId) {
      this.attachments = null;
      return;
    }
    this.attachments = new AttachmentSync({
      listLocal: () => ipc.listAttachments(),
      readLocal: (relPath) => ipc.readBinaryFile(relPath),
      writeLocal: (relPath, bytes) => ipc.writeBinaryFile(relPath, bytes),
      listServer: () => api.listVaultBlobs(vaultId),
      uploadServer: (relPath, bytes, mime) =>
        api
          .uploadBlob({ vaultId, relPath, bytes, mime, fileName: baseName(relPath) })
          .then(() => undefined),
      downloadServer: (id) => api.downloadBlob(id),
    });
  }

  /**
   * Open a doc-session for a freshly-opened bridge. Assumes the caller opened the
   * bridge with `seedFromFile: !willSync(relPath)`.
   */
  async openDoc(bridge: NoteBridge, relPath: string): Promise<OpenedDoc> {
    this.closeCurrent();

    const mapping = this.enabled ? this.registry.getMapping(relPath) : null;
    if (!mapping) {
      // Local-only: the bridge already seeded from disk on open.
      const awareness = new Awareness(bridge.doc);
      this.currentLocalAwareness = awareness;
      this.applyPresence(awareness);
      return { awareness, sync: null, readOnly: false, status: "offline" };
    }

    const sync = new DocSync({
      api,
      doc: bridge.doc,
      docId: mapping.docId,
      vaultId: mapping.vaultId,
      onStatus: this.onStatus,
    });
    this.current = sync;

    // Pull-before-seed: wait for the initial server sync (resolves early offline
    // via the whenSynced timeout), then seed only a genuine orphan. The bridge's
    // `seedFromFileIfEmpty` re-checks emptiness + file content atomically, so the
    // `decideSeed` call here documents/guards the ordering decision.
    await sync.whenSynced(5000);
    const decision = decideSeed({
      signedIn: true,
      serverSynced: true, // past whenSynced (real sync or its offline timeout)
      docEmpty: bridge.serialize().length === 0,
      fileHasContent: true, // seedFromFileIfEmpty is a no-op when the file is empty
    });
    if (decision.action === "seed-from-file") {
      await bridge.seedFromFileIfEmpty();
    }

    this.applyPresence(sync.awareness);
    return {
      awareness: sync.awareness,
      sync,
      readOnly: sync.readOnly,
      status: sync.status,
    };
  }

  currentSync(): DocSync | null {
    return this.current;
  }

  closeCurrent(): void {
    if (this.current) {
      this.current.destroy();
      this.current = null;
    }
    if (this.currentLocalAwareness) {
      this.currentLocalAwareness.destroy();
      this.currentLocalAwareness = null;
    }
  }

  private applyPresence(awareness: Awareness): void {
    if (!this.presence) return;
    awareness.setLocalStateField(
      "user",
      presenceUser(this.presence.id, this.presence.name),
    );
  }
}

/** Process-wide singleton (parallels `bridgeManager`). */
export const syncManager = new SyncManager();
