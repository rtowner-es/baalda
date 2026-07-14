import { useEffect, useMemo, useRef, useState } from "react";
import {
  Tree,
  type CursorProps,
  type NodeApi,
  type NodeRendererProps,
  type TreeApi,
} from "react-arborist";
import type { TreeNode } from "../lib/ipc";
import * as ipc from "../lib/ipc";
import { ITEM_COLORS, itemColorValue } from "../lib/appearance";
import {
  applyOrder,
  childrenAt,
  clearOrderAt,
  computeReorder,
  moveSubtreeOrder,
  removeFromOrder,
  renameInOrder,
} from "../lib/ordering";
import { LOCK_TITLES, lockScopesByPath, type LockScope } from "../lib/locks";
import { useStore } from "../store";
import { shareResourceId } from "../lib/api";
import { syncManager } from "../lib/sync/docSession";
import { ShareDialog, type ShareTarget } from "./ShareDialog";

interface Dimensions {
  width: number;
  height: number;
}

function useDimensions(): [React.RefObject<HTMLDivElement | null>, Dimensions] {
  const ref = useRef<HTMLDivElement>(null);
  const [dim, setDim] = useState<Dimensions>({ width: 240, height: 400 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setDim({ width: r.width, height: r.height });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, dim];
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

interface MenuState {
  x: number;
  y: number;
  node: NodeApi<TreeNode> | null;
}

/* Toolbar glyphs — file+ / folder+ mirror the tree's own icons so the "create"
   actions read as "a new one of these"; the chevron pairs fold in / fan out. */
const ICON_NEW_NOTE = (
  <TreeSvg>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M15 2v5h5" />
    <path d="M12 11v6M9 14h6" />
  </TreeSvg>
);
const ICON_NEW_FOLDER = (
  <TreeSvg>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    <path d="M12 11v6M9 14h6" />
  </TreeSvg>
);
const ICON_COLLAPSE_ALL = (
  <TreeSvg>
    <path d="m7 4 5 5 5-5" />
    <path d="m7 20 5-5 5 5" />
  </TreeSvg>
);
const ICON_EXPAND_ALL = (
  <TreeSvg>
    <path d="m7 9 5-5 5 5" />
    <path d="m7 15 5 5 5-5" />
  </TreeSvg>
);
/* Select-mode toggle — a ticked checkbox reads as "pick items". */
const ICON_SELECT = (
  <TreeSvg>
    <rect x="3" y="3" width="18" height="18" rx="2.5" />
    <path d="m8 12 3 3 5-6" />
  </TreeSvg>
);
const ICON_CHECK = (
  <TreeSvg>
    <path d="m5 12 5 5 9-11" />
  </TreeSvg>
);

export function FileTree() {
  const tree = useStore((s) => s.tree);
  const openNote = useStore((s) => s.openNote);
  const syncEnabled = useStore((s) => s.syncEnabled);
  const locks = useStore((s) => s.locks);
  const session = useStore((s) => s.session);
  const members = useStore((s) => s.members);
  const itemColors = useStore((s) => s.itemColors);
  const itemOrder = useStore((s) => s.itemOrder);
  const [containerRef, dim] = useDimensions();
  const treeRef = useRef<TreeApi<TreeNode> | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  // Multi-select: a mode toggle + the set of picked paths. Kept local to the
  // tree (react-arborist's own selection is left alone) so the bulk-action bar
  // only exists while selecting and doesn't crowd the normal browsing UI.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  // onActivate is captured by arborist; read the live mode through a ref.
  const selectModeRef = useRef(false);
  selectModeRef.current = selectMode;

  // Resolve lock rows (server resource ids) to tree paths for the badges.
  const lockByPath = useMemo(
    () => (syncEnabled ? lockScopesByPath(tree, locks, session?.user.id) : new Map()),
    [tree, locks, syncEnabled, session?.user.id],
  );

  // Owners/admins can lock and unlock straight from the row menu.
  const myRole = members.find((m) => m.userId === session?.user.id)?.role;
  const canManage = myRole === "owner" || myRole === "admin";

  /** Resolve a path (+ kind) to a server share resource, if the vault is synced. */
  function shareTargetForPath(
    path: string,
    isDir: boolean,
    name: string,
  ): ShareTarget | null {
    if (!syncEnabled) return null;
    if (isDir) {
      const id = syncManager.registry.getFolderId(path);
      return id ? { resourceType: "folder", resourceId: id, title: name } : null;
    }
    const mapping = syncManager.registry.getMapping(path);
    return mapping
      ? { resourceType: "file", resourceId: mapping.docId, title: name }
      : null;
  }

  /** Resolve a tree node to a server share resource, if the vault is synced. */
  function shareTargetFor(node: NodeApi<TreeNode>): ShareTarget | null {
    return shareTargetForPath(node.data.path, node.data.isDir, node.data.name);
  }

  // Rust returns folders-first/alphabetical; layer the user's manual
  // arrangement on top so drag-to-reorder sticks.
  const data = useMemo<TreeNode[]>(
    () => applyOrder(tree?.children ?? [], "", itemOrder),
    [tree, itemOrder],
  );

  // Flatten the (arranged) tree so bulk actions can resolve any path — even a
  // collapsed one — to its node, and so "Select all" knows every path.
  const nodeByPath = useMemo(() => {
    const m = new Map<string, TreeNode>();
    const walk = (ns: TreeNode[]) => {
      for (const n of ns) {
        m.set(n.path, n);
        if (n.children) walk(n.children);
      }
    };
    walk(data);
    return m;
  }, [data]);

  const allSelected = nodeByPath.size > 0 && selected.size === nodeByPath.size;

  function toggleSelect(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(nodeByPath.keys()));
  }

  function exitSelect() {
    setSelectMode(false);
    setSelected(new Set());
    setConfirmDelete(false);
  }

  // A destructive delete arms a one-tap confirm; any change to the picks (or
  // leaving the count) disarms it so a stale "Delete N?" can't fire.
  useEffect(() => {
    setConfirmDelete(false);
  }, [selected]);

  async function bulkDelete() {
    // Deepest paths first so a folder's children are gone before the folder.
    const paths = [...selected].sort(
      (a, b) => b.split("/").length - a.split("/").length,
    );
    const store = useStore.getState();
    let order = store.itemOrder;
    for (const p of paths) {
      try {
        await ipc.deletePath(p);
        order = removeFromOrder(order, p);
        if (openNote && (openNote.path === p || openNote.path.startsWith(p + "/"))) {
          store.closeNote();
        }
      } catch (e) {
        console.error("bulk delete failed", p, e);
      }
    }
    store.setItemOrder(order);
    await refreshAll();
    exitSelect();
  }

  async function bulkLock() {
    const store = useStore.getState();
    for (const p of selected) {
      const n = nodeByPath.get(p);
      if (!n) continue;
      const target = shareTargetForPath(p, n.isDir, n.name);
      if (!target) continue;
      // Skip anything already locked directly (avoids a duplicate share row).
      if (locks.some((l) => shareResourceId(l) === target.resourceId)) continue;
      try {
        await store.createLock(target.resourceType, target.resourceId, null);
      } catch (e) {
        console.error("bulk lock failed", p, e);
      }
    }
    exitSelect();
  }

  async function bulkUnlock() {
    const store = useStore.getState();
    for (const p of selected) {
      const n = nodeByPath.get(p);
      if (!n) continue;
      const target = shareTargetForPath(p, n.isDir, n.name);
      if (!target) continue;
      const lock = locks.find((l) => shareResourceId(l) === target.resourceId);
      if (!lock) continue;
      try {
        await store.removeLock(lock.id);
      } catch (e) {
        console.error("bulk unlock failed", p, e);
      }
    }
    exitSelect();
  }

  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  async function refreshAll() {
    await useStore.getState().refreshTree();
    await useStore.getState().refreshTitles();
  }

  const onActivate = (node: NodeApi<TreeNode>) => {
    // In select mode a file click picks it (folders expand via the row / pick
    // via their checkbox) instead of opening the note.
    if (selectModeRef.current) {
      if (!node.data.isDir) toggleSelect(node.data.path);
      return;
    }
    if (!node.data.isDir) {
      void useStore.getState().openNoteByPath(node.data.path);
    }
  };

  const onRename = async ({ id, name, node }: { id: string; name: string; node: NodeApi<TreeNode> }) => {
    const oldPath = node.data.path;
    const dir = parentDir(oldPath);
    let newName = name.trim();
    if (!newName || newName === basename(oldPath)) return;
    // Re-attach the file's real extension (the rename input hides it).
    if (!node.data.isDir) {
      const ext = isHtmlPath(oldPath)
        ? (oldPath.match(/\.html?$/i)?.[0] ?? ".html")
        : ".md";
      if (!newName.toLowerCase().endsWith(ext.toLowerCase())) newName = `${newName}${ext}`;
    }
    const newPath = dir ? `${dir}/${newName}` : newName;
    if (newPath === oldPath) return;
    try {
      await ipc.renamePath(oldPath, newPath);
      // Keep the item's rank (and its subtree's arrangement) across the rename.
      const store = useStore.getState();
      store.setItemOrder(renameInOrder(store.itemOrder, oldPath, newPath));
      if (openNote && (openNote.path === oldPath || openNote.path.startsWith(oldPath + "/"))) {
        const updated = openNote.path.replace(oldPath, newPath);
        await useStore.getState().openNoteByPath(updated);
      }
      await refreshAll();
    } catch (e) {
      console.error("rename failed", e);
    }
    void id;
  };

  const onMove = async ({
    dragIds,
    parentNode,
    index,
  }: {
    dragIds: string[];
    parentNode: NodeApi<TreeNode> | null;
    index: number;
  }) => {
    const destDir = parentNode ? parentNode.data.path : "";
    // dragIds are node ids === current paths. Their paths after the drop only
    // change when the parent folder changes (a reorder keeps the same path).
    const from = dragIds;
    const to = from.map((p) => {
      const dest = destDir ? `${destDir}/${basename(p)}` : basename(p);
      return dest;
    });

    // 1) Persist the arrangement first so a same-folder reorder feels instant
    //    (no disk change, no round-trip). Cross-folder drops snap into place
    //    after the tree refresh below re-materializes the moved paths.
    const store = useStore.getState();
    const siblings = childrenAt(data, destDir).map((n) => n.path);
    let order = store.itemOrder;
    for (let i = 0; i < from.length; i++) {
      if (from[i] !== to[i]) order = moveSubtreeOrder(order, from[i], to[i]);
    }
    order = { ...order, [destDir]: computeReorder(siblings, from, to, index) };
    store.setItemOrder(order);

    // 2) Apply cross-folder moves on disk (a pure reorder has from === to).
    let movedOnDisk = false;
    for (let i = 0; i < from.length; i++) {
      if (from[i] === to[i]) continue;
      try {
        await ipc.renamePath(from[i], to[i]);
        movedOnDisk = true;
        if (openNote && (openNote.path === from[i] || openNote.path.startsWith(from[i] + "/"))) {
          await useStore.getState().openNoteByPath(openNote.path.replace(from[i], to[i]));
        }
      } catch (e) {
        console.error("move failed", e);
      }
    }
    if (movedOnDisk) await refreshAll();
  };

  async function createUniqueNote(dir: string) {
    let name = "Untitled";
    for (let i = 0; i < 50; i++) {
      const candidate = i === 0 ? name : `${name} ${i}`;
      try {
        const path = await ipc.createNote(dir, candidate);
        await refreshAll();
        await useStore.getState().openNoteByPath(path);
        return;
      } catch {
        // name taken → try next
      }
    }
  }

  // Put a freshly created node straight into rename mode — same instant-rename
  // affordance a new note gets by opening in the editor. refreshAll() only
  // schedules the tree re-render, so poll a few frames until react-arborist has
  // the new row in its store, then reveal + select + edit it.
  function beginRename(path: string, tries = 0) {
    const tree = treeRef.current;
    if (tree?.get(path)) {
      tree.openParents(path);
      tree.select(path);
      void tree.scrollTo(path);
      void tree.edit(path);
      return;
    }
    if (tries < 30) requestAnimationFrame(() => beginRename(path, tries + 1));
  }

  async function createUniqueFolder(dir: string) {
    let name = "New Folder";
    for (let i = 0; i < 50; i++) {
      const candidate = i === 0 ? name : `${name} ${i}`;
      try {
        const path = await ipc.createFolder(dir, candidate);
        await refreshAll();
        beginRename(path);
        return;
      } catch {
        // taken → next
      }
    }
  }

  async function handleDelete(node: NodeApi<TreeNode>) {
    try {
      await ipc.deletePath(node.data.path);
      const store = useStore.getState();
      store.setItemOrder(removeFromOrder(store.itemOrder, node.data.path));
      if (openNote && (openNote.path === node.data.path || openNote.path.startsWith(node.data.path + "/"))) {
        useStore.getState().closeNote();
      }
      await refreshAll();
    } catch (e) {
      console.error("delete failed", e);
    }
  }

  const menuDir = menu?.node
    ? menu.node.data.isDir
      ? menu.node.data.path
      : parentDir(menu.node.data.path)
    : "";

  // The lock applied DIRECTLY to the menu's node (not inherited), so the menu
  // can offer Unlock with the right share id.
  const menuTarget = menu?.node ? shareTargetFor(menu.node) : null;
  const menuLock = menuTarget
    ? (locks.find((l) => shareResourceId(l) === menuTarget.resourceId) ?? null)
    : null;

  async function lockFromMenu(target: ShareTarget) {
    try {
      await useStore.getState().createLock(target.resourceType, target.resourceId, null);
    } catch (e) {
      console.error("lock failed", e);
    }
  }

  async function unlockFromMenu(shareId: string) {
    try {
      await useStore.getState().removeLock(shareId);
    } catch (e) {
      console.error("unlock failed", e);
    }
  }

  return (
    <div className="filetree" ref={containerRef}>
      <div className="filetree-head">
        <span className="section-label">Notes</span>
        <div className="filetree-actions">
          <button
            className="tree-tool"
            title="New note"
            aria-label="New note"
            onClick={() => createUniqueNote("")}
          >
            {ICON_NEW_NOTE}
          </button>
          <button
            className="tree-tool"
            title="New folder"
            aria-label="New folder"
            onClick={() => createUniqueFolder("")}
          >
            {ICON_NEW_FOLDER}
          </button>
          <span className="tool-divider" aria-hidden="true" />
          <button
            className="tree-tool"
            title="Collapse all folders"
            aria-label="Collapse all folders"
            onClick={() => treeRef.current?.closeAll()}
          >
            {ICON_COLLAPSE_ALL}
          </button>
          <button
            className="tree-tool"
            title="Expand all folders"
            aria-label="Expand all folders"
            onClick={() => treeRef.current?.openAll()}
          >
            {ICON_EXPAND_ALL}
          </button>
          <span className="tool-divider" aria-hidden="true" />
          <button
            className={`tree-tool${selectMode ? " on" : ""}`}
            title={selectMode ? "Exit selection" : "Select items"}
            aria-label={selectMode ? "Exit selection" : "Select items"}
            aria-pressed={selectMode}
            onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
          >
            {ICON_SELECT}
          </button>
        </div>
      </div>
      {selectMode && (
        <div className="filetree-selectbar">
          <button
            className={`selbar-check${allSelected ? " on" : ""}`}
            title={allSelected ? "Clear selection" : "Select all"}
            aria-label={allSelected ? "Clear selection" : "Select all"}
            aria-checked={allSelected}
            role="checkbox"
            onClick={toggleSelectAll}
          >
            {allSelected && ICON_CHECK}
          </button>
          <span className="selbar-count">
            {selected.size} selected
          </span>
          <div className="selbar-actions">
            {canManage && syncEnabled && (
              <>
                <button
                  className="selbar-btn"
                  disabled={selected.size === 0}
                  onClick={() => void bulkLock()}
                  title="Lock the selected items for everyone"
                >
                  Lock
                </button>
                <button
                  className="selbar-btn"
                  disabled={selected.size === 0}
                  onClick={() => void bulkUnlock()}
                  title="Unlock the selected items"
                >
                  Unlock
                </button>
              </>
            )}
            {confirmDelete ? (
              <button
                className="selbar-btn danger"
                onClick={() => void bulkDelete()}
              >
                Delete {selected.size}?
              </button>
            ) : (
              <button
                className="selbar-btn danger"
                disabled={selected.size === 0}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </button>
            )}
          </div>
        </div>
      )}
      {data.length === 0 ? (
        <div className="filetree-empty">No notes yet</div>
      ) : (
        <Tree<TreeNode>
          ref={treeRef}
          data={data}
          idAccessor="id"
          openByDefault={false}
          width={dim.width}
          height={dim.height - 34 - (selectMode ? 36 : 0)}
          indent={14}
          rowHeight={32}
          onActivate={onActivate}
          onRename={onRename}
          onMove={onMove}
          renderCursor={DropCursor}
          rowClassName="tree-rowwrap"
        >
          {(props) => (
            <Node
              {...props}
              selectedPath={openNote?.path ?? null}
              lock={lockByPath.get(props.node.data.path) ?? null}
              color={itemColors[props.node.data.path]}
              onMenu={(x, y, node) => setMenu({ x, y, node })}
              selectMode={selectMode}
              checked={selected.has(props.node.data.path)}
              onToggleCheck={toggleSelect}
            />
          )}
        </Tree>
      )}

      {menu && (
        <ul className="context-menu" style={{ left: menu.x, top: menu.y }}>
          <li onClick={() => createUniqueNote(menuDir)}>New note</li>
          <li onClick={() => createUniqueFolder(menuDir)}>New folder</li>
          {menu.node && <li onClick={() => menu.node!.edit()}>Rename</li>}
          {(itemOrder[menuDir]?.length ?? 0) > 0 && (
            <li
              title={
                menu.node?.data.isDir
                  ? "Sort this folder's contents alphabetically"
                  : "Sort this folder alphabetically"
              }
              onClick={() =>
                useStore.getState().setItemOrder(clearOrderAt(itemOrder, menuDir))
              }
            >
              Reset order (A–Z)
            </li>
          )}
          {menu.node && menuTarget && (
            <li onClick={() => setShareTarget(menuTarget)}>Share…</li>
          )}
          {menu.node && menuTarget && canManage && (
            menuLock ? (
              <li onClick={() => void unlockFromMenu(menuLock.id)}>Unlock</li>
            ) : (
              <li
                title="Read-only for everyone — changes won't sync"
                onClick={() => void lockFromMenu(menuTarget)}
              >
                Lock for everyone
              </li>
            )
          )}
          {menu.node && (
            <li className="menu-swatches" onClick={(e) => e.stopPropagation()}>
              <span
                className="swatch clear"
                title="Default color"
                onClick={() => {
                  useStore.getState().setItemColor(menu.node!.data.path, null);
                  setMenu(null);
                }}
              />
              {ITEM_COLORS.map((c) => (
                <span
                  key={c.id}
                  className={`swatch${itemColors[menu.node!.data.path] === c.id ? " on" : ""}`}
                  style={{ backgroundColor: c.value }}
                  title={c.label}
                  onClick={() => {
                    useStore.getState().setItemColor(menu.node!.data.path, c.id);
                    setMenu(null);
                  }}
                />
              ))}
            </li>
          )}
          {menu.node && (
            <li className="danger" onClick={() => handleDelete(menu.node!)}>
              Delete
            </li>
          )}
        </ul>
      )}

      {shareTarget && (
        <ShareDialog target={shareTarget} onClose={() => setShareTarget(null)} />
      )}
    </div>
  );
}

interface NodeExtra {
  selectedPath: string | null;
  lock: LockScope | null;
  /** Item color id (vault-local preference) — tints the type glyph. */
  color: string | undefined;
  onMenu: (x: number, y: number, node: NodeApi<TreeNode>) => void;
  /** Multi-select: when on, rows show a checkbox and hide per-row actions. */
  selectMode: boolean;
  checked: boolean;
  onToggleCheck: (path: string) => void;
}

function TreeSvg({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const ICON_FOLDER = (
  <TreeSvg>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </TreeSvg>
);
const ICON_FOLDER_OPEN = (
  <TreeSvg>
    <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
  </TreeSvg>
);
const ICON_FILE = (
  <TreeSvg>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M15 2v5h5" />
    <path d="M9 13h6M9 17h4" />
  </TreeSvg>
);
/* HTML pages render in-app; the code glyph tells them apart from notes. */
const ICON_HTML = (
  <TreeSvg>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M15 2v5h5" />
    <path d="m10 12-2 2.5 2 2.5M14 12l2 2.5-2 2.5" />
  </TreeSvg>
);

/** Note titles hide the .md/.html extension — it's a notes list, not a file manager. */
function displayName(name: string, isDir: boolean): string {
  return isDir ? name : name.replace(/\.(md|html?)$/i, "");
}

function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path);
}

const ICON_LOCK = (
  <TreeSvg>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </TreeSvg>
);

function Node({
  node,
  style,
  dragHandle,
  selectedPath,
  lock,
  color,
  onMenu,
  selectMode,
  checked,
  onToggleCheck,
}: NodeRendererProps<TreeNode> & NodeExtra) {
  const isDir = node.data.isDir;
  const isEmpty = isDir && (node.data.children?.length ?? 0) === 0;
  const isSelected = !isDir && node.data.path === selectedPath;
  const colorValue = itemColorValue(color);
  // Compose arborist's per-level indent with the row's base inset so every
  // glyph on a level shares one left edge (no chevron column to misalign).
  // 20 = 12 base + 8 compensating the tree's full-bleed negative margin.
  const indent = typeof style.paddingLeft === "number" ? style.paddingLeft : 0;
  return (
    <div
      ref={dragHandle}
      style={{ ...style, paddingLeft: indent + 20 }}
      className={`tree-row${isSelected ? " selected" : ""}${isDir ? " is-dir" : ""}${
        node.willReceiveDrop ? " drop-target" : ""
      }${node.isDragging ? " dragging" : ""}${checked ? " checked" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(e.clientX, e.clientY, node);
      }}
      onMouseDown={(e) => {
        // The second press of a double-click otherwise makes WebKit start a
        // word/range selection (the stray blue bands between rows). Suppress it
        // only for the multi-click; the first press still drives click + drag.
        if (e.detail > 1) e.preventDefault();
      }}
      onClick={() => {
        if (isDir) node.toggle();
      }}
      onDoubleClick={(e) => {
        // Double-click a row to rename it in place (Finder-style). Stop the
        // event so a folder's toggle doesn't fight the rename that follows.
        // Disabled while selecting — a double-click there is just two picks.
        if (selectMode) return;
        e.stopPropagation();
        node.edit();
      }}
    >
      {selectMode && (
        <span
          className={`tree-check${checked ? " on" : ""}`}
          role="checkbox"
          aria-checked={checked}
          aria-label={checked ? "Deselect" : "Select"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleCheck(node.data.path);
          }}
        >
          {checked && ICON_CHECK}
        </span>
      )}
      <span
        className={`tree-glyph${isEmpty ? " is-empty" : ""}${colorValue ? " colored" : ""}`}
        style={colorValue ? { color: colorValue } : undefined}
        aria-hidden="true"
      >
        {isDir
          ? node.isOpen && !isEmpty
            ? ICON_FOLDER_OPEN
            : ICON_FOLDER
          : isHtmlPath(node.data.path)
            ? ICON_HTML
            : ICON_FILE}
      </span>
      {node.isEditing ? (
        <input
          className="tree-rename-input"
          autoFocus
          defaultValue={displayName(node.data.name, isDir)}
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          // Clicking away commits the rename (Finder-style) rather than
          // discarding it. Guard on isEditing so the blur that fires when
          // Enter/Escape unmounts the input doesn't submit a second time
          // (or override an Escape-cancel).
          onBlur={(e) => {
            if (node.isEditing) node.submit(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") node.reset();
            if (e.key === "Enter") node.submit(e.currentTarget.value);
          }}
        />
      ) : (
        <>
          <span className="tree-label">{displayName(node.data.name, isDir)}</span>
          {isEmpty && !lock && <span className="tree-hint">empty</span>}
          {lock && (
            <span
              className={`tree-lock ${lock}`}
              title={LOCK_TITLES[lock]}
              aria-label={LOCK_TITLES[lock]}
            >
              {ICON_LOCK}
            </span>
          )}
          {!selectMode && (
          <button
            className="tree-more"
            title="More actions"
            aria-label={`Actions for ${displayName(node.data.name, isDir)}`}
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              onMenu(r.left, r.bottom + 4, node);
            }}
          >
            <TreeSvg>
              <circle cx="5" cy="12" r="2.1" />
              <circle cx="12" cy="12" r="2.1" />
              <circle cx="19" cy="12" r="2.1" />
            </TreeSvg>
          </button>
          )}
        </>
      )}
    </div>
  );
}

/** Drag-and-drop insertion line, in the system accent instead of arborist blue. */
function DropCursor({ top, left }: CursorProps) {
  return <div className="drop-cursor" style={{ top: top - 1, left: left + 16 }} />;
}
