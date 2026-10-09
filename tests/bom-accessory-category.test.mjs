// bom-accessory-category.test.mjs — bom_templates.category can only store
// BEDFRAME | SOFA, so an ACCESSORY product's BOM read back as BEDFRAME on the
// BOM page and in /api/wip-times. Both now take the category from products.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withProductCategory } from "../src/pages/bom-category.ts";

test("ACCESSORY product overrides the coerced BEDFRAME template category", () => {
  const tpls = [
    { productCode: "BC04", category: "BEDFRAME" },
    { productCode: "1003-(K)", category: "BEDFRAME" },
    { productCode: "ORPHAN", category: "SOFA" },
  ];
  const products = [
    { code: "BC04", category: "ACCESSORY" },
    { code: "1003-(K)", category: "BEDFRAME" },
  ];
  const out = withProductCategory(tpls, products);
  assert.deepEqual(out.map((t) => t.category), ["ACCESSORY", "BEDFRAME", "SOFA"]);
  assert.equal(out[1], tpls[1], "unchanged templates keep identity");
});

test("wip-times BOM query reads category from products first", () => {
  const src = readFileSync(new URL("../src/api/lib/wip-times-core.ts", import.meta.url), "utf8");
  assert.match(src, /UPPER\(COALESCE\(p\.category, bt\.category\)\) = \?/);
  assert.match(src, /COALESCE\(p\.category, bt\.category\) AS "category"/);
});
