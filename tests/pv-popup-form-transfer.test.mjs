// ---------------------------------------------------------------------------
// pv-popup-form-transfer.test.mjs — finance plan batch 2 (owner 2026-10-01):
//   · the payment-voucher form is a popup in the layout he showed (HEADER /
//     LINES as cards), with Payee, PV #, Voucher date, Paid from, Description
//     (printed), Notes (internal), Bill no. + Bill date, no Product line;
//   · Payment | Transfer — a transfer between our own bank / cash accounts is
//     an ordinary voucher (「就 create 普通 pv」) whose one line is the account
//     that receives the money; Fund Transfer leaves the sidebar;
//   · single click on a list row does nothing; double-click pops the whole
//     voucher with its ledger entry and bank-statement state.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const tr = await import(pathToFileURL(resolve(process.cwd(), "src/lib/pv-transfer.ts")).href);

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const api = read("src/api/routes/accounting.ts");
const ui = read("src/pages/accounting/index.tsx");
const slice = (src, from, to) => { const a = src.indexOf(from); assert.notEqual(a, -1, from); const b = src.indexOf(to, a + 1); return src.slice(a, b === -1 ? undefined : b); };

const coa = new Map([
  ["310-0010", { specialAccountType: "SBK", isPostable: 1 }],
  ["320-0000", { specialAccountType: "SCH", isPostable: 1 }],
  ["310-0000", { specialAccountType: "SBK", isPostable: 0 }],
  ["900-R001", { specialAccountType: null, isPostable: 1 }],
]);

test("a transfer moves money between two of OUR bank / cash accounts", () => {
  const ok = tr.validatePvTransfer(coa, { payFrom: "310-0010", transferTo: "320-0000", amountSen: 50000, description: "Petty cash top-up" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.v.lines, [{ accountCode: "320-0000", description: "Petty cash top-up", amountSen: 50000 }], "the one line is the receiving account (DR)");
  assert.equal(ok.v.payFrom, "310-0010", "Paid from is credited");
  assert.equal(tr.validatePvTransfer(coa, { payFrom: "310-0010", transferTo: "320-0000", amountSen: 100 }).v.lines[0].description, "Transfer to 320-0000");
  const no = (body) => tr.validatePvTransfer(coa, body).ok;
  assert.equal(no({ payFrom: "310-0010", transferTo: "900-R001", amountSen: 100 }), false, "an expense account is not a transfer");
  assert.equal(no({ payFrom: "310-0010", transferTo: "310-0000", amountSen: 100 }), false, "a header account cannot receive");
  assert.equal(no({ payFrom: "310-0010", transferTo: "310-0010", amountSen: 100 }), false, "same account both sides");
  assert.equal(no({ payFrom: "310-0010", transferTo: "320-0000", amountSen: 0 }), false);
  assert.equal(no({ payFrom: "310-0010", transferTo: "320-0000", amountSen: 100, accrued: true }), false, "a transfer is never accrued");
});

test("all three write paths know a transfer; the voucher keeps notes, bill no. and bill date", () => {
  assert.match(api, /for \(const col of \["pv_kind TEXT", "party_kind TEXT", "party_id TEXT", "advance_sen INTEGER", "notes TEXT", "bill_no TEXT", "bill_date TEXT"\]\)/);
  const post = slice(api, 'app.post("/payment-vouchers", async (c) => {', 'app.put("/payment-vouchers/:id"');
  assert.match(post, /const isTransfer = body\.kind === PV_KIND_TRANSFER;/);
  assert.match(post, /const t = validatePvTransfer\(coa, body\);/);
  assert.match(post, /pv_kind, notes, bill_no, bill_date\n\s+\) VALUES/);
  assert.match(post, /isTransfer \? PV_KIND_TRANSFER : null, extra\.notes, extra\.billNo, extra\.billDate,/);
  const put = slice(api, 'app.put("/payment-vouchers/:id"', "// The four-tier ladder.");
  assert.match(put, /const isTransfer = String\(pv\.pvKind \?\? pv\.pv_kind \?\? ""\) === PV_KIND_TRANSFER;/, "the kind is fixed at birth");
  assert.match(put, /notes = \?, bill_no = \?, bill_date = \?, updated_at = \? WHERE id = \?/);
  const restate = slice(api, 'app.post("/payment-vouchers/:id/restate"', 'app.get("/doc-trail"');
  assert.match(restate, /const t = validatePvTransfer\(coa, body\);/);
  assert.match(restate, /notes = \?, bill_no = \?, bill_date = \?, status = 'POSTED'/);
});

