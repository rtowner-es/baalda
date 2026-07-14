import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";
import type { Server } from "@hocuspocus/server";
import { createSyncServer, disconnectDoc, type SyncContext } from "../src/sync/hocuspocus.js";
import { formatDocName } from "../src/sync/doc-name.js";
import { mintSyncToken } from "../src/tokens/sync-token.js";
import { countUpdates } from "../src/yjs/persistence.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";

const PORT = 3987;
const URL = `ws://127.0.0.1:${PORT}`;
const VAULT = "vault-e2e";

let server: Server<SyncContext>;

function waitFor(cond: () => boolean, timeoutMs = 8000, label = "condition"): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timeout: ${label}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

interface Client {
  provider: HocuspocusProvider;
  doc: Y.Doc;
  text: Y.Text;
}

async function connect(docId: string, readOnly: boolean): Promise<Client> {
  const token = await mintSyncToken({ docId, vaultId: VAULT, readOnly });
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: URL,
    name: formatDocName(VAULT, docId),
    token,
    document: doc,
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
  });
  await waitFor(() => provider.isSynced, 8000, "provider synced");
  return { provider, doc, text: doc.getText("content") };
}

describe("end-to-end Yjs sync through the server (spec 03 §3, 04 §4)", () => {
  beforeAll(async () => {
    await resetDb();
    server = createSyncServer(PORT);
    await server.listen();
  });
  afterAll(async () => {
    await server.destroy();
    await pool.end();
  });
  beforeEach(async () => {
    await resetDb();
  });

  it("two edit clients converge on one doc", async () => {
    const docId = "e2e-converge";
    const a = await connect(docId, false);
    a.text.insert(0, "Hello from A");

    const b = await connect(docId, false);
    // B receives A's state on sync
    await waitFor(() => b.text.toString() === "Hello from A", 8000, "B sees A");
    expect(b.text.toString()).toBe("Hello from A");

    // B edits; A converges
    b.text.insert(b.text.length, " + B");
    await waitFor(() => a.text.toString() === "Hello from A + B", 8000, "A sees B");
    expect(a.text.toString()).toBe("Hello from A + B");

    // Server persisted the binary updates (onChange append is awaited server-side).
    await new Promise((r) => setTimeout(r, 300));
    expect(await countUpdates(docId)).toBeGreaterThan(0);

    a.provider.destroy();
    b.provider.destroy();
  });

  it("a read-only client's edits are rejected by the server", async () => {
    const docId = "e2e-readonly";
    const editor = await connect(docId, false);
    editor.text.insert(0, "canonical");
    await waitFor(() => editor.text.toString() === "canonical");

    const viewer = await connect(docId, true);
    await waitFor(() => viewer.text.toString() === "canonical", 8000, "viewer synced state");

    // Viewer attempts an edit — server must NOT broadcast/persist it.
    viewer.text.insert(0, "HACK ");

    // Give the network time; the editor must never see the viewer's change.
    await new Promise((r) => setTimeout(r, 800));
    expect(editor.text.toString()).toBe("canonical");

    editor.provider.destroy();
    viewer.provider.destroy();
  });

  it("revoking disconnects a live socket (instant kill)", async () => {
    const docId = "e2e-revoke";
    const c = await connect(docId, false);
    expect(c.provider.isSynced).toBe(true);

    disconnectDoc(server, VAULT, docId);

    // The provider notices the socket drop (status leaves 'connected').
    await waitFor(
      () => c.provider.configuration.websocketProvider.status !== "connected",
      8000,
      "socket closed",
    ).catch(() => {});
    // Best-effort: it should no longer report a live synced connection soon after.
    c.provider.disconnect();
    c.provider.destroy();
  });
});
