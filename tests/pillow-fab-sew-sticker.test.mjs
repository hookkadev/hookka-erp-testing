// DEV-26 / BUG-2026-09-30-231: pillows had a Fab Cut QR and no Fab Sew QR.
//
// The Fab Sew sticker builder skips a sofa's Back Cushion / Armrest / Headrest
// rows (the BASE sticker travels with the assembly). Pillow BOMs are typed
// SOFA_CUSHION, the closest of the six BOM types, so the sofa rule hid them
// too. The rule now spares ACCESSORY rows, in BOTH print paths.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }

const core = await import(
  pathToFileURL(resolve(process.cwd(), "src/pages/production/baserows-core.ts")).href
);
const { travelsWithBaseSticker, buildBaseRows, buildOnePickerEntry } = core;

// A pillow order as staging returns it (SO-2609-393-12, trimmed).
const WK = "SQUARE PILLOW::0::SOFA_CUSHION::SQUARE PILLOW {FABRIC} (FOAM)";
const order = (itemCategory) => ({
  id: "po-1",
  poNo: "SO-2609-393-12",
  productCode: "SQUARE PILLOW",
  productName: 'SOFA SQUARE PILLOW (16"X16")',
  itemCategory,
  fabricCode: "CH141-04",
  quantity: 1,
  status: "PENDING",
  jobCards: [
    { id: "jc-sew", departmentCode: "FAB_SEW", wipType: "SOFA_CUSHION", wipKey: WK, wipQty: 1, status: "WAITING", sequence: 2 },
    { id: "jc-foam", departmentCode: "FOAM", wipKey: WK, status: "WAITING", sequence: 3 },
  ],
});
const fabSewRows = (o) =>
  buildBaseRows([o], new Map([[o.id, buildOnePickerEntry(o)]]), "full", "FAB_SEW", "2026-09-30")
    .filter((r) => r._deptCode === "FAB_SEW");

test("a pillow's Fab Sew row keeps its sticker", () => {
  const rows = fabSewRows(order("ACCESSORY"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].wipType, "CUSHION");
  assert.equal(travelsWithBaseSticker(rows[0]), false);
});

test("the same row on a SOFA is still skipped", () => {
  const rows = fabSewRows(order("SOFA"));
  assert.equal(rows.length, 1);
  assert.equal(travelsWithBaseSticker(rows[0]), true);
});

test("sofa sub-parts skip, base and bedframe pieces print", () => {
  for (const wipType of ["CUSHION", "ARMREST", "HEADREST"]) {
    assert.equal(travelsWithBaseSticker({ wipType, category: "SOFA" }), true, wipType);
    assert.equal(travelsWithBaseSticker({ wipType, category: "ACCESSORY" }), false, wipType);
    // Unknown category keeps the old behaviour: no new stickers for legacy rows.
    assert.equal(travelsWithBaseSticker({ wipType, category: "" }), true, wipType);
  }
  for (const wipType of ["BASE", "DIVAN", "HB", "FG_MAIN", ""]) {
    assert.equal(travelsWithBaseSticker({ wipType, category: "SOFA" }), false, wipType);
  }
});

test("both print paths use the one rule, no inline copy left", () => {
  const page = readFileSync(resolve(process.cwd(), "src/pages/production/index.tsx"), "utf8");
  assert.equal(page.match(/travelsWithBaseSticker\(row\)/g)?.length, 2);
  assert.doesNotMatch(page, /row\.wipType === "CUSHION" \|\|/);
});
