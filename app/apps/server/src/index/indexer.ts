import * as Y from "yjs";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { loadDocState } from "../yjs/persistence.js";
import { embed } from "./embedder.js";

/**
 * Note indexing engine (spec: links + vectors).
 *
 * Whenever a note's Yjs doc is stored we (re)derive search + graph data:
 *   - extract the note's plain text from the shared Y.Text `content`,
 *   - parse `[[wikilink]]` references into note_links edges,
 *   - compute an embedding vector and upsert note_index.
 *
 * Indexing is debounced per doc so a burst of keystroke-sized updates collapses
 * into one DB write. note_index / note_links are a rebuildable cache derived
 * from the canonical Yjs state — see migration 005.
 */

type Queryable = Pick<pg.Pool, "query">;

/** The shared Y.Text that holds a note body (matches the desktop bridge). */
const CONTENT_FIELD = "content";

/** Default debounce window: collapse bursts of updates into one index write. */
const DEBOUNCE_MS = 2000;

// Per-doc pending timers (debounce). Keyed by docId.
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Parse `[[wikilink]]` targets out of note text. Captures the title portion
 * only — the part before any `|` alias or `#` heading anchor — and trims it.
 * Duplicates within one doc are collapsed.
 */
export function parseWikilinks(text: string): string[] {
  const re = /\[\[([^\]|#]+)/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const title = m[1].trim();
    if (title && !seen.has(title)) {
      seen.add(title);
      out.push(title);
    }
  }
  return out;
}

/** Decode a doc's stored Yjs state into its plain-text `content` body. */
export async function extractDocText(
  docId: string,
  db: Queryable = defaultPool,
): Promise<string> {
  const state = await loadDocState(docId, db);
  if (!state) return "";
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return doc.getText(CONTENT_FIELD).toString();
  } finally {
    doc.destroy();
  }
}

/**
 * Index one note now (no debounce). Resolves the doc's vault + title from the
 * notes table, extracts its text, then upserts note_index and replaces the
 * doc's note_links rows. No-op for docs with no live note row (e.g. binary
 * files), so we never index things that aren't markdown notes.
 */
export async function indexDoc(
  docId: string,
  db: Queryable = defaultPool,
): Promise<boolean> {
  const { rows } = await db.query<{
    vault_id: string;
    title: string | null;
    rel_path: string;
  }>(
    "SELECT vault_id, title, rel_path FROM notes WHERE id = $1 AND deleted_at IS NULL",
    [docId],
  );
  const note = rows[0];
  if (!note) return false;

  const content = await extractDocText(docId, db);
  const title = note.title ?? relPathStem(note.rel_path);
  const links = parseWikilinks(content);
  // Embed title + body so a query matching the title still ranks the note.
  const vector = embed(`${title ?? ""}\n${content}`);

  await db.query(
    `INSERT INTO note_index (doc_id, vault_id, title, content, vector, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, now())
     ON CONFLICT (doc_id) DO UPDATE
       SET vault_id = EXCLUDED.vault_id,
           title = EXCLUDED.title,
           content = EXCLUDED.content,
           vector = EXCLUDED.vector,
           updated_at = now()`,
    [docId, note.vault_id, title, content, JSON.stringify(vector)],
  );

  // Replace this doc's link edges wholesale (cheap; a doc has few links).
  await db.query("DELETE FROM note_links WHERE from_doc = $1", [docId]);
  for (const toTitle of links) {
    await db.query(
      `INSERT INTO note_links (vault_id, from_doc, to_title)
       VALUES ($1, $2, $3)
       ON CONFLICT (from_doc, to_title) DO NOTHING`,
      [note.vault_id, docId, toTitle],
    );
  }
  return true;
}

/**
 * Schedule a debounced (re)index for a doc. Called from the sync server's store
 * hook — repeated calls within the window reset the timer so only the last one
 * fires. Errors are logged, never thrown (indexing must not break sync).
 */
export function scheduleIndex(docId: string, delayMs: number = DEBOUNCE_MS): void {
  const existing = pending.get(docId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pending.delete(docId);
    indexDoc(docId).catch((err) => {
      console.error(`[indexer] failed to index ${docId}:`, err);
    });
  }, delayMs);
  // Don't keep the event loop alive just for a pending index.
  if (typeof timer.unref === "function") timer.unref();
  pending.set(docId, timer);
}

/**
 * Backfill: index any live note that has no note_index row yet, using its
 * already-stored Yjs state. Runs once on boot so existing docs become
 * searchable/graphable without waiting for a fresh edit. Best-effort — a
 * failure on one doc is logged and skipped. Returns the count indexed.
 */
export async function backfillIndex(db: Queryable = defaultPool): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT n.id FROM notes n
       LEFT JOIN note_index ni ON ni.doc_id = n.id
      WHERE n.deleted_at IS NULL AND ni.doc_id IS NULL`,
  );
  let count = 0;
  for (const { id } of rows) {
    try {
      if (await indexDoc(id, db)) count++;
    } catch (err) {
      console.error(`[indexer] backfill failed for ${id}:`, err);
    }
  }
  return count;
}

/** Filename stem of a rel_path, used as a fallback title. */
function relPathStem(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  return base.replace(/\.[^.]+$/, "");
}
