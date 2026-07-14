// Assembles the wikilink graph for the Graph View (Obsidian-style).
//
// Data source: `listNoteTitles` gives every note id/title/path; `getBacklinks`
// gives, per note, the notes that link INTO it. Inverting each backlink turns
// it into a directed edge in the "links to" direction (A -> B means A links
// to B), which is what a force graph wants to draw. This is the same data the
// Rust index already maintains for the BacklinksPanel, so no new Rust command
// is needed and the call fans out at O(notes) — fine for a few hundred notes.
//
// The IPC calls and the pure transformation are kept separate so the
// transformation (dedupe, self-link/dangling-link filtering, linkCount
// aggregation) can be unit-tested without Tauri.

import { getBacklinks, listNoteTitles, type Backlink, type NoteTitle } from "../ipc";

export interface GraphNode {
  id: string;
  title: string;
  path: string;
  /** Number of distinct notes this note links to or is linked from. */
  linkCount: number;
}

export interface GraphEdge {
  /** Note id that contains the [[wikilink]]. */
  source: string;
  /** Note id the wikilink resolves to. */
  target: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Pure transformation: notes + per-note backlinks -> a deduped node/edge graph.
 * Exported separately from `buildGraph` so tests can exercise it with fixture
 * data instead of a real Tauri backend.
 */
export function assembleGraph(
  titles: NoteTitle[],
  backlinksByNoteId: Map<string, Backlink[]>,
): Graph {
  const knownIds = new Set(titles.map((t) => t.id));
  const linkCount = new Map<string, number>();
  const edgeKeys = new Set<string>();
  const edges: GraphEdge[] = [];

  for (const note of titles) {
    const backlinks = backlinksByNoteId.get(note.id) ?? [];
    for (const bl of backlinks) {
      if (bl.id === note.id) continue; // no self-loops
      if (!knownIds.has(bl.id)) continue; // ignore dangling/unresolved refs
      const key = `${bl.id}->${note.id}`;
      if (edgeKeys.has(key)) continue; // dedupe repeated [[wikilinks]] between the same pair
      edgeKeys.add(key);
      edges.push({ source: bl.id, target: note.id });
      linkCount.set(bl.id, (linkCount.get(bl.id) ?? 0) + 1);
      linkCount.set(note.id, (linkCount.get(note.id) ?? 0) + 1);
    }
  }

  const nodes: GraphNode[] = titles.map((t) => ({
    id: t.id,
    title: t.title || t.path.split("/").pop() || t.path,
    path: t.path,
    linkCount: linkCount.get(t.id) ?? 0,
  }));

  return { nodes, edges };
}

/** Fetch note titles + backlinks from Tauri and assemble the graph. */
export async function buildGraph(): Promise<Graph> {
  const titles = await listNoteTitles();
  const entries = await Promise.all(
    titles.map(async (t) => [t.id, await getBacklinks(t.id)] as const),
  );
  const backlinksByNoteId = new Map(entries);
  return assembleGraph(titles, backlinksByNoteId);
}
