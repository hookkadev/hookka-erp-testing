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

test("wholeUomsFrom: absent → default (no PCS, foam sheets go fractional); [] → none", () => {
  assert.deepEqual(mv.wholeUomsFrom(undefined), mv.DEFAULT_WHOLE_UOMS);
  assert.ok(!mv.DEFAULT_WHOLE_UOMS.includes("PCS"));
  assert.ok(mv.DEFAULT_WHOLE_UOMS.includes("BOX"));
  assert.deepEqual(mv.wholeUomsFrom([]), []);
  assert.deepEqual(mv.wholeUomsFrom([" pcs "]), ["PCS"]);
});

test("isFractionOfWholeUom: only a fraction in a whole unit fails", () => {
  const whole = ["BOX", "CTN"];
  assert.equal(mv.isFractionOfWholeUom("BOX", 2.5, whole), true);
  assert.equal(mv.isFractionOfWholeUom("box", 2.5, whole), true);
  assert.equal(mv.isFractionOfWholeUom("BOX", 3, whole), false);
  assert.equal(mv.isFractionOfWholeUom("BOX", 0, whole), false);
  assert.equal(mv.isFractionOfWholeUom("BOX", 2.9999999999999996, whole), false, "float noise is not a fraction");
  assert.equal(mv.isFractionOfWholeUom("MTR", 12.5, whole), false);
});

test("whole-number rule is Inventory-page only (RM create / edit), never stock adjustments", () => {
  const src = read("src/api/routes/raw-materials.ts");
  const post = src.slice(src.indexOf('app.post("/", '), src.indexOf('app.put("/:id"'));
  const put = src.slice(src.indexOf('app.put("/:id"'), src.indexOf('app.delete("/:id"'));
  assert.match(post, /isFractionOfWholeUom\(baseUOM, balanceQty, wholeUoms\)/);
  // PUT checks only a CHANGED balance, so a BOX left at 12.5 by production
  // does not block renaming the material.
  assert.match(put, /balanceChanged && isFractionOfWholeUom\(/);
  // Owner scope: Stock Adjustments / PO / GRN stay unchecked.
  for (const f of ["src/api/routes/stock-adjustments.ts", "src/api/routes/purchase-orders.ts", "src/api/routes/grn.ts"]) {
    assert.doesNotMatch(read(f), /isFractionOfWholeUom|wholeUoms/, f);
  }
  // Edit RM Stock Qty keeps decimals (it used parseInt: 12.5 MTR saved as 12).
  assert.doesNotMatch(read("src/pages/inventory/index.tsx"), /balanceQty: parseInt\(/);
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
