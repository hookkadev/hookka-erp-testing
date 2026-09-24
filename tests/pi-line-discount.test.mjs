// ---------------------------------------------------------------------------
// DEV-14 — per-line Discount column on purchase invoices.
//
// line_total_sen is stored NET of purchase_invoice_items.discount_sen, so the
// GL posting, costing and 3-way match (all readers of line_total_sen) see the
// discounted amount with no change of their own. `discountedLineSen` is the ONE
// place that maths lives — the API, the create page and the detail page all
// call it — so it is what this file pins, plus the wiring that uses it.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { discountedLineSen } from "../src/lib/unit-price.ts";

test("net line = qty × unit − discount, rounded once on the product", () => {
  assert.deepEqual(discountedLineSen(10, 1250, 500), { discountSen: 500, lineTotalSen: 12000 });
  // Sub-cent rate: 600 × 5.5 sen = 3300 sen, less RM 3.00.
  assert.deepEqual(discountedLineSen(600, 5.5, 300), { discountSen: 300, lineTotalSen: 3000 });
});

test("no / bad discount is zero, never NaN", () => {
  assert.deepEqual(discountedLineSen(2, 1000, 0), { discountSen: 0, lineTotalSen: 2000 });
  assert.deepEqual(discountedLineSen(2, 1000, NaN), { discountSen: 0, lineTotalSen: 2000 });
  assert.deepEqual(discountedLineSen(2, 1000, undefined), { discountSen: 0, lineTotalSen: 2000 });
});

test("discount is clamped to [0, gross] so discount + net always = gross", () => {
  assert.deepEqual(discountedLineSen(2, 1000, -500), { discountSen: 0, lineTotalSen: 2000 });
  assert.deepEqual(discountedLineSen(2, 1000, 99999), { discountSen: 2000, lineTotalSen: 0 });
});

test("API stores discount_sen and a net line_total_sen on BOTH create and edit", () => {
  const src = readFileSync(new URL("../src/api/routes/purchase-invoices.ts", import.meta.url), "utf8");
  assert.match(src, /ADD COLUMN IF NOT EXISTS discount_sen INTEGER/, "column must be runtime self-applied");
  assert.match(src, /discountedLineSen\(qty, unitPriceSen, Number\(it\.discountSen\)\)/);
  const inserts = src.match(/INSERT INTO purchase_invoice_items \([^)]*\)/g) ?? [];
  assert.equal(inserts.length, 2, "POST + PUT");
  for (const ins of inserts) assert.match(ins, /discount_sen/);
});

test("scan: a unit price backed out of a NET amount adds the discount back", async () => {
  const { sanitizeSupplierDoc } = await import("../src/api/lib/scan-engine.ts");
  const [line] = sanitizeSupplierDoc({
    lines: [{ description: "FOAM", qty: 10, unitPrice: null, amount: 90, discount: 10 }],
  }).lines;
  assert.equal(line.unitPrice, 10, "gross 100 / 10, not net 90 / 10");
  assert.equal(line.discount, 10);
  // A printed price is never touched.
  const [kept] = sanitizeSupplierDoc({
    lines: [{ description: "FOAM", qty: 10, unitPrice: 12, amount: 110, discount: 10 }],
  }).lines;
  assert.equal(kept.unitPrice, 12);
});

test("scan modal carries the OCR discount onto the PI line and lets the operator edit it", () => {
  const src = readFileSync(new URL("../src/components/scan-supplier-modal.tsx", import.meta.url), "utf8");
  assert.match(src, /const discountRM =\s*ln\.discount == null/);
  assert.match(src, /discountSen: Math\.max\(0, Math\.round\(\(Number\(l\.discountRM\) \|\| 0\) \* 100\)\)/);
  assert.match(src, /onPatchLine\(i, \{\s*discountRM:/);
  assert.match(src, /const lineAmtsSen = pricedLines\.map\(\(l\) => scanLineNetSen\(l\)\)/);
});

test("both PI pages total lines through the shared helper and send discountSen", () => {
  for (const f of ["../src/pages/procurement/pi/create.tsx", "../src/pages/procurement/PurchaseInvoiceDetail.tsx"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.match(src, /discountedLineSen\(/, f);
    assert.match(src, /discountSen: l\.discountSen/, f);
  }
});
