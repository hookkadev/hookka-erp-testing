// ---------------------------------------------------------------------------
// selfcheck-recon-mirrors-controls.test.mjs — BUG-2026-09-30-229 / -230
// (class C18: two surfaces serving one figure, a filter added to only one).
//
// Measured on prod 2026-09-30: the Self-check headline (it shows the itemized
// reconciliation's drift) read the creditor side 105,662.52 off and the debtor
// side 169,331.00 off, while the control cards read 7,595.00 and −25,000.00.
//   · creditor: three trade-finance repayments (method TF_REPAYMENT, no PI,
//     GL on the TF account) counted as supplier advances — the card's loader
//     leaves them out;
//   · debtor: every receipt held on account read as a "void payment GL leak"
//     — the card nets those off as unapplied customer advances;
//   · the real 7,595.00 includes four CANCELLED supplier opening seeds the
//     opening sum still counted (the customer seeds already leave them out).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const m = await import(pathToFileURL(resolve(process.cwd(), "src/lib/ap-recon.ts")).href);

const api = readFileSync("src/api/routes/accounting.ts", "utf8").replace(/\r\n/g, "\n");
const slice = (src, from, to) => { const a = src.indexOf(from); assert.notEqual(a, -1, from); const b = src.indexOf(to, a + 1); return src.slice(a, b === -1 ? undefined : b); };

const pi = (o) => ({
  id: o.id, piNo: o.piNo ?? o.id, supplierName: o.sup ?? "S", status: o.status ?? "CONFIRMED",
  amountSen: o.face, paidSen: o.paid ?? 0,
  isOpening: !!o.isOpening, preOpeningIncluded: !!o.preOpen, floored: !!o.floored,
});
const leg = (sourceType, sourceId, drSen, crSen) => ({ sourceType, sourceId, debitSen: drSen, creditSen: crSen });
const pay = (o) => ({
  paymentNo: o.no, purchaseInvoiceId: o.pi ?? null, bookedSen: o.booked ?? 0,
  amountSen: o.amount ?? o.booked ?? 0, method: o.method ?? "BANK_TRANSFER",
  active: o.active !== false, supplierName: o.sup ?? "S", date: o.date ?? "2026-09-01",
});
const run = (i, cfg) => m.buildApReconciliation({ legs400: [], pis: [], paymentRows: [], pcnPostedSen: 0, cnAllocCtlSen: 0, ...i }, cfg);
const invariant = (r) => { assert.equal(r.unexplainedResidualSen, 0); assert.equal(r.explainedSen, r.driftSen); };

test("a trade-finance repayment is not a supplier advance (its GL is on the TF account)", () => {
  const r = run({ paymentRows: [pay({ no: "HPV-2609-008", amount: 3423333, booked: 3423333, method: "TF_REPAYMENT", sup: "LENDER" })] });
  assert.equal(r.unappliedAdvanceSen, 0);
  assert.equal(r.driftSen, 0);
  assert.deepEqual(r.items, []);
  invariant(r);
});

test("prod shape (creditor): three TF repayments + a stale opening leg → only the real 7,595.00", () => {
  const r = run({
    legs400: [leg("opening_balance", "ob-1", 0, 17826840)],
    pis: [pi({ id: "seeds", face: 17067340, isOpening: true })],
    paymentRows: [
      pay({ no: "HPV-2609-008", amount: 3423333, booked: 3423333, method: "TF_REPAYMENT" }),
      pay({ no: "HPV-2609-054", amount: 3346649, booked: 3346649, method: "TF_REPAYMENT" }),
      pay({ no: "HPV-2609-036", amount: 3036770, booked: 3036770, method: "TF_REPAYMENT" }),
    ],
  });
  assert.equal(r.driftSen, 759500, "what /ap-control reads");
  assert.deepEqual(r.items.map((i) => [i.kind, i.contributionSen]), [["opening_coverage", 759500]]);
  invariant(r);
});

test("a TF repayment whose GL did touch the control is still itemized", () => {
  const r = run({
    legs400: [leg("supplier_payment", "HPV-9", 5000, 0)],
    paymentRows: [pay({ no: "HPV-9", amount: 5000, booked: 5000, method: "TF_REPAYMENT" })],
  });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].kind, "payment_gl_mismatch");
  assert.equal(r.items[0].contributionSen, -5000);
  invariant(r);
});

