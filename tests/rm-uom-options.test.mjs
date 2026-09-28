// ---------------------------------------------------------------------------
// rm-uom-options.test.mjs — DEV-20: per-category allowed UOMs for raw
// materials, and the lock that stops a unit change under existing quantities.
//
// Every RM quantity (balanceQty, rm_batches, open PO lines, BOM qtyPerUnit) is
// a bare number read in the material's baseUOM. Nothing converts on a change,
// so MTR → ROLL on a material holding 50 would silently mean "50 rolls".
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const load = (p) => import(pathToFileURL(resolve(process.cwd(), p)).href);
const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const mv = await load("src/lib/material-variants.ts");
const locks = await load("src/api/lib/lock-helpers.ts");

test("uomOptionsFor: configured group narrows, unconfigured / empty falls back to every unit", () => {
  const opts = { "B.M-FABR": ["MTR", "ROLL"], EMPTY: [] };
  assert.deepEqual(mv.uomOptionsFor("B.M-FABR", opts), ["MTR", "ROLL"]);
  assert.deepEqual(mv.uomOptionsFor(" B.M-FABR ", opts), ["MTR", "ROLL"]);
  assert.deepEqual(mv.uomOptionsFor("PLYWOOD", opts), mv.ALL_RM_UOMS);
  assert.deepEqual(mv.uomOptionsFor("EMPTY", opts), mv.ALL_RM_UOMS);
  assert.deepEqual(mv.uomOptionsFor("B.M-FABR", null), mv.ALL_RM_UOMS);
});

test("isUomAllowed: rejects an off-list unit, ignores case (legacy 'mtr' rows)", () => {
  const opts = { "B.M-FABR": ["MTR", "ROLL"] };
  assert.equal(mv.isUomAllowed("B.M-FABR", "MTR", opts), true);
  assert.equal(mv.isUomAllowed("B.M-FABR", " mtr ", opts), true);
  assert.equal(mv.isUomAllowed("B.M-FABR", "PCS", opts), false);
  assert.equal(mv.isUomAllowed("PLYWOOD", "PCS", opts), true);
});

test("sameUom: case / whitespace is not a unit change", () => {
  assert.equal(mv.sameUom("pcs", "PCS "), true);
  assert.equal(mv.sameUom("MTR", "ROLL"), false);
  assert.equal(mv.sameUom(null, ""), true);
});

function fakeDb(counts) {
  return {
    prepare() {
      return { bind() { return { async first() { return counts; } }; } };
    },
  };
}
const rm = (balanceQty) => ({ id: "rm-1", itemCode: "PC151 01", balanceQty });

test("UOM lock: free only when stock, batches and open PO lines are all zero", async () => {
  assert.equal(await locks.checkRawMaterialUomLocked(fakeDb({ batches: 0, pos: 0 }), rm(0)), null);
  assert.equal(await locks.checkRawMaterialUomLocked(fakeDb(null), rm(null)), null);

  const bal = await locks.checkRawMaterialUomLocked(fakeDb({ batches: 0, pos: 0 }), rm(50));
  assert.match(bal, /stock balance 50/);
  // Negative stock is still stock counted in the old unit.
  assert.match(await locks.checkRawMaterialUomLocked(fakeDb({ batches: 0, pos: 0 }), rm(-3)), /stock balance -3/);

  // COUNT(*) arrives as a string (bigint) from Postgres.
  const batches = await locks.checkRawMaterialUomLocked(fakeDb({ batches: "2", pos: "0" }), rm(0));
  assert.match(batches, /2 batch\(es\) on hand/);
  const pos = await locks.checkRawMaterialUomLocked(fakeDb({ batches: 0, pos: "1" }), rm(0));
  assert.match(pos, /1 open purchase order line/);
});

test("route wiring: create / edit / import all enforce the rules", () => {
  const src = read("src/api/routes/raw-materials.ts");
  const post = src.slice(src.indexOf('app.post("/", '), src.indexOf('app.put("/:id"'));
  const put = src.slice(src.indexOf('app.put("/:id"'), src.indexOf('app.delete("/:id"'));
  const bulk = src.slice(src.indexOf('app.post("/bulk-import"'));

  assert.match(post, /isUomAllowed\(itemGroup, baseUOM, uomOpts\)/);
  assert.match(put, /checkRawMaterialUomLocked\(c\.var\.DB, existing\)/);
  // The PUT checks run before the UPDATE is built.
  assert.ok(put.indexOf("checkRawMaterialUomLocked") < put.indexOf("UPDATE raw_materials SET"));
  assert.match(bulk, /checkRawMaterialUomLocked/);
  // A rejected import row must leave the rename maps alone.
  assert.ok(bulk.indexOf("uomNotAllowedMsg") < bulk.indexOf("codeToId.delete(priorCode)"));
  // A blank UOM cell keeps the existing unit instead of resetting it to PCS.
  assert.match(bulk, /pickUnit\(r, prior\?\.baseUOM \|\| "PCS"\)/);
});
