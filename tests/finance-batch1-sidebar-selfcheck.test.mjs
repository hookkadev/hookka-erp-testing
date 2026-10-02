// ---------------------------------------------------------------------------
// finance-batch1-sidebar-selfcheck.test.mjs — owner 2026-10-01 (batch 1 of the
// confirmed finance plan):
//   · the FINANCE sidebar opens one group at a time — 「我点 daily，report 就
//     收起来」 — and only FINANCE (other sections keep their menus independent);
//   · the Self-check debtor card speaks of invoices / receipts on 300-0000 and
//     shows receipt numbers, not record ids — it used to read in supplier words.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const m = await import(pathToFileURL(resolve(process.cwd(), "src/lib/ap-recon.ts")).href);

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const side = read("src/components/layout/sidebar.tsx");
const api = read("src/api/routes/accounting.ts");
const ui = read("src/pages/accounting/index.tsx");
const slice = (src, from, to) => { const a = src.indexOf(from); assert.notEqual(a, -1, from); const b = src.indexOf(to, a + 1); return src.slice(a, b === -1 ? undefined : b); };

test("FINANCE opens one group at a time; other sections are untouched", () => {
  assert.match(side, /const openOnly = \(prev: Set<string>\) => \{\n\s+const next = new Set\(prev\);\n\s+if \(group\.label === "FINANCE"\) \{\n\s+for \(const other of group\.items\) if \(other\.name !== item\.name\) next\.delete\(other\.name\);\n\s+\}\n\s+next\.add\(item\.name\);/);
  assert.match(side, /setExpandedMenus\(\(prev\) => openOnly\(prev\)\);/, "the icons-only rail opens the same way");
  assert.match(side, /\} else setExpandedMenus\(openOnly\(expandedMenus\)\);/);
  // Closing a group still closes only that group.
  assert.match(side, /if \(isExpanded\) \{\n\s+const next = new Set\(expandedMenus\);\n\s+next\.delete\(item\.name\);/);
});

const leg = (sourceType, sourceId, drSen, crSen) => ({ sourceType, sourceId, debitSen: drSen, creditSen: crSen });

test("the debtor side speaks of invoices and receipts on 300-0000", () => {
  // A receipt knocked off against invoices outside the books (the shape still open on prod).
  const r = m.buildApReconciliation({
    legs400: [leg("payment", "pay-1", 2500000, 0)],
    pis: [{ id: "old", piNo: "I-OLD", supplierName: "C", status: "PAID", amountSen: 2500000, paidSen: 2500000, isOpening: false, preOpeningIncluded: false, floored: true }],
    paymentRows: [{ paymentNo: "pay-1", purchaseInvoiceId: "old", bookedSen: 2500000, amountSen: 2500000, method: "BANK_TRANSFER", active: true, supplierName: "C", date: "2026-05-22" }],
    pcnPostedSen: 0, cnAllocCtlSen: 0,
  }, m.AR_RECON_CFG);
  const it = r.items[0];
  assert.equal(it.kindLabel, "receipt GL mismatch");
  assert.match(it.note, /booked to floored\/dead\/unknown invoices/);
  assert.match(it.note, /allocations to live invoices \+ on-account remainder\) vs visible GL net-CR on 300-0000\./);
  assert.doesNotMatch(it.note, /PI|400-0000|supplier/);
});

test("the creditor side keeps its words", () => {
  const r = m.buildApReconciliation({
    legs400: [leg("opening_balance", "ob", 0, 1000)],
    pis: [], paymentRows: [], pcnPostedSen: 0, cnAllocCtlSen: 0,
  });
  assert.equal(r.items[0].kindLabel, "opening coverage");
  assert.match(r.items[0].note, /^400-0000 opening leg vs Σ face of the opening-covered PIs/);
  const recon = read("src/lib/ap-recon.ts");
  assert.doesNotMatch(recon, /note: "[^"]*(?:400-0000|PIs?\b|supplier_payments)/, "no supplier words hard-coded in a note");
});

test("receipt numbers, not record ids; the card shows the side's own label", () => {
  const ar = slice(api, 'app.get("/ar-reconciliation"', "const coaRes = await c.var.DB.prepare(");
  assert.match(ar, /if \(no\) receiptNoById\.set\(String\(r\.id\), no\);/);
  assert.match(ar, /if \(it\.kind === "payment_gl_mismatch" \|\| it\.kind === "void_payment_gl_leak"\) it\.ref = receiptNoById\.get\(it\.ref\) \?\? it\.ref;/);
  assert.match(ui, /label: `\$\{i\.kindLabel \?\? i\.kind\.replace\(\/_\/g, " "\)\} · \$\{i\.ref\}/);
});
