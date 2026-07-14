import { useState } from "react";
import { useStore } from "../store";

export function BacklinksPanel() {
  const backlinks = useStore((s) => s.backlinks);
  const openNote = useStore((s) => s.openNote);
  const [open, setOpen] = useState(false);

  // Only markdown notes participate in wikilinks; HTML pages have no backlinks.
  if (!openNote || /\.html?$/i.test(openNote.path)) return null;

  return (
    <div className={`backlinks-panel${open ? "" : " collapsed"}`}>
      <button
        type="button"
        className="panel-header"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`panel-chevron${open ? " open" : ""}`} aria-hidden>
          ›
        </span>
        Backlinks {backlinks.length > 0 && <span className="count">{backlinks.length}</span>}
      </button>
      {open &&
        (backlinks.length === 0 ? (
          <div className="backlinks-empty">No backlinks</div>
        ) : (
          <ul className="backlinks-list">
            {backlinks.map((b) => (
              <li
                key={b.id}
                className="backlink"
                onClick={() => void useStore.getState().openNoteByPath(b.path)}
              >
                <div className="backlink-title">{b.title || b.path}</div>
                {b.linkText && <div className="backlink-text">{b.linkText}</div>}
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
