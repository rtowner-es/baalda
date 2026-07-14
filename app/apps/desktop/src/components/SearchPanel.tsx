import { useEffect, useRef, useState } from "react";
import type { SearchResult } from "../lib/ipc";
import * as ipc from "../lib/ipc";
import { useStore } from "../store";

export function SearchPanel() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    if (!query.trim()) {
      setResults([]);
      return;
    }
    timer.current = window.setTimeout(async () => {
      try {
        setResults(await ipc.searchNotes(query));
      } catch (e) {
        console.error("search failed", e);
      }
    }, 180);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [query]);

  return (
    <div className="search-panel">
      <div className="search-field">
        <span className="search-icon" aria-hidden="true">⌕</span>
        <input
          className="search-box"
          placeholder="Search notes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {query.trim() && (
        <ul className="search-results">
          {results.length === 0 && <li className="search-none">No matches</li>}
          {results.map((r) => (
            <li
              key={r.id}
              className="search-result"
              onClick={() => void useStore.getState().openNoteByPath(r.path)}
            >
              <div className="search-title">{r.title || r.path}</div>
              <div
                className="search-snippet"
                // Rust returns a sanitized snippet with <mark> tags only.
                dangerouslySetInnerHTML={{ __html: r.snippet }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
