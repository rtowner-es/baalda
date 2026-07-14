// CodeMirror 6 wiki-link support:
//  1. `[[` autocomplete sourced from the note-title index.
//  2. Decoration that styles `[[target]]` occurrences as clickable links.
//  3. Click / cmd-click on a link navigates to the target note.
//
// Kept dependency-light and origin-agnostic so Phase 1's Yjs binding can be
// layered on without touching this file.

import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { NoteTitle } from "../ipc";

const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;

export interface WikilinkOptions {
  /** Current note titles for autocomplete (read fresh on each request). */
  getTitles: () => NoteTitle[];
  /** Navigate to a target name (resolve + open, create-on-click if dangling). */
  onNavigate: (target: string) => void;
}

// ---- Autocomplete ---------------------------------------------------------

export function wikilinkCompletions(opts: WikilinkOptions) {
  return (context: CompletionContext): CompletionResult | null => {
    // Match an open `[[` up to the cursor, without a closing `]]` yet.
    const before = context.matchBefore(/\[\[([^\]\n]*)$/);
    if (!before) return null;
    if (before.from === before.to && !context.explicit) return null;

    const typed = before.text.slice(2).toLowerCase();
    const options: Completion[] = opts
      .getTitles()
      .filter((t) => {
        const base = t.path.split("/").pop()?.replace(/\.md$/i, "") ?? "";
        return (
          t.title.toLowerCase().includes(typed) ||
          base.toLowerCase().includes(typed)
        );
      })
      .slice(0, 50)
      .map((t) => {
        const base = t.path.split("/").pop()?.replace(/\.md$/i, "") ?? t.title;
        return {
          label: base,
          detail: t.title !== base ? t.title : undefined,
          // Insert the base name + closing brackets, cursor after `]]`.
          apply: `${base}]]`,
        };
      });

    return {
      from: before.from + 2,
      options,
      filter: false,
    };
  };
}

// ---- Decoration + click navigation ---------------------------------------

const wikilinkMark = Decoration.mark({ class: "cm-wikilink" });

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    let m: RegExpExecArray | null;
    WIKILINK_RE.lastIndex = 0;
    while ((m = WIKILINK_RE.exec(text)) !== null) {
      const start = from + m.index;
      const end = start + m[0].length;
      builder.add(start, end, wikilinkMark);
    }
  }
  return builder.finish();
}

/** Extract the wiki-link target at a document position, if any. */
function targetAtPos(view: EditorView, pos: number): string | null {
  const line = view.state.doc.lineAt(pos);
  const text = line.text;
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    const start = line.from + m.index;
    const end = start + m[0].length;
    if (pos >= start && pos <= end) {
      // Strip alias (`|`) and heading (`#`) → resolution target.
      return m[1].split("|")[0].split("#")[0].trim();
    }
  }
  return null;
}

export function wikilinks(opts: WikilinkOptions) {
  const decorationPlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) {
          this.decorations = buildDecorations(u.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(event, view) {
          const target = event.target as HTMLElement;
          if (!target.classList.contains("cm-wikilink")) return false;
          const pos = view.posAtDOM(target);
          const name = targetAtPos(view, pos);
          if (name) {
            event.preventDefault();
            opts.onNavigate(name);
            return true;
          }
          return false;
        },
      },
    }
  );

  // Autocomplete is registered centrally (see editor/index.ts) so the wiki-link
  // and slash-command sources share one autocompletion config.
  return decorationPlugin;
}
