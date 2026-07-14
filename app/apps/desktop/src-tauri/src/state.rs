//! Shared application state: the currently-open vault, its live index, and the
//! watcher handle. Guarded by a single mutex; commands clone out the pieces
//! they need and release the lock quickly.

use crate::index::Index;
use crate::watcher::VaultWatcher;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct AppState {
    pub inner: Mutex<Inner>,
}

#[derive(Default)]
pub struct Inner {
    pub vault: Option<PathBuf>,
    pub index: Option<Arc<Mutex<Index>>>,
    pub watcher: Option<VaultWatcher>,
}
