// ---------------------------------------------------------------------------
// drill-bs-document-names.test.mjs — after the balance-sheet drill (#607),
// measured on prod: supplier payments, other-creditor payments, customer
// receipts and purchase credit notes (the documents that mostly sit on
// balance-sheet accounts) showed no Ref. 2 — the shared line builder only knew
// the documents that hit the P&L. They now name their counterparty like the
// Cash Flow drill does (owner 2026-09-30 「Balance sheet 也要这样点开看」).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const api = readFileSync("src/api/routes/accounting.ts", "utf8").replace(/\r\n/g, "\n");
const slice = (src, from, to) => { const a = src.indexOf(from); assert.notEqual(a, -1, from); const b = src.indexOf(to, a + 1); return src.slice(a, b === -1 ? undefined : b); };
const fn = slice(api, "async function buildDrillLines(", "\n}\n");

test("supplier payments name the supplier and list the PIs on hover", () => {
  assert.match(fn, /SELECT payment_no, purchase_invoice_id, supplier_name FROM supplier_payments WHERE payment_no IN \(\$\{ph\}\) AND org_id = \?/);
  assert.match(fn, /setInfo\(isSp, no, \{\n\s+party: partyByPay\.get\(no\) \?\? null,/);
  assert.match(fn, /header: pvPurposeByNo\.get\(no\) \?\? "Supplier payment",/, "a voucher-made payment takes the voucher's purpose");
});

test("other-creditor payments, customer receipts and purchase credit notes name their counterparty", () => {
  assert.match(fn, /SELECT payment_no, bill_id, party_name FROM other_party_payments WHERE payment_no IN/);
  assert.match(fn, /header: pvPurposeByNo\.get\(no\) \?\? "Other creditor payment",/);
  assert.match(fn, /SELECT id, customerName FROM payment_records WHERE id IN/);
  assert.match(fn, /const isRc = \(t: string\) => t === "payment" \|\| \(t\.startsWith\("payment_"\) && !t\.startsWith\("payment_voucher"\)\);/, "a voucher is not a receipt");
  assert.match(fn, /SELECT id, noteNumber, supplierName, piNo FROM purchase_credit_notes WHERE id IN/);
  assert.match(fn, /SELECT pvNo, description FROM payment_vouchers WHERE pvNo IN/);
});
