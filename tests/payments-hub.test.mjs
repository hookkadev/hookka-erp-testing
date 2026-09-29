// ---------------------------------------------------------------------------
// payments-hub.test.mjs — owner 2026-09-28 「other creditor 的 payment 没出现在
// payment voucher?」: the Payment Vouchers list merges every money-out door.
//
// Measured on prod that day: 96 vouchers on the page, 42 other-creditor
// payments (RM 338,498.00) and 113 supplier payments invisible on it — all
// minted from the same counter (HPV-YYMM-nnn). One numbering book, three
// lists. The hub is READ-SIDE: no engine, no write path, no recorded entry
// touched; each foreign row prints / voids through its own document's endpoint.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const ui = readFileSync("src/pages/accounting/index.tsx", "utf8").replace(/\r\n/g, "\n");
const spPage = readFileSync("src/pages/invoices/supplier-payments.tsx", "utf8").replace(/\r\n/g, "\n");
const lib = readFileSync("src/lib/supplier-payment-voucher.ts", "utf8").replace(/\r\n/g, "\n");
const block = (from, to) => { const a = ui.indexOf(from); assert.notEqual(a, -1, from); const b = ui.indexOf(to, a + 1); return ui.slice(a, b === -1 ? undefined : b); };
const merge = block("function buildPayRows(", "// The settled-bills detail block");
const tab = block("function PaymentsTab(", "// =============== TAB: OFFICIAL RECEIPT");

test("the three doors are read and merged into one list, newest first", () => {
  // The two foreign doors load with the vouchers, cache-busted like the Receipts hub.
  assert.match(tab, /fetch\(`\/api\/supplier-payments\?\$\{bust\}`, \{ cache: "no-store" \}\)/);
  assert.match(tab, /fetch\(`\/api\/accounting\/other-party-payments\?type=CREDITOR&\$\{bust\}`, \{ cache: "no-store" \}\)/);
  assert.match(tab, /const payRows = useMemo\(\(\) => buildPayRows\(rows, spRows, ocpRows\), \[rows, spRows, ocpRows\]\);/);
  assert.match(merge, /return rows\.sort\(\(a, b\) => b\.date\.localeCompare\(a\.date\) \|\| b\.no\.localeCompare\(a\.no\)\);/);
  // The list waits for all three — a half-loaded merge would read as "missing".
  assert.match(tab, /const payLoading = rows === null \|\| spRows === null \|\| ocpRows === null;/);
});

test("an AP voucher's settlement document is listed once, as the voucher", () => {
  // The settlement written at APPROVE carries paymentNo = pvNo — the same
  // payment seen from the other side. Skip it in both foreign loops.
  assert.match(merge, /const pvNos = new Set\(\(pv \?\? \[\]\)\.map\(\(r\) => r\.pvNo\)\.filter\(Boolean\)\);/);
  assert.equal((merge.match(/if \(pvNos\.has\(g\.paymentNo\)\) continue;/g) ?? []).length, 2, "supplier AND other-creditor loops both dedupe");
});

test("foreign rows carry their door badge and read as Approved / Cancelled on the existing chips", () => {
  assert.match(ui, /type PayDoor = "PV" \| "AP" \| "SP" \| "OCP";/);
  assert.match(merge, /door: "SP", key: `s:\$\{g\.paymentNo\}`/);
  assert.match(merge, /door: "OCP", key: `o:\$\{g\.paymentNo\}`/);
  // No new chip set: a foreign door posts on save → Approved; voided → Cancelled.
  assert.match(tab, /return \(row\.state !== "ACTIVE" \? "CANCELLED" : row\.pv \? chipOf\(row\.pv\) : "APPROVED"\) === chip;/);
  // Advance open covers a supplier payment's unapplied advance too.
  assert.match(ui, /const spAdvanceOpenSen = \(g: SupplierPaymentGroup\) =>\s*\n\s*g\.lines\.filter\(\(l\) => !l\.purchaseInvoiceId && l\.amountSen > 0\)/);
});

test("a foreign row prints, opens and voids through ITS OWN document — never the voucher endpoints", () => {
  assert.match(tab, /: row\.sp \? buildSupplierPaymentVoucher\(row\.sp\)\s*\n\s*: buildOtherPartyPaymentVoucher\(row\.ocp!, accounts\);/);
  assert.match(tab, /\? `\/api\/supplier-payments\/\$\{encodeURIComponent\(row\.no\)\}\/lifecycle`\s*\n\s*: `\/api\/accounting\/other-party-payments\/\$\{encodeURIComponent\(row\.no\)\}\/lifecycle`;/);
  assert.match(tab, /const foreignHref = \(row: PayRow\) => row\.sp \? "\/invoices\/supplier-payments" : "\/accounting\?tab=ocreditorpay";/);
  // Double-click opens the shared shell; single click still expands.
  assert.match(tab, /onClick=\{\(\) => setExpandedPv\(\(m\) => \(\{ \.\.\.m, \[g\.key\]: !m\[g\.key\] \}\)\)\}\s*\n\s*onDoubleClick=\{\(\) => setDetailPayKey\(g\.key\)\}/);
  assert.match(tab, /title=\{`\$\{PAY_DOOR_LABEL\[g\.door\]\} \$\{g\.no\}`\}/);
});

