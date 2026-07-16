// Data-loss guard: a bridge that is "born empty" — opened with seedFromFile
// false onto a note whose CRDT is empty (a doc_id mismatch, or an empty server
// doc pulled by the background feed) — must NEVER let its emptiness reach the
// file that still has real content on disk. This is the exact failure that
// zeroed imported notes (`How Baalda works.md` → 0 bytes) before the fix. A
// genuine clear-all (the doc held content, then it was emptied) must still
// egest normally.

import { describe, expect, it, vi } from "vitest";
import { NoteBridge } from "../noteBridge";
import { makeHarness } from "./helpers";

const PATH = "note.md";
const CONTENT = "# Real content\n\nthat must not be lost\n";

describe("empty-egest clobber guard", () => {
  it("opening an imported note the sync way leaves on-disk content intact", async () => {
    vi.useFakeTimers();
    try {
      // File has content on disk; no CRDT persisted (a freshly imported note).
      // Open exactly as the signed-in editor / background feed does: no seed,
      // so the Y.Doc is empty and the server (absent here) can't fill it.
      const { io, fs } = makeHarness({ [PATH]: CONTENT });
      const bridge = await NoteBridge.open(io, {
        docId: "mismatched-id",
        path: PATH,
        seedFromFile: false,
      });
      const writesBefore = fs.writeCount;

      // Whatever the feed does — flush on eviction, timers firing — the file's
      // real bytes survive; the guard refuses any empty write over them.
      await bridge.flushEgest();
      await vi.advanceTimersByTimeAsync(1000);

      expect(fs.get(PATH)).toBe(CONTENT);
      expect(fs.writeCount).toBe(writesBefore);
      // The doc itself is (correctly) still empty — it just never clobbers disk.
      expect(bridge.serialize()).toBe("");

      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("directly refuses an empty egest over a non-empty file (born-empty doc)", async () => {
    vi.useFakeTimers();
    try {
      const { io, fs } = makeHarness({ [PATH]: CONTENT });
      const bridge = await NoteBridge.open(io, {
        docId: "mismatched-id",
        path: PATH,
        seedFromFile: false,
      });

      // Force the dangerous drain path: an empty doc egesting to disk. (Reaches
      // drainEgest via the private egest hook the feed's flush would trigger.)
      await (bridge as unknown as { drainEgest(): Promise<void> }).drainEgest();

      expect(fs.get(PATH)).toBe(CONTENT); // untouched
      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still egests a genuine clear-all (doc held content, then emptied)", async () => {
    vi.useFakeTimers();
    try {
      const { io, fs } = makeHarness({ [PATH]: CONTENT });
      // Normal local-first open: seeds the doc from the file, so it has held
      // content this session.
      const bridge = await NoteBridge.open(io, { docId: "doc-1", path: PATH });

      // User selects all and deletes.
      bridge.edit((t) => t.delete(0, t.length));
      await vi.advanceTimersByTimeAsync(300);

      // The clear reaches disk — this is a real deletion, not a born-empty doc.
      expect(bridge.serialize()).toBe("");
      expect(fs.get(PATH)).toBe("");

      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
