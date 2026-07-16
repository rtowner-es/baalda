// A tiny registry for "the note editor that's currently on screen" so code
// outside the Editor component (e.g. the sidebar's global drag-drop handler)
// can drop an embed into the open note at the caret. The Editor sets this when
// it mounts a view and clears it on teardown.

import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

let current: EditorView | null = null;

export function setActiveView(view: EditorView | null): void {
  current = view;
}

/** True when a live, editable note editor is present to receive an embed. */
export function activeNoteEditable(): boolean {
  return current != null && !current.state.readOnly;
}

/**
 * Insert markdown at the caret of the active editor, on its own line. Returns
 * false when there's no editable editor (a preview/HTML view, or a locked note).
 */
export function insertIntoActiveNote(md: string): boolean {
  const view = current;
  if (!view || view.state.readOnly) return false;
  const pos = view.state.selection.main.to;
  const atLineStart = pos === 0 || view.state.doc.sliceString(pos - 1, pos) === "\n";
  const insert = `${atLineStart ? "" : "\n"}${md}\n`;
  view.dispatch({
    changes: { from: pos, insert },
    selection: EditorSelection.cursor(pos + insert.length),
    userEvent: "input.drop",
  });
  view.focus();
  return true;
}
