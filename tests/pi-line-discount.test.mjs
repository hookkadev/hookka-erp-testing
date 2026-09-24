// ---------------------------------------------------------------------------
// DEV-14 — purchase invoice DISCOUNT.
//
// The supplier prints ONE discount for the whole invoice (Meditex SMI2608/599:
// Gross 856.00 · Discount (81.00) · Total 775.00). The pages take that one
// figure and `allocateDiscountSen` spreads it across the lines pro-rata; each
// share is stored as purchase_invoice_items.discount_sen and line_total_sen is
// stored NET of it (`discountedLineSen`), so the GL posting, costing and 3-way
// match (all readers of line_total_sen) see the discounted amount unchanged.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { discountedLineSen, allocateDiscountSen } from "../src/lib/unit-price.ts";

const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");

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

test("Meditex SMI2608/599: RM 81.00 off RM 856.00 lands at exactly RM 775.00", () => {
  const gross = [41800, 16800, 27000];
  const shares = allocateDiscountSen(gross, 8100);
  assert.equal(shares.reduce((s, v) => s + v, 0), 8100, "shares sum to the discount exactly");
  const net = gross.map((g, i) => discountedLineSen(1, g, shares[i]).lineTotalSen);
  assert.equal(net.reduce((s, v) => s + v, 0), 77500);
  // Pro-rata: the biggest line carries the biggest share.
  assert.ok(shares[0] > shares[2] && shares[2] > shares[1]);
});

test("allocation: rounding never loses or invents a sen; ineligible lines get 0", () => {
  assert.deepEqual(allocateDiscountSen([100, 100, 100], 100), [34, 33, 33]);
  assert.deepEqual(allocateDiscountSen([100, 500], 999999), [100, 500], "clamped to the gross");
  assert.deepEqual(allocateDiscountSen([100, 500], 0), [0, 0]);
  assert.deepEqual(allocateDiscountSen([100, 500], -50), [0, 0]);
  assert.deepEqual(allocateDiscountSen([], 100), []);
  // A TAX line does not share in the discount.
  assert.deepEqual(allocateDiscountSen([1000, 60], 100, [true, false]), [100, 0]);
});

test("API stores discount_sen and a net line_total_sen on BOTH create and edit", () => {
  const src = read("../src/api/routes/purchase-invoices.ts");
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

test("ONE invoice discount on every surface — no per-line Discount column anywhere", () => {
  const create = read("../src/pages/procurement/pi/create.tsx");
  const detail = read("../src/pages/procurement/PurchaseInvoiceDetail.tsx");
  const scan = read("../src/components/scan-supplier-modal.tsx");
  for (const [name, src] of [["create", create], ["detail", detail], ["scan", scan]]) {
    assert.match(src, /allocateDiscountSen\(/, `${name} spreads the invoice discount`);
    assert.doesNotMatch(src, /Discount \(RM\)<\/th>|>Discount<\/th>/, `${name} has no per-line Discount column`);
  }
  assert.match(create, /discountSen: lineDiscountSens\[idx\]/);
  assert.match(detail, /discountSen: draftLineDiscountSens\[i\]/);
  assert.match(scan, /discountSen: lineDiscSen\[idx\]/);
  // Scan pre-fills from the footer discount the OCR reads.
  assert.match(scan, /Math\.max\(0, Number\(ex\.discount\) \|\| 0\)/);
});
