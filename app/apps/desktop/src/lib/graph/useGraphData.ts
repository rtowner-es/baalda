import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { buildGraph, type Graph } from "./buildGraph";
import { onFileChanged } from "../ipc";

/** Delay before rebuilding after a file-changed event, so bursts of edits
 *  (e.g. an AI rewrite touching many notes) collapse into one rebuild. */
const REBUILD_DEBOUNCE_MS = 250;

export interface GraphDataState {
  graph: Graph | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Loads the note link-graph and keeps it live: the Rust watcher re-indexes on
 * every note change and fires `file-changed`, which we debounce and use to
 * silently rebuild so newly-indexed notes appear without a loading flash.
 */
export function useGraphData(): GraphDataState {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Guards against setState after unmount (buildGraph is async).
  const isMountedRef = useRef(true);
  // Holds the pending debounced rebuild so we can coalesce/cancel it.
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Immediate rebuild for the header refresh button; may briefly show loading.
  const refresh = useCallback(() => {
    setLoading(true);
    buildGraph()
      .then((g) => {
        if (!isMountedRef.current) return;
        setGraph(g);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!isMountedRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (isMountedRef.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    isMountedRef.current = true;

    // First load: this is the only time we flip `loading`.
    buildGraph()
      .then((g) => {
        if (!isMountedRef.current) return;
        setGraph(g);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!isMountedRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (isMountedRef.current) setLoading(false);
      });

    // Silent rebuild — never touches `loading`, so the view updates in place.
    const rebuildSilently = () => {
      buildGraph()
        .then((g) => {
          if (!isMountedRef.current) return;
          setGraph(g);
          setError(null);
        })
        .catch((e: unknown) => {
          if (!isMountedRef.current) return;
          setError(e instanceof Error ? e.message : String(e));
        });
    };

    // Effect body can't be async; capture the unlisten fn when it resolves,
    // and tear down immediately if we already unmounted before it did.
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    onFileChanged(() => {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(rebuildSilently, REBUILD_DEBOUNCE_MS);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      isMountedRef.current = false;
      cancelled = true;
      unlisten?.();
      clearTimeout(timerRef.current);
    };
  }, []);

  return { graph, loading, error, refresh };
}
