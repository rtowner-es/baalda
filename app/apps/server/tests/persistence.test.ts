import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendUpdate,
  compact,
  countUpdates,
  loadDocState,
} from "../src/yjs/persistence.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";

const DOC = "doc-persist-1";

describe("binary Yjs persistence + compaction (spec 02 §5A / 03 §3)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("round-trips: appended updates rebuild the exact text", async () => {
    // Build a doc incrementally and log each update.
    const doc = new Y.Doc();
    const text = doc.getText("content");
    const updates: Uint8Array[] = [];
    doc.on("update", (u) => updates.push(u));
    text.insert(0, "Hello");
    text.insert(5, ", world");
    text.insert(0, "# ");
    doc.destroy();

    for (const u of updates) await appendUpdate(DOC, u, pool, 1000);

    const state = await loadDocState(DOC);
    expect(state).not.toBeNull();
    const rebuilt = new Y.Doc();
    Y.applyUpdate(rebuilt, state!);
    expect(rebuilt.getText("content").toString()).toBe("# Hello, world");
  });

  it("compaction merges the log into one snapshot and truncates", async () => {
    const threshold = 10;
    let compactedAtLeastOnce = false;

    // Build 15 sequential updates from ONE doc, then append; exceeding the
    // threshold makes compaction fire inside appendUpdate.
    const doc = new Y.Doc();
    const text = doc.getText("content");
    const seq: Uint8Array[] = [];
    doc.on("update", (u) => seq.push(u));
    for (let i = 0; i < 15; i++) text.insert(text.length, "y");
    doc.destroy();

    for (const u of seq) {
      const r = await appendUpdate(DOC, u, pool, threshold);
      if (r.compacted) compactedAtLeastOnce = true;
    }

    expect(compactedAtLeastOnce).toBe(true);

    // A snapshot row exists...
    const snap = await pool.query("SELECT doc_id, seq FROM doc_snapshots WHERE doc_id = $1", [DOC]);
    expect(snap.rows.length).toBe(1);

    // ...and the update log was truncated below the threshold.
    expect(await countUpdates(DOC, pool)).toBeLessThanOrEqual(threshold);

    // State still reconstructs the full text (15 y's).
    const state = await loadDocState(DOC);
    const rebuilt = new Y.Doc();
    Y.applyUpdate(rebuilt, state!);
    expect(rebuilt.getText("content").toString()).toBe("y".repeat(15));
  });

  it("explicit compact() is idempotent and preserves state", async () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    const seq: Uint8Array[] = [];
    doc.on("update", (u) => seq.push(u));
    text.insert(0, "abc");
    text.insert(3, "def");
    doc.destroy();
    for (const u of seq) await appendUpdate(DOC, u, pool, 1000);

    await compact(DOC, pool);
    await compact(DOC, pool); // second call: nothing left to compact
    expect(await countUpdates(DOC, pool)).toBe(0);

    const state = await loadDocState(DOC);
    const rebuilt = new Y.Doc();
    Y.applyUpdate(rebuilt, state!);
    expect(rebuilt.getText("content").toString()).toBe("abcdef");
  });
});
