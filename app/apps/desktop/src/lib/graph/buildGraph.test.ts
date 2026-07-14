import { describe, expect, it } from "vitest";
import { assembleGraph } from "./buildGraph";
import type { Backlink, NoteTitle } from "../ipc";

function title(id: string, path: string, titleText: string): NoteTitle {
  return { id, path, title: titleText };
}

function backlink(id: string, path: string, titleText: string, linkText = "link"): Backlink {
  return { id, path, title: titleText, linkText };
}

describe("assembleGraph", () => {
  it("inverts backlinks into source -> target edges", () => {
    // Alpha contains [[Beta]], so Beta's backlinks include Alpha.
    const titles = [title("a", "alpha.md", "Alpha"), title("b", "beta.md", "Beta")];
    const backlinksByNoteId = new Map([
      ["a", []],
      ["b", [backlink("a", "alpha.md", "Alpha")]],
    ]);

    const graph = assembleGraph(titles, backlinksByNoteId);

    expect(graph.edges).toEqual([{ source: "a", target: "b" }]);
  });

  it("computes linkCount as the number of distinct edges touching a node", () => {
    const titles = [
      title("a", "a.md", "A"),
      title("b", "b.md", "B"),
      title("c", "c.md", "C"),
    ];
    // b <- a, c <- a, c <- b
    const backlinksByNoteId = new Map([
      ["a", []],
      ["b", [backlink("a", "a.md", "A")]],
      ["c", [backlink("a", "a.md", "A"), backlink("b", "b.md", "B")]],
    ]);

    const graph = assembleGraph(titles, backlinksByNoteId);

    const counts = Object.fromEntries(graph.nodes.map((n) => [n.id, n.linkCount]));
    expect(counts).toEqual({ a: 2, b: 2, c: 2 });
  });

  it("dedupes repeated wikilinks between the same pair of notes", () => {
    const titles = [title("a", "a.md", "A"), title("b", "b.md", "B")];
    const backlinksByNoteId = new Map([
      ["a", []],
      [
        "b",
        [
          backlink("a", "a.md", "A", "[[Beta]]"),
          backlink("a", "a.md", "A", "[[Beta|alias]]"),
        ],
      ],
    ]);

    const graph = assembleGraph(titles, backlinksByNoteId);

    expect(graph.edges).toHaveLength(1);
    expect(graph.nodes.find((n) => n.id === "a")?.linkCount).toBe(1);
    expect(graph.nodes.find((n) => n.id === "b")?.linkCount).toBe(1);
  });

  it("drops self-loops and backlinks to unknown notes", () => {
    const titles = [title("a", "a.md", "A")];
    const backlinksByNoteId = new Map([
      ["a", [backlink("a", "a.md", "A"), backlink("ghost", "ghost.md", "Ghost")]],
    ]);

    const graph = assembleGraph(titles, backlinksByNoteId);

    expect(graph.edges).toEqual([]);
    expect(graph.nodes[0].linkCount).toBe(0);
  });

  it("falls back to the filename when a note has no title", () => {
    const titles = [title("a", "folder/untitled.md", "")];
    const graph = assembleGraph(titles, new Map());

    expect(graph.nodes[0].title).toBe("untitled.md");
  });

  it("returns an empty graph for an empty vault", () => {
    const graph = assembleGraph([], new Map());
    expect(graph).toEqual({ nodes: [], edges: [] });
  });
});