test("GET /doc-trail: the document's visible legs and whether its bank lines are on a statement", () => {
  const ep = slice(api, 'app.get("/doc-trail"', 'app.get("/official-receipts"');
  assert.match(ep, /requirePermission\(c, "accounting", "read"\)/);
  assert.match(ep, /WHERE hidden = 0 AND sourceId = \? AND orgId = \? AND sourceType LIKE \?/);
  assert.match(ep, /SELECT matchedLegId, txnDate, description FROM bank_statement_lines WHERE matchedLegId IN/, "a direct match");
  assert.match(ep, /FROM bank_line_leg_splits s JOIN bank_statement_lines l ON l\.id = s\.line_id WHERE s\.leg_id IN/, "a split / group match");
  assert.match(api, /const DOC_TRAIL_FAMILIES = new Set\(\["payment_voucher", "supplier_payment", "other_party_payment", "fund_transfer"\]\);/);
});

test("the form is a popup: Payment | Transfer, the voucher's own fields, lines as cards", () => {
  const tab = slice(ui, "function PaymentsTab(", "// =============== TAB: OFFICIAL RECEIPT");
  assert.match(tab, /<div className="fixed inset-0 z-40 bg-black\/40 overflow-y-auto p-4" role="dialog" aria-modal="true">/);
  assert.match(tab, /\{m === "PAYMENT" \? "Payment" : "Transfer"\}/);
  for (const label of ["Transfer to *", "Payee *", "PV #", "Voucher date *", "Amount (MYR) *", "Bill date", "Account (debit) *"]) {
    assert.ok(tab.includes(`>${label}</label>`), `field ${label}`);
  }
  assert.match(tab, /Notes <span className="normal-case font-normal text-\[#9CA3AF\]">\(internal — not printed\)<\/span>/);
  assert.match(tab, /Description <span className="normal-case font-normal text-\[#9CA3AF\]">\(printed on the voucher\)<\/span>/);
  assert.doesNotMatch(tab, /Product line \(optional\)/, "no Product line");
  assert.match(tab, /<ScanPrefillButton label=\{pendingScanFiles\.length \? "Add another receipt \(OCR\)" : "Scan bill \(OCR\)"\} allDocs onResult=\{applyScan\} \/>/, "scan inside the form");
  // Save: a transfer sends its accounts and amount; a payment its lines and bill.
  assert.match(tab, /\? \{ \.\.\.common, kind: "TRANSFER", payFrom: form\.payFrom \|\| defaultBankCode\(bankCash\), transferTo: form\.transferTo, amountSen: transferSen \}/);
  assert.match(tab, /billNo: form\.billNo,\n\s+billDate: form\.billDate \|\| undefined,/);
  // A scanned bill: the voucher is dated today, the bill keeps its own no. and date.
  assert.match(tab, /date: new Date\(\)\.toISOString\(\)\.slice\(0, 10\),\n\s+billNo: docNos\.join\(", "\) \|\| f\.billNo,\n\s+billDate: d\.docDate \?\? f\.billDate,/);
});

test("the list: no single-click expand; transfers and old fund transfers are doors; the popup shows everything", () => {
  const tab = slice(ui, "function PaymentsTab(", "// =============== TAB: OFFICIAL RECEIPT");
  assert.doesNotMatch(tab, /expandedPv/);
  assert.match(tab, /<DocTrailBlock family="payment_voucher" sourceId=\{r\.id\} \/>/);
  assert.match(tab, /<DocTrailBlock family=\{g\.sp \? "supplier_payment" : g\.ft \? "fund_transfer" : "other_party_payment"\} sourceId=\{g\.no\} \/>/);
  assert.match(tab, /<DetailField label="Notes \(internal\)"/);
  assert.match(ui, /partyLabel: isTransfer \? "Transfer To" : "Pay To",/, "a transfer prints the receiving account");
  const side = read("src/components/layout/sidebar.tsx");
  assert.doesNotMatch(side, /\{ name: "Fund Transfer", href: "\/accounting\?tab=transfer"/, "the menu entry is gone");
  assert.match(ui, /\{tab === "transfer" && /, "the old page still answers its URL");
});
