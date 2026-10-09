// ---------------------------------------------------------------------------
// bom-manual-minutes.test.mjs — BOM process minutes are typed in by hand.
//
// Owner 2026-10-05: the CAT 1-14 dropdown on BOM process rows is removed. It
// used to fill minutes from the Production Times matrix (kv_config
// 'variants-config'.productionTimes), which has had no editor since 2026-08-01.
// Every process row now has a plain minutes input, and the PO builder no longer
// stamps a made-up "CAT 1" on job cards: the job-card resync keys on
// (dept, category) and would overwrite the typed minutes with CAT 1's value.
//
// Source-level structural pins (house style — no DOM render).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const bom = readFileSync(resolve(process.cwd(), "src/pages/bom.tsx"), "utf8");
const builder = readFileSync(resolve(process.cwd(), "src/lib/production-order-builder.ts"), "utf8");

test("no CAT dropdown or matrix lookup left on the BOM page", () => {
  assert.doesNotMatch(bom, /<select\s+value=\{p\.category\}/);
  assert.doesNotMatch(bom, /getProductionMinutes|getCategoryOptions/);
  assert.doesNotMatch(bom, /category: "CAT \d+"/);
});

test("every process row edits minutes through MinutesInput", () => {
  const inputs = bom.match(/<MinutesInput value=\{p\.minutes\} onChange=\{\(m\) => [^}]*"minutes", m\)\}/g) || [];
  // 5 since 2026-10-07: Master BOM Templates edits WIP rows through the shared
  // WipNodeDetail, so its own root-WIP row and SubWIPTree's row are gone.
  assert.equal(inputs.length, 5);
  assert.doesNotMatch(bom, /<span className="[^"]*">\{p\.minutes\}<\/span>/);
});

test("PO builder does not invent a CAT for job cards", () => {
  assert.doesNotMatch(builder, /p\.category \|\| "CAT 1"/);
});

// BUG-2026-10-05-254: the box showed "052" after typing 52 over a 0. A
// type="number" input keeps its own text when the numeric value already
// matches the prop, so the box is text and always shows String(value).
test("minutes box shows the clean number, never a leading zero", () => {
  assert.match(bom, /function MinutesInput[\s\S]*?type="text"[\s\S]*?inputMode="numeric"[\s\S]*?value=\{String\(value\)\}/);
  const body = bom.match(/function parseMinutes\(text: string\): number \{([\s\S]*?)\r?\n\}/)[1];
  const parseMinutes = new Function("text", body);
  assert.equal(parseMinutes("052"), 52);
  assert.equal(parseMinutes("0"), 0);
  assert.equal(parseMinutes(""), 0);
  assert.equal(parseMinutes("4a5"), 45);
  assert.equal(parseMinutes("-7"), 7);
  assert.equal(parseMinutes("2000"), 1440);
  assert.equal(String(parseMinutes("052")), "52");
});
