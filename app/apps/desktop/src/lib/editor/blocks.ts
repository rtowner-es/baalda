// Block-level markdown decorations for the live-preview feel: a left bar on
// blockquotes, a subtle well behind fenced/indented code blocks, and a hairline
// horizontal rule. These are *line* decorations derived from the markdown syntax
// tree — purely visual, they never touch the document or the CRDT binding.

import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

function buildBlockDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  // line-start position -> set of classes to apply to that line
  const lineClasses = new Map<number, Set<string>>();
  const add = (linePos: number, cls: string) => {
    let set = lineClasses.get(linePos);
    if (!set) {
      set = new Set();
      lineClasses.set(linePos, set);
    }
    set.add(cls);
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const startLine = doc.lineAt(node.from).number;
        // node.to often points at the newline after the block; step back so we
        // don't paint the following (blank) line.
        const endLine = doc.lineAt(Math.max(node.from, node.to - 1)).number;

        if (node.name === "Blockquote") {
          for (let n = startLine; n <= endLine; n++) {
            add(doc.line(n).from, "cm-blockquote");
          }
        } else if (node.name === "FencedCode" || node.name === "CodeBlock") {
          for (let n = startLine; n <= endLine; n++) {
            add(doc.line(n).from, "cm-codeblock");
          }
          add(doc.line(startLine).from, "cm-codeblock-open");
          add(doc.line(endLine).from, "cm-codeblock-close");
        } else if (node.name === "HorizontalRule") {
          add(doc.line(startLine).from, "cm-hr");
        }
      },
    });
  }

  const builder = new RangeSetBuilder<Decoration>();
  for (const pos of [...lineClasses.keys()].sort((a, b) => a - b)) {
    const cls = [...lineClasses.get(pos)!].join(" ");
    builder.add(pos, pos, Decoration.line({ class: cls }));
  }
  return builder.finish();
}

/** View plugin that paints blockquote / code-block / hr line decorations. */
export const blockDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildBlockDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) {
        this.decorations = buildBlockDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);
