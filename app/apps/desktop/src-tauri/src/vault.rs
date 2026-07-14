//! Vault path helpers: safe resolution of vault-relative paths (traversal
//! rejection) and the rules for what the note pipeline ignores.

use crate::error::{AppError, AppResult};
use std::path::{Component, Path, PathBuf};

/// Names that are never walked into the note pipeline (spec 02 §2 hard rule).
pub const IGNORED_DIRS: &[&str] = &[".opencontext", ".git"];

/// True if a directory/file name should be skipped by the tree walk & watcher.
pub fn is_ignored_name(name: &str) -> bool {
    name.starts_with('.') || IGNORED_DIRS.contains(&name)
}

/// True if any component of a vault-relative path is an ignored dir/dotfile.
pub fn rel_path_is_ignored(rel: &str) -> bool {
    rel.split('/').any(|seg| !seg.is_empty() && is_ignored_name(seg))
}

/// Resolve a vault-relative path to an absolute path *inside* the vault,
/// rejecting `..` traversal, absolute inputs, and anything that escapes root.
pub fn resolve_in_vault(vault: &Path, rel: &str) -> AppResult<PathBuf> {
    let candidate = Path::new(rel);

    // Reject absolute paths and any parent/prefix components outright.
    for comp in candidate.components() {
        match comp {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => {
                return Err(AppError::new("path traversal ('..') is not allowed"));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(AppError::new("absolute paths are not allowed"));
            }
        }
    }

    let joined = vault.join(candidate);

    // Defense in depth: after lexical normalization the result must still be
    // within the vault root. We normalize without touching the filesystem so
    // this works for paths that don't exist yet (create_note/create_folder).
    let normalized = normalize_lexically(&joined);
    let vault_norm = normalize_lexically(vault);
    if !normalized.starts_with(&vault_norm) {
        return Err(AppError::new("resolved path escapes the vault"));
    }
    Ok(normalized)
}

/// Lexical normalization (collapse `.` / `..`) without filesystem access.
fn normalize_lexically(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Compute a vault-relative, forward-slash path from an absolute path.
pub fn rel_from_abs(vault: &Path, abs: &Path) -> AppResult<String> {
    let vault_norm = normalize_lexically(vault);
    let abs_norm = normalize_lexically(abs);
    let rel = abs_norm
        .strip_prefix(&vault_norm)
        .map_err(|_| AppError::new("path is outside the vault"))?;
    Ok(rel
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect::<Vec<_>>()
        .join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn vault() -> PathBuf {
        PathBuf::from("/tmp/vault")
    }

    #[test]
    fn rejects_parent_traversal() {
        assert!(resolve_in_vault(&vault(), "../secret.md").is_err());
        assert!(resolve_in_vault(&vault(), "notes/../../etc/passwd").is_err());
    }

    #[test]
    fn rejects_absolute_paths() {
        assert!(resolve_in_vault(&vault(), "/etc/passwd").is_err());
    }

    #[test]
    fn accepts_nested_relative_paths() {
        let p = resolve_in_vault(&vault(), "sub/dir/note.md").unwrap();
        assert_eq!(p, PathBuf::from("/tmp/vault/sub/dir/note.md"));
    }

    #[test]
    fn ignores_dotfolders_and_opencontext() {
        assert!(is_ignored_name(".opencontext"));
        assert!(is_ignored_name(".git"));
        assert!(is_ignored_name(".hidden"));
        assert!(!is_ignored_name("Notes"));
        assert!(rel_path_is_ignored(".opencontext/index.sqlite"));
        assert!(rel_path_is_ignored("a/.git/config"));
        assert!(!rel_path_is_ignored("a/b/note.md"));
    }

    #[test]
    fn rel_from_abs_uses_forward_slashes() {
        let rel = rel_from_abs(&vault(), Path::new("/tmp/vault/a/b.md")).unwrap();
        assert_eq!(rel, "a/b.md");
    }
}
