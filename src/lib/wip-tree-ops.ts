// ---------------------------------------------------------------------------
// wip-tree-ops.ts — structural edits on a BOM WIP tree (roots[wi] + path).
//
// Owner 2026-10-06: in the product BOM editor a WIP chain is usually LINEAR
// (L2 → L3 → L4 → … each with ONE child). Two things broke there:
//   • Delete on a middle level (e.g. L4) wiped its whole subtree (L5–L7) —
//     the owner only wants that one level gone, the levels below move up.
//   • ↑/↓ only swapped SIBLINGS, and a linear chain has none, so the buttons
//     did nothing. ↑/↓ now fall back to swapping LEVELS with the parent / the
//     child when there is no sibling in that direction.
//
// Pure functions, no React — the dialog calls them inside setState and uses
// the returned location to keep the right pane on the moved node.
// ---------------------------------------------------------------------------

export type WipTreeNode<T> = T & { children?: WipTreeNode<T>[] };

export type WipLocation = { wi: number; path: number[] };

function nodeAt<T>(roots: WipTreeNode<T>[], wi: number, path: number[]): WipTreeNode<T> | undefined {
  let node: WipTreeNode<T> | undefined = roots[wi];
  for (const i of path) node = node?.children?.[i];
  return node;
}

/** Replace the node at (wi, path) via `fn`; every ancestor is copied. */
function updateAt<T>(
  roots: WipTreeNode<T>[],
  wi: number,
  path: number[],
  fn: (n: WipTreeNode<T>) => WipTreeNode<T>,
): WipTreeNode<T>[] {
  const rec = (n: WipTreeNode<T>, rest: number[]): WipTreeNode<T> => {
    if (rest.length === 0) return fn(n);
    const [head, ...tail] = rest;
    return { ...n, children: (n.children ?? []).map((c, i) => (i === head ? rec(c, tail) : c)) };
  };
  return roots.map((r, i) => (i === wi ? rec(r, path) : r));
}

/** Replace the sibling LIST that contains (wi, path) — the roots array for a
 *  root, otherwise the parent's children[]. */
function updateSiblings<T>(
  roots: WipTreeNode<T>[],
  wi: number,
  path: number[],
  fn: (list: WipTreeNode<T>[]) => WipTreeNode<T>[],
): WipTreeNode<T>[] {
  if (path.length === 0) return fn(roots);
  return updateAt(roots, wi, path.slice(0, -1), (p) => ({ ...p, children: fn(p.children ?? []) }));
}

/**
 * Delete ONLY the node at (wi, path); its children take its place in the
 * parent's list (or among the roots), in order. Never cascades.
 */
export function removeWipLevel<T>(roots: WipTreeNode<T>[], wi: number, path: number[]): WipTreeNode<T>[] {
  const target = nodeAt(roots, wi, path);
  if (!target) return roots;
  const idx = path.length === 0 ? wi : path[path.length - 1];
  return updateSiblings(roots, wi, path, (list) => {
    const next = [...list];
    next.splice(idx, 1, ...(target.children ?? []));
    return next;
  });
}

/**
 * Swap the node at (wi, path) with its child at index `ci`: the child's
 * CONTENT moves up into this slot, this node's content moves down into the
 * child's slot. The tree SHAPE is unchanged — each slot keeps its children —
 * so for L3 → L4 → L5, swapping L4 with L5 gives L3 → L5 → L4.
 */
function swapWithChild<T>(roots: WipTreeNode<T>[], wi: number, path: number[], ci: number): WipTreeNode<T>[] {
  return updateAt(roots, wi, path, (parent) => {
    const kids = parent.children ?? [];
    const child = kids[ci];
    if (!child) return parent;
    const { children: parentKids, ...parentContent } = parent;
    const { children: childKids, ...childContent } = child;
    void parentKids;
    const demoted = { ...parentContent, children: childKids ?? [] } as WipTreeNode<T>;
    return {
      ...childContent,
      children: kids.map((k, i) => (i === ci ? demoted : k)),
    } as WipTreeNode<T>;
  });
}

/**
 * ↑ / ↓ for a WIP node. Prefers a sibling swap (unchanged behaviour); when
 * there is no sibling in that direction it swaps LEVELS instead:
 *   ↑ with no previous sibling → swap with the parent  (node moves up a level)
 *   ↓ with no next sibling     → swap with its first child (moves down a level)
 * Returns the new tree and the node's new location, or null when nothing can
 * move (top root going up / a leaf with no next sibling going down).
 */
export function moveWipNode<T>(
  roots: WipTreeNode<T>[],
  wi: number,
  path: number[],
  dir: -1 | 1,
): { roots: WipTreeNode<T>[]; at: WipLocation } | null {
  const node = nodeAt(roots, wi, path);
  if (!node) return null;
  const isRoot = path.length === 0;
  const idx = isRoot ? wi : path[path.length - 1];
  const siblings = isRoot ? roots : (nodeAt(roots, wi, path.slice(0, -1))?.children ?? []);
  const j = idx + dir;

  if (j >= 0 && j < siblings.length) {
    const swapped = updateSiblings(roots, wi, path, (list) => {
      const next = [...list];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
    return { roots: swapped, at: isRoot ? { wi: j, path: [] } : { wi, path: [...path.slice(0, -1), j] } };
  }

  if (dir === -1) {
    if (isRoot) return null;
    const parentPath = path.slice(0, -1);
    return { roots: swapWithChild(roots, wi, parentPath, idx), at: { wi, path: parentPath } };
  }

  if ((node.children ?? []).length === 0) return null;
  return { roots: swapWithChild(roots, wi, path, 0), at: { wi, path: [...path, 0] } };
}

/** Whether ↑ / ↓ would do anything — drives the buttons' disabled state. */
export function canMoveWipNode<T>(roots: WipTreeNode<T>[], wi: number, path: number[], dir: -1 | 1): boolean {
  const node = nodeAt(roots, wi, path);
  if (!node) return false;
  const isRoot = path.length === 0;
  const idx = isRoot ? wi : path[path.length - 1];
  const siblings = isRoot ? roots : (nodeAt(roots, wi, path.slice(0, -1))?.children ?? []);
  const j = idx + dir;
  if (j >= 0 && j < siblings.length) return true;
  return dir === -1 ? !isRoot : (node.children ?? []).length > 0;
}
