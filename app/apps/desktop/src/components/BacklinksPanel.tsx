import { useStore } from "../store";

export function BacklinksPanel() {
  const backlinks = useStore((s) => s.backlinks);
  const openNote = useStore((s) => s.openNote);

  // Only markdown notes participate in wikilinks; HTML pages have no backlinks.
  if (!openNote || /\.html?$/i.test(openNote.path)) return null;

  return (
    <div className="backlinks-panel">
      <div className="panel-header">
        Backlinks {backlinks.length > 0 && <span className="count">{backlinks.length}</span>}
      </div>
      {backlinks.length === 0 ? (
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
      )}
    </div>
  );
}
