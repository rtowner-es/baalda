// Smart list / quote behaviour on Enter and Tab — the "it just continues the
// list" feel. All edits are ordinary CodeMirror transactions so the Yjs binding
// syncs them like any keystroke.
//
//   Enter on a list/quote line     → start the next item with the same marker
//                                     (numbered items auto-increment; tasks
//                                     start unchecked).
//   Enter on an *empty* item       → clear the marker and end the list.
//   Tab / Shift-Tab on a list line → indent / outdent by two spaces.
//
// Tab always stays inside the editor (never moves focus): off a list line it
// inserts a soft two-space indent.

import { EditorSelection } from "@codemirror/state";
import { type Command, EditorView, keymap } from "@codemirror/view";

const INDENT = "  ";

// Leading indent, a marker, then the item body. `marker` is a bullet (`-`/`*`/
// `+`), an ordered marker (`1.`/`1)`), or a blockquote `>`; an optional task box
// follows a bullet.
const ITEM_RE =
  /^(\s*)(([-*+])|(\d+)([.)])|(>))(\s+)(\[[ xX]\]\s+)?(.*)$/;

interface ItemLine {
  indent: string;
  /** The full marker text incl. trailing space, ready to prefix the next line. */
  nextMarker: string;
  /** Column where the item body starts (indent + marker + space + task box). */
  bodyStart: number;
  /** Whether the item body is empty (only the marker). */
  empty: boolean;
}

/** Parse a list/quote item out of a line, or return null if it isn't one. */
function parseItem(lineText: string): ItemLine | null {
  const m = ITEM_RE.exec(lineText);
  if (!m) return null;
  const [, indent, , bullet, num, ordSep, quote, gap, task, body] = m;
  let nextMarker: string;
  if (bullet) nextMarker = `${bullet}${gap}${task ? "[ ] " : ""}`;
  else if (num) nextMarker = `${Number(num) + 1}${ordSep}${gap}`;
  else nextMarker = `${quote}${gap}`;
  const bodyStart =
    indent.length +
    (bullet ? 1 : num ? num.length + 1 : 1) +
    gap.length +
    (task ? task.length : 0);
  return { indent, nextMarker, bodyStart, empty: body.length === 0 };
}

/** Enter: continue the list/quote, or clear an empty item to end the list. */
const listEnter: Command = (view) => {
  if (view.state.readOnly) return false;
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) return false; // let a normal split happen over a selection
  const line = state.doc.lineAt(range.head);
  const item = parseItem(line.text);
  if (!item) return false;

  // Empty item → drop the marker and stay on a blank line (ends the list).
  if (item.empty) {
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: item.indent },
      selection: EditorSelection.cursor(line.from + item.indent.length),
      userEvent: "input",
    });
    return true;
  }

  // Continue: newline + same indent + next marker, caret after the marker.
  const insert = `\n${item.indent}${item.nextMarker}`;
  view.dispatch({
    changes: { from: range.head, insert },
    selection: EditorSelection.cursor(range.head + insert.length),
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
};

/** Shift the indent of every line the selection touches by ±one unit. */
function reindent(view: EditorView, outdent: boolean): boolean {
  if (view.state.readOnly) return false;
  const { state } = view;
  const changes = [];
  const seen = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      if (outdent) {
        const strip = /^\s{1,2}/.exec(line.text)?.[0].length ?? 0;
        if (strip) changes.push({ from: line.from, to: line.from + strip });
      } else {
        changes.push({ from: line.from, insert: INDENT });
      }
    }
  }
  if (!changes.length) return false;
  view.dispatch({ changes, userEvent: "input.indent" });
  return true;
}

/** Tab on a list line indents the item; elsewhere inserts a soft indent. */
const listTab: Command = (view) => {
  if (view.state.readOnly) return false;
  const { state } = view;
  const range = state.selection.main;
  const onList = parseItem(state.doc.lineAt(range.head).text) != null;
  if (onList || !range.empty) return reindent(view, false);
  // Plain line, collapsed caret → insert a soft two-space tab.
  view.dispatch(state.replaceSelection(INDENT), { userEvent: "input" });
  return true;
};

const listShiftTab: Command = (view) => reindent(view, true);

export function listKeymap() {
  return keymap.of([
    { key: "Enter", run: listEnter },
    { key: "Tab", run: listTab, preventDefault: true },
    { key: "Shift-Tab", run: listShiftTab, preventDefault: true },
  ]);
}
