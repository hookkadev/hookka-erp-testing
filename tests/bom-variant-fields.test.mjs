// ---------------------------------------------------------------------------
// bom-variant-fields.test.mjs — variant fields per product type in the BOM
// WIP code builder (src/lib/bom-variant-fields.ts), ticked in Maintenance.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { variantFieldsFor } from "../src/lib/bom-variant-fields.ts";

const codes = (cat, saved) => variantFieldsFor(cat, saved).map((f) => f.category);

test("nothing saved -> the old lists, Accessory now with Model", () => {
  assert.deepEqual(codes("BEDFRAME"), ["PRODUCT_CODE", "SIZE", "DIVAN_HEIGHT", "LEG_HEIGHT", "TOTAL_HEIGHT", "FABRIC", "SPECIAL"]);
  assert.deepEqual(codes("SOFA"), ["PRODUCT_CODE", "MODEL", "SEAT_SIZE", "MODULE", "FABRIC", "SPECIAL"]);
  assert.deepEqual(codes("ACCESSORY"), ["PRODUCT_CODE", "MODEL", "SIZE", "FABRIC"]);
});

test("any other category reads the Accessory list", () => {
  assert.deepEqual(codes(undefined), codes("ACCESSORY"));
  assert.deepEqual(codes("PILLOW"), codes("ACCESSORY"));
});

test("saved ticks win, shown in the fixed order; unknown names and empty lists", () => {
  const saved = { ACCESSORY: ["FABRIC", "SPECIAL", "MODEL", "NOPE"], SOFA: [] };
  assert.deepEqual(codes("ACCESSORY", saved), ["MODEL", "FABRIC", "SPECIAL"]);
  assert.deepEqual(codes("SOFA", saved), []);
  assert.deepEqual(codes("BEDFRAME", saved).length, 7); // not saved -> default
});
