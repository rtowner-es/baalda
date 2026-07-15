//! Recursive vault tree walk → nested JSON for the react-arborist sidebar.

use crate::error::AppResult;
use crate::vault::is_ignored_name;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    /// react-arborist needs a stable string id; we use the vault-relative path.
    pub id: String,
    pub name: String,
    /// Vault-relative, forward-slash path ("" for the root).
    pub path: String,
    pub is_dir: bool,
    /// Present (possibly empty) for directories; None for files (arborist leaf).
    pub children: Option<Vec<TreeNode>>,
}

/// Walk the vault into a nested tree. Skips dotfolders, `.git`, `.context/`,
/// and non-markdown files (folders are always kept so the user can organize).
pub fn list_tree(vault: &Path) -> AppResult<TreeNode> {
    let name = vault
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("vault")
        .to_string();
    let children = walk_dir(vault, "")?;
    Ok(TreeNode {
        id: "".to_string(),
        name,
        path: "".to_string(),
        is_dir: true,
        children: Some(children),
    })
}

fn walk_dir(dir: &Path, rel_prefix: &str) -> AppResult<Vec<TreeNode>> {
    let mut dirs: Vec<TreeNode> = Vec::new();
    let mut files: Vec<TreeNode> = Vec::new();

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(Vec::new()), // unreadable dir → empty, don't fail the whole tree
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_name(&name) {
            continue;
        }
        let rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{rel_prefix}/{name}")
        };
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };

        if file_type.is_dir() {
            let children = walk_dir(&entry.path(), &rel)?;
            dirs.push(TreeNode {
                id: rel.clone(),
                name,
                path: rel,
                is_dir: true,
                children: Some(children),
            });
        } else if file_type.is_file() {
            // Only surface markdown notes and HTML pages (rendered in-app).
            let lower = name.to_lowercase();
            if !(lower.ends_with(".md") || lower.ends_with(".html") || lower.ends_with(".htm")) {
                continue;
            }
            files.push(TreeNode {
                id: rel.clone(),
                name,
                path: rel,
                is_dir: false,
                children: None,
            });
        }
    }

    // Folders first, then files; each alphabetically (case-insensitive).
    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    dirs.extend(files);
    Ok(dirs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn walk_skips_context_dirs_and_dotfolders() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join(".context")).unwrap();
        fs::write(root.join(".context/index.sqlite"), b"x").unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), b"x").unwrap();
        fs::create_dir_all(root.join("Notes/Sub")).unwrap();
        fs::write(root.join("Notes/a.md"), b"# A").unwrap();
        fs::write(root.join("Notes/Sub/b.md"), b"# B").unwrap();
        fs::write(root.join("ignored.txt"), b"nope").unwrap();

        let tree = list_tree(root).unwrap();
        let children = tree.children.unwrap();
        // Only "Notes" dir should appear (not .context, .git, or ignored.txt).
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].name, "Notes");

        let notes = children[0].children.as_ref().unwrap();
        // "Sub" dir + "a.md" (the .txt is filtered).
        let names: Vec<&str> = notes.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["Sub", "a.md"]);
    }
}
