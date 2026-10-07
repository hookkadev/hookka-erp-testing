// ---------------------------------------------------------------------------
// bom-wip-tree-ops.test.mjs — delete-one-level + level-swap ↑/↓ in the BOM
// WIP tree (src/lib/wip-tree-ops.ts).
//
// Owner 2026-10-06, product BOM editor, linear chain L2→L3→…→L7:
//   "我要 delete 掉中间一层而已 delete 不掉，然后上下调动不行"
//   • delete on L4 wiped L4–L7 → must remove ONLY L4, L5 moves up.
//   • ↑/↓ only swapped siblings; a linear chain has none → no-op.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { removeWipLevel, moveWipNode, canMoveWipNode } from "../src/lib/wip-tree-ops.ts";

// L2 → L3 → L4 → L5 → L6 → L7, one child each (the screenshot's shape).
function chain() {
  const ids = ["L2", "L3", "L4", "L5", "L6", "L7"];
  let node = null;
  for (const id of ids.slice().reverse()) {
    node = { id, processes: [id + "-proc"], children: node ? [node] : [] };
  }
  return [node];
}
// Flatten a linear chain to its id order.
const order = (roots, wi = 0) => {
  const out = [];
  let n = roots[wi];
  while (n) { out.push(n.id); n = n.children?.[0]; }
  return out;
};

test("delete a middle level removes only that level — the rest move up", () => {
  const roots = chain();
  // L4 is roots[0] → [0] (L3) → [0,0] (L4)
  const next = removeWipLevel(roots, 0, [0, 0]);
  assert.deepEqual(order(next), ["L2", "L3", "L5", "L6", "L7"]);
  assert.deepEqual(order(roots), ["L2", "L3", "L4", "L5", "L6", "L7"], "input not mutated");
});

test("delete a root level promotes its children to roots", () => {
  const next = removeWipLevel(chain(), 0, []);
  assert.equal(next.length, 1);
  assert.deepEqual(order(next), ["L3", "L4", "L5", "L6", "L7"]);
});

test("delete keeps sibling order when the removed node had several children", () => {
  const roots = [{ id: "A", children: [{ id: "B", children: [{ id: "c1" }, { id: "c2" }] }, { id: "D" }] }];
  const next = removeWipLevel(roots, 0, [0]);
  assert.deepEqual(next[0].children.map((c) => c.id), ["c1", "c2", "D"]);
});

test("↑ on a node with no sibling swaps levels with its parent", () => {
  const moved = moveWipNode(chain(), 0, [0, 0], -1); // L4 up
  assert.ok(moved);
  assert.deepEqual(order(moved.roots), ["L2", "L4", "L3", "L5", "L6", "L7"]);
  assert.deepEqual(moved.at, { wi: 0, path: [0] });
  // content travels with the level; the shape stays a chain
  assert.deepEqual(moved.roots[0].children[0].processes, ["L4-proc"]);
});

test("↓ on a node with no sibling swaps levels with its child", () => {
  const moved = moveWipNode(chain(), 0, [0, 0], 1); // L4 down
  assert.ok(moved);
  assert.deepEqual(order(moved.roots), ["L2", "L3", "L5", "L4", "L6", "L7"]);
  assert.deepEqual(moved.at, { wi: 0, path: [0, 0, 0] });
});

test("↑ on the first child of a root swaps with the root", () => {
  const moved = moveWipNode(chain(), 0, [0], -1); // L3 up
  assert.deepEqual(order(moved.roots), ["L3", "L2", "L4", "L5", "L6", "L7"]);
  assert.deepEqual(moved.at, { wi: 0, path: [] });
});

test("siblings still swap as siblings (unchanged behaviour)", () => {
  const roots = [{ id: "P", children: [{ id: "a" }, { id: "b" }, { id: "c" }] }];
  const up = moveWipNode(roots, 0, [1], -1);
  assert.deepEqual(up.roots[0].children.map((c) => c.id), ["b", "a", "c"]);
  assert.deepEqual(up.at, { wi: 0, path: [0] });
  const rootsTop = [{ id: "R1" }, { id: "R2" }];
  const down = moveWipNode(rootsTop, 0, [], 1);
  assert.deepEqual(down.roots.map((r) => r.id), ["R2", "R1"]);
  assert.deepEqual(down.at, { wi: 1, path: [] });
});

test("boundaries: top root can't go up, a leaf can't go down", () => {
  const roots = chain();
  assert.equal(moveWipNode(roots, 0, [], -1), null);
  assert.equal(canMoveWipNode(roots, 0, [], -1), false);
  const leaf = [0, 0, 0, 0, 0];
  assert.equal(moveWipNode(roots, 0, leaf, 1), null);
  assert.equal(canMoveWipNode(roots, 0, leaf, 1), false);
  assert.equal(canMoveWipNode(roots, 0, leaf, -1), true);
  assert.equal(canMoveWipNode(roots, 0, [0, 0], 1), true);
});
