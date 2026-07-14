//! Debounced filesystem watcher (spec 01 §3). Raw `notify` events are funneled
//! into a background thread that drains a dirty-set after ~150ms of quiet, then
//! incrementally re-indexes each changed path and emits `file-changed` to the UI.
//!
//! `.context/` and dotfolders are ignored so the app's own state dir never
//! feeds the note pipeline (spec 02 §2 hard rule).

use crate::index::Index;
use crate::vault::{rel_from_abs, rel_path_is_ignored};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const DEBOUNCE: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChanged {
    /// Vault-relative path of the changed item.
    pub path: String,
    /// "modified" | "removed" | "tree" (folder/structure change).
    pub kind: String,
}

/// Owns the live watcher. Dropping it stops watching and lets the drain thread
/// exit (its channel disconnects).
pub struct VaultWatcher {
    _watcher: RecommendedWatcher,
}

/// Start watching `vault`. Returns a handle that must be kept alive.
pub fn start(
    vault: PathBuf,
    index: Arc<Mutex<Index>>,
    app: AppHandle,
) -> crate::error::AppResult<VaultWatcher> {
    let (tx, rx) = mpsc::channel::<Vec<PathBuf>>();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            // Forward the event's paths; the drain thread decides what to do.
            let _ = tx.send(event.paths);
        }
    })?;
    watcher.watch(&vault, RecursiveMode::Recursive)?;

    // Drain thread: collect until quiet, then process the dirty set.
    std::thread::spawn(move || {
        let mut dirty: HashSet<PathBuf> = HashSet::new();
        loop {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(paths) => {
                    for p in paths {
                        dirty.insert(p);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if !dirty.is_empty() {
                        let batch = std::mem::take(&mut dirty);
                        process_batch(&vault, &index, &app, batch);
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    Ok(VaultWatcher { _watcher: watcher })
}

fn process_batch(
    vault: &Path,
    index: &Arc<Mutex<Index>>,
    app: &AppHandle,
    batch: HashSet<PathBuf>,
) {
    for abs in batch {
        let rel = match rel_from_abs(vault, &abs) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if rel.is_empty() || rel_path_is_ignored(&rel) {
            continue;
        }

        let is_md = rel.to_lowercase().ends_with(".md");
        let exists = abs.exists();

        let kind = if is_md {
            let guard = index.lock().unwrap();
            if exists && abs.is_file() {
                let _ = guard.index_note(vault, &abs);
                "modified"
            } else {
                let _ = guard.remove_note(vault, &abs);
                "removed"
            }
        } else {
            // Directory or non-markdown file changed → structural refresh.
            // If it was a folder deletion, prune its notes from the index.
            if !exists {
                let guard = index.lock().unwrap();
                let _ = guard.remove_note(vault, &abs);
            }
            "tree"
        };

        let _ = app.emit(
            "file-changed",
            FileChanged {
                path: rel,
                kind: kind.to_string(),
            },
        );
    }
}