test("debtor side: money held on account is an advance, like /ar-control nets it off", () => {
  const cfg = m.AR_RECON_CFG;
  // Receipt CR 300 fed swapped as DR; no allocations → one on-account row.
  const onAccount = run({
    legs400: [leg("payment", "pay-june", 4500000, 0)],
    paymentRows: [pay({ no: "pay-june", amount: 4500000 })],
  }, cfg);
  assert.equal(onAccount.unappliedAdvanceSen, 4500000);
  assert.deepEqual(onAccount.items, []);
  invariant(onAccount);
  // Partly allocated (the 541.00 shape): allocation rows + the remainder row tie the GL.
  const partial = run({
    legs400: [leg("invoice", "inv-1", 0, 2376198), leg("payment", "pay-aug", 2430298, 0)],
    pis: [pi({ id: "inv-1", face: 2376198, paid: 2376198, status: "PAID" })],
    paymentRows: [pay({ no: "pay-aug", pi: "inv-1", booked: 2376198 }), pay({ no: "pay-aug", amount: 54100 })],
  }, cfg);
  assert.deepEqual(partial.items, []);
  invariant(partial);
  // Knocked off against invoices outside the books: still a real item.
  const outside = run({
    legs400: [leg("payment", "pay-may", 2500000, 0)],
    pis: [pi({ id: "old", face: 2500000, paid: 2500000, floored: true })],
    paymentRows: [pay({ no: "pay-may", pi: "old", booked: 2500000 })],
  }, cfg);
  assert.equal(outside.driftSen, -2500000, "what /ar-control reads");
  assert.deepEqual(outside.items.map((i) => [i.kind, i.contributionSen]), [["payment_gl_mismatch", -2500000]]);
  invariant(outside);
});

test("the reconciliations copy the control cards' advance rules", () => {
  // Creditor: both leave trade-finance repayments out.
  const supAdv = slice(api, "async function loadUnappliedSupplierAdvances(", "\n}\n");
  assert.match(supAdv, /AND COALESCE\(sp\.method,''\) <> 'TF_REPAYMENT'/);
  const recon = readFileSync("src/lib/ap-recon.ts", "utf8");
  assert.match(recon, /if \(r\.method === "TF_REPAYMENT"\) continue;/);
  assert.match(recon, /if \(all\.length > 0 && all\.every\(\(r\) => r\.method === "TF_REPAYMENT"\)\) \{/);
  // Debtor: both take amount − Σ allocations, positive only, receipts with a customer.
  const custAdv = slice(api, "async function loadUnappliedCustomerAdvances(", "\n}\n");
  assert.match(custAdv, /const sen = Math\.round\(Number\(r\.amount\) \|\| 0\) - allocated;\n\s+if \(sen <= 0\) continue;/);
  assert.match(custAdv, /if \(!custId\) continue;/);
  const arRecon = slice(api, 'app.get("/ar-reconciliation"', "const report = buildApReconciliation(");
  assert.match(arRecon, /pr\.customerId AS customerId/);
  assert.match(arRecon, /const onAccountSen = Math\.round\(Number\(r\.amount\) \|\| 0\) - allocs\.reduce\(\(s, a\) => s \+ Math\.round\(Number\(a\.amount\) \|\| 0\), 0\);\n\s+if \(onAccountSen > 0 && String\(r\.customerId \?\? r\.customer_id \?\? ""\)\) \{/);
  assert.doesNotMatch(arRecon, /subtracts no advances/, "the stale note is gone");
});

test("a cancelled opening seed is not an opening bill — on either side, in the sum and in the list", () => {
  const sums = slice(api, "async function openingControlSums(", "\n}\n");
  assert.match(sums, /WHERE i\.isOpening = 1 AND i\.status NOT IN \('DRAFT','CANCELLED'\)/, "customer seeds");
  assert.match(sums, /FROM purchase_invoices\n\s+WHERE isOpening = 1 AND status NOT IN \('DRAFT','CANCELLED'\)/, "supplier seeds");
  const page = slice(api, 'app.get("/opening-balance", async', 'app.post("/opening-balance/ap-exclude"');
  assert.equal((page.match(/WHERE isOpening = 1 AND status NOT IN \('DRAFT','CANCELLED'\)/g) ?? []).length, 2, "both seed lists");
  assert.doesNotMatch(api, /isOpening = 1 AND status != 'DRAFT'/);
});
