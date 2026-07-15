// Custom sidebar order for folders and notes. Like item colors, order is a
// local, per-vault preference (Rust always returns folders-first/alphabetical;
// the user's manual arrangement is layered on top here, client-side). Stored in
// localStorage keyed by vault path, then by parent path → ordered child paths.

import type { TreeNode } from "./ipc";

/** parentPath ("" = root) → the child paths under it, in the user's chosen order. */
export type ItemOrder = Record<string, string[]>;

const STORE_PREFIX = "context.itemOrder:";

export function readItemOrder(vaultPath: string | undefined): ItemOrder {
  if (!vaultPath) return {};
  try {
    return JSON.parse(localStorage.getItem(STORE_PREFIX + vaultPath) ?? "{}") as ItemOrder;
  } catch {
    return {};
  }
}

export function writeItemOrder(vaultPath: string, order: ItemOrder): void {
  try {
    localStorage.setItem(STORE_PREFIX + vaultPath, JSON.stringify(order));
  } catch {
    /* quota/unavailable — order is a convenience only */
  }
}

/**
 * Re-sort each folder's children by the saved order. Items with no saved rank
 * keep the incoming order (Rust's folders-first/alphabetical), sorted after the
 * ranked ones — so a freshly-created note lands at the bottom until moved.
 */
export function applyOrder(
  nodes: TreeNode[],
  parentPath: string,
  order: ItemOrder,
): TreeNode[] {
  const seq = order[parentPath];
  let out = nodes;
  if (seq && seq.length) {
    const rank = new Map(seq.map((p, i) => [p, i] as const));
    out = nodes
      .map((n, i) => ({ n, i }))
      .sort((a, b) => {
        const ra = rank.has(a.n.path) ? rank.get(a.n.path)! : Infinity;
        const rb = rank.has(b.n.path) ? rank.get(b.n.path)! : Infinity;
        if (ra !== rb) return ra - rb;
        return a.i - b.i; // ties keep the incoming (Rust) order — stable
      })
      .map((x) => x.n);
  }
  return out.map((n) =>
    n.children ? { ...n, children: applyOrder(n.children, n.path, order) } : n,
  );
}

/** Displayed children (post-order) of `dir` within an already-ordered tree. */
export function childrenAt(orderedRoot: TreeNode[], dir: string): TreeNode[] {
  if (dir === "") return orderedRoot;
  let level = orderedRoot;
  let acc = "";
  for (const seg of dir.split("/")) {
    acc = acc ? `${acc}/${seg}` : seg;
    const node = level.find((n) => n.path === acc);
    if (!node?.children) return [];
    level = node.children;
  }
  return level;
}

/**
 * The new ordered child-path list for a drop into `destDir`.
 *
 * @param siblings  destination's current displayed child paths
 * @param dragOld   dragged items' current paths (present in `siblings` only for
 *                  a same-folder reorder)
 * @param dragNew   dragged items' paths after the move (== dragOld when the
 *                  parent doesn't change)
 * @param index     arborist's drop index within `siblings`
 */
export function computeReorder(
  siblings: string[],
  dragOld: string[],
  dragNew: string[],
  index: number,
): string[] {
  const moving = new Set(dragOld);
  const base = siblings.filter((p) => !moving.has(p));
  // arborist's index counts the pre-move list; map it onto the trimmed list.
  let insertAt = 0;
  for (let i = 0; i < index && i < siblings.length; i++) {
    if (!moving.has(siblings[i])) insertAt++;
  }
  base.splice(insertAt, 0, ...dragNew);
  return base;
}

/**
 * Move an item's whole subtree within the order map: re-prefix its own and its
 * descendants' entries from `from` to `to`, and drop every other reference to
 * `from` (e.g. its former parent's list). The caller sets the destination
 * parent's list separately via {@link computeReorder}.
 */
export function moveSubtreeOrder(order: ItemOrder, from: string, to: string): ItemOrder {
  const inSub = (p: string) => p === from || p.startsWith(from + "/");
  const remap = (p: string) =>
    p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p;
  const out: ItemOrder = {};
  for (const [key, arr] of Object.entries(order)) {
    if (inSub(key)) out[remap(key)] = arr.map(remap);
    else out[key] = arr.filter((p) => p !== from);
  }
  return out;
}

/**
 * Rename an item in place (same parent): re-prefix every matching key and value
 * so the item keeps its rank and its subtree keeps its internal arrangement.
 */
export function renameInOrder(order: ItemOrder, oldPath: string, newPath: string): ItemOrder {
  const remap = (p: string) =>
    p === oldPath
      ? newPath
      : p.startsWith(oldPath + "/")
        ? newPath + p.slice(oldPath.length)
        : p;
  const out: ItemOrder = {};
  for (const [key, arr] of Object.entries(order)) {
    out[remap(key)] = arr.map(remap);
  }
  return out;
}

/**
 * Forget the custom arrangement for one folder's children, so it falls back to
 * Rust's folders-first/alphabetical default. Other folders keep their order.
 */
export function clearOrderAt(order: ItemOrder, parentPath: string): ItemOrder {
  if (!(parentPath in order)) return order;
  const out = { ...order };
  delete out[parentPath];
  return out;
}

/** Drop an item (and its subtree) from the order map after a delete. */
export function removeFromOrder(order: ItemOrder, path: string): ItemOrder {
  const affected = (p: string) => p === path || p.startsWith(path + "/");
  const out: ItemOrder = {};
  for (const [key, arr] of Object.entries(order)) {
    if (affected(key)) continue;
    out[key] = arr.filter((p) => !affected(p));
  }
  return out;
}
