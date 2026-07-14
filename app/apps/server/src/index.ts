import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { createApp } from "./http/app.js";
import { createSyncServer, disconnectDoc } from "./sync/hocuspocus.js";
import { backfillIndex } from "./index/indexer.js";
import { createDocWriter } from "./mcp/doc-writer.js";

/**
 * Entry point. Runs two listeners in one Node process:
 *   - HTTP API (Hono + Better Auth) on PORT (default 3010)
 *   - Hocuspocus WebSocket sync on HOCUSPOCUS_PORT (default 3011)
 * See README "Ports".
 */
async function main() {
  const sync = createSyncServer();
  await sync.listen();

  const app = createApp({
    disconnectDoc: (vaultId, docId) => disconnectDoc(sync, vaultId, docId),
    // MCP tools write notes through the same sync server, so AI edits persist,
    // re-index, and broadcast to open editors exactly like a human edit.
    docWriter: createDocWriter(sync),
  });

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`HTTP API listening on http://localhost:${info.port}`);
    console.log(`Hocuspocus sync listening on ws://localhost:${config.hocuspocusPort}`);
  });

  // Index any pre-existing notes missing from note_index (best-effort, async).
  backfillIndex()
    .then((n) => n > 0 && console.log(`Indexer: backfilled ${n} note(s).`))
    .catch((err) => console.error("Indexer backfill failed:", err));

  const shutdown = async () => {
    console.log("Shutting down…");
    await sync.destroy();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
