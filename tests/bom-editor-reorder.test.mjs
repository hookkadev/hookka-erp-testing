// ---------------------------------------------------------------------------
// bom-editor-reorder.test.mjs — reorder + insert-in-the-middle in the BOM editor.
//
// Owner 2026-07-30: "工序要能插在中间" — the BOM editor only ever APPENDS a new
// process / WIP to the bottom of its list, so to place one between (e.g.)
// Framing and Webbing you have to rebuild the BOM. Two primitives fix this:
//   甲 process reorder — move a process up/down within its WIP node.
//   乙 hierarchy reorder — move a WIP among its siblings + wrap one inside a
//      new parent ("+ Above") so a stage can be inserted mid-hierarchy.
// Add-then-step-up covers "insert in the middle" for both.
//
// The primary editor is EditBOMDialog (edits an existing per-product BOM). The
// shared recursive renderer SubWIPTree already carried WIP move/wrap (optional
// props); this change adds process move to it and WIRES the full set into
// EditBOMDialog (which previously had none), and adds process move to
// MasterTemplatesDialog (which already had WIP move/wrap).
//
// Source-level structural pins (house style — no DOM render, no worker runtime).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BOM = resolve(process.cwd(), "src/pages/bom.tsx");
const src = readFileSync(BOM, "utf8");
const flat = src.replace(/\s+/g, " ");

// Slice a named component body out of the file so a pin can assert it lands in
// the RIGHT dialog (the file has three: CreateBOMDialog, EditBOMDialog,
// MasterTemplatesDialog). Returns the text from `function <name>(` up to the
// next top-level `\nfunction ` — good enough for these grep-style pins.
function componentBody(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} must exist`);
  const after = src.indexOf("\nfunction ", start + 1);
  return src.slice(start, after === -1 ? undefined : after);
}

// SubWIPTree (the old recursive renderer) was deleted 2026-10-07 once
// MasterTemplatesDialog moved to the two-pane editor; its pins went with it.

// ===========================================================================
// EditBOMDialog — the owner's editor. Previously had NO reorder at all.
// ===========================================================================

test("EditBOMDialog defines every reorder handler", () => {
  const body = componentBody("EditBOMDialog");
  for (const fn of [
    "moveProcessAtPath", // nested process (甲)
    "moveSubWIPAtPath",  // nested WIP among siblings (乙)
    "wrapSubWIPAtPath",  // insert a parent level above (乙)
    "moveWIP",           // top-level WIP reorder
    "moveWIPProcess",    // top-level process reorder (甲)
  ]) {
    assert.match(body, new RegExp(`function ${fn}\\b`), `${fn} must exist in EditBOMDialog`);
  }
});

// 2026-08-03: EditBOMDialog's WIP tab became a TWO-PANE editor — the tree is
// flattened on the left and ONE node is edited on the right, so it no longer
// renders SubWIPTree at all. The reorder capability is unchanged; it now
// reaches the detail pane through depth-agnostic adapters that dispatch on
// path length. These pins follow the capability, not the old markup.

test("EditBOMDialog routes every reorder through its depth-agnostic adapters", () => {
  const body = componentBody("EditBOMDialog");
  // Each adapter must serve BOTH families — top-level and nested — or one of
  // the two depths silently loses the affordance.
  assert.match(body, /nMoveProcess[\s\S]*?moveWIPProcess\(wi, pi, dir\)[\s\S]*?moveProcessAtPath\(wi, path, pi, dir\)/);
  assert.match(body, /nMove = \(wi: number, path: number\[\], dir: -1 \| 1\)/);
  assert.match(body, /moveWIP\(wi, dir\)/);
  assert.match(body, /moveSubWIPAtPath\(wi, path\.slice\(0, -1\), path\[path\.length - 1\], dir\)/);
  // "+ Above" (insert a parent level) survived the rework, offered on
  // sub-WIPs only: Edit BOM has no top-level wrap.
  assert.match(body, /onWrap=\{sel\.path\.length > 0 \? \(wi, path\) =>\s*wrapSubWIPAtPath\(wi, path\.slice\(0, -1\), path\[path\.length - 1\]\)/);
});

test("the detail pane renders ↑/↓ for both processes and the node itself", () => {
  const body = componentBody("WipNodeDetail");
  assert.match(body, /onMoveProcess\(wi, path, pi, -1\)/);
  assert.match(body, /onMoveProcess\(wi, path, pi, 1\)/);
  assert.match(body, /onMove\(wi, path, -1\)/);
  assert.match(body, /onMove\(wi, path, 1\)/);
  // Boundary-guarded, so the first process can't move up nor the last down.
  assert.match(body, /disabled=\{pi === 0\}/);
  assert.match(body, /disabled=\{pi === node\.processes\.length - 1\}/);
  // "+ Above" renders whenever the caller passes onWrap.
  assert.match(body, /\{onWrap && \(/);
});

test("reorder swaps are pure element swaps and boundary-guarded", () => {
  const body = componentBody("EditBOMDialog");
  // The move handlers use the classic destructuring swap and bail at the edge.
  assert.match(body, /\[list\[pi\], list\[j\]\] = \[list\[j\], list\[pi\]\]/);
  assert.match(body, /if \(pi < 0 \|\| pi >= list\.length \|\| j < 0 \|\| j >= list\.length\) return/);
});

// ===========================================================================
// MasterTemplatesDialog — 2026-10-07 it got Edit BOM's L1 / WIP tabs and the
// same two-pane WIP editor (WipTreeCard + WipNodeDetail), replacing the long
// page that rendered the recursive SubWIPTree.
// ===========================================================================

test("MasterTemplatesDialog keeps process reorder (nested + L1)", () => {
  const body = componentBody("MasterTemplatesDialog");
  assert.match(body, /function moveProcessAtPath\b/);
  assert.match(body, /function moveL1Process\b/);
  assert.match(body, /onMoveProcess=\{moveProcessAtPath\}/);
  assert.match(body, /moveL1Process\(i, -1\)/);
});

test("MasterTemplatesDialog uses the two-pane WIP editor with depth-agnostic adapters", () => {
  const body = componentBody("MasterTemplatesDialog");
  assert.match(body, /<WipTreeCard/);
  assert.match(body, /<WipNodeDetail/);
  assert.match(body, /L1 Processes \(FG\)/);
  // Move / remove / wrap must serve both the top level and nested nodes.
  assert.match(body, /if \(dir < 0\) moveWIPUp\(wi\);/);
  assert.match(body, /moveSubWIPDownAtPath\(wi, path\.slice\(0, -1\), path\[path\.length - 1\]\)/);
  assert.match(body, /if \(path\.length === 0\) wrapWIPAt\(wi\);/);
  assert.match(body, /if \(path\.length === 0\) removeWIP\(wi\);/);
  assert.match(body, /onWrap=\{nWrap\}/);
});