test("the ladder, edit and attachments stay voucher-only; batch print / export cover every door", () => {
  // A ticked foreign row never reaches the approval batch.
  assert.match(tab, /const ids = pvSel\.selectedRows\.map\(\(r\) => r\.pv\?\.id\)\.filter\(\(id\): id is string => !!id\);/);
  assert.match(tab, /const sel = pvSel\.selectedRows\.map\(\(x\) => x\.pv\)\.filter\(\(x\): x is PvRow => !!x\);/);
  assert.match(tab, /onPrint=\{\(\) => printVouchers\(pvSel\.selectedRows\.map\(payVoucherOf\)\)\}/);
  assert.match(tab, /\["Door", "PV No", "Date", "Pay To", "Paid From", "Status", "Remarks", "Product Line", "Voucher Total \(RM\)"/);
  // Selection is keyed by the hub row, so a voucher and a foreign row never collide.
  assert.match(tab, /const pvSel = useRowSelection\(visibleRows, \(r\) => r\.key\);/);
});

// Owner 2026-09-28 「supplier payment 也没记银行户口?那怎么对账」: the table
// keeps no bank column; the ledger's CR leg is the record (reconciliation
// already reads it). GET /api/supplier-payments now surfaces that leg as
// `bankAccount`, and the hub shows it as "Paid From".
test("a supplier payment's bank is read from its ledger CR leg — newest, never the AP control / FX account", () => {
  const api = readFileSync("src/api/routes/supplier-payments.ts", "utf8").replace(/\r\n/g, "\n");
  const get = api.slice(api.indexOf('app.get("/", async (c) => {'), api.indexOf("\napp.post(", api.indexOf('app.get("/", async (c) => {')));
  assert.match(get, /SELECT sourceId, accountCode, postedAt FROM ledger_journal_entries\s*\n\s*WHERE orgId = \? AND hidden = 0 AND creditSen > 0\s*\n\s*AND sourceType LIKE 'supplier_payment%'\s*\n\s*AND accountCode NOT IN \(\?, \?\)\s*\n\s*ORDER BY postedAt DESC/);
  assert.match(get, /\.bind\(orgId, AP_CONTROL, FX_GAIN_ACCT\)/);
  // First seen per payment = newest leg (a restate re-posts; a void reverses with a DR leg, which creditSen > 0 excludes).
  assert.match(get, /if \(no && !bankByNo\.has\(no\)\) bankByNo\.set\(no, String\(l\.accountCode \?\? l\.account_code \?\? ""\)\);/);
  assert.match(get, /for \(const g of groups\) g\.bankAccount = bankByNo\.get\(g\.paymentNo\) \?\? null;/);
  assert.match(merge, /via: g\.bankAccount \?\? ""/);
  // A payment with no bank leg (contra) is the only one a bank pick hides — and it says so.
  assert.match(tab, /const bankHiddenSp = bankFilter \? payRows\.filter\(\(r\) => r\.door === "SP" && !r\.via\)\.length : 0;/);
  assert.match(tab, /supplier payment\{bankHiddenSp === 1 \? "" : "s"\} hidden — no bank leg on their ledger posting/);
});

test("one supplier-payment voucher builder, in a lib, used by both pages", () => {
  assert.match(lib, /export function buildSupplierPaymentVoucher\(p: SupplierPaymentVoucherInput\): VoucherSpec/);
  assert.match(lib, /"SUPPLIER PAYMENT VOUCHER — VOID"/);
  // An advance line has no PI — it prints as such, never as a blank cell.
  assert.match(lib, /l\.piNo \|\| "Advance \/ unallocated"/);
  assert.match(spPage, /import \{ buildSupplierPaymentVoucher \} from "@\/lib\/supplier-payment-voucher";/);
  assert.doesNotMatch(spPage, /function buildSupplierPaymentVoucher\(/, "the page's local copy is gone");
  assert.match(ui, /import \{ buildSupplierPaymentVoucher \} from "@\/lib\/supplier-payment-voucher";/);
});
