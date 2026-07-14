// Inline formatting shortcuts — the muscle-memory keys every markdown editor
// has. Each command wraps/unwraps the selection with markdown markers as an
// idempotent toggle, and works across multiple selections. Changes are plain
// CodeMirror transactions, so the Yjs binding (yCollab) picks them up and syncs
// them exactly like typed text.
//
//   Mod-b        **bold**
//   Mod-i        *italic*
//   Mod-e        `inline code`
//   Mod-Shift-x  ~~strikethrough~~
//   Mod-k        [text](url)  — selection becomes the link text; caret lands
//                in the empty () so you can type/paste the URL immediately.

import { EditorSelection } from "@codemirror/state";
import { type Command, EditorView, keymap } from "@codemirror/view";

/** Toggle a symmetric inline marker (`**`, `*`, `` ` ``, `~~`) on each range. */
function toggleInline(marker: string): Command {
  const len = marker.length;
  return (view: EditorView) => {
    if (view.state.readOnly) return false;
    const tr = view.state.changeByRange((range) => {
      const { from, to } = range;
      const before = view.state.sliceDoc(Math.max(0, from - len), from);
      const after = view.state.sliceDoc(to, to + len);
      const inside = view.state.sliceDoc(from, to);

      // Markers sit just outside the selection → strip them (unwrap).
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: from - len, to: from },
            { from: to, to: to + len },
          ],
          range: EditorSelection.range(from - len, to - len),
        };
      }
      // Selection already brackets itself with the markers → strip them.
      if (
        inside.length >= len * 2 &&
        inside.startsWith(marker) &&
        inside.endsWith(marker)
      ) {
        return {
          changes: [
            { from, to: from + len },
            { from: to - len, to },
          ],
          range: EditorSelection.range(from, to - len * 2),
        };
      }
      // Otherwise wrap. Empty selection → caret lands between the markers.
      return {
        changes: [
          { from, insert: marker },
          { from: to, insert: marker },
        ],
        range: EditorSelection.range(from + len, to + len),
      };
    });
    view.dispatch(tr, { scrollIntoView: true, userEvent: "input.format" });
    return true;
  };
}

/** `[selection](url)` with the caret dropped inside the empty URL parens. */
const insertLink: Command = (view) => {
  if (view.state.readOnly) return false;
  const tr = view.state.changeByRange((range) => {
    const text = view.state.sliceDoc(range.from, range.to);
    const insert = `[${text}]()`;
    // Caret between the parens: after `[text](`.
    const caret = range.from + text.length + 3;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(caret),
    };
  });
  view.dispatch(tr, { scrollIntoView: true, userEvent: "input.format" });
  return true;
};

export function formattingKeymap() {
  return keymap.of([
    { key: "Mod-b", run: toggleInline("**"), preventDefault: true },
    { key: "Mod-i", run: toggleInline("*"), preventDefault: true },
    { key: "Mod-e", run: toggleInline("`"), preventDefault: true },
    { key: "Mod-Shift-x", run: toggleInline("~~"), preventDefault: true },
    { key: "Mod-k", run: insertLink, preventDefault: true },
  ]);
}
