// ---------------------------------------------------------------------------
// receipts-hub.test.mjs — Receipts 三门合一 (owner 2026-09-22): accounting ›
// Receipts is ONE door for money in — customer receipts (settle sales
// invoices), other-debtor receipts (settle other-debtor bills) and official
// receipts (sundry income) — with one merged list. The three documents and
// their engines are untouched; the hub hosts the three forms and routes each
// row's print / void to its own endpoint.
//
// Pins:
//   · the Customer Payment page and the hub render the SAME form component
//     (CustomerReceiptForm, exported from the page module) — no second copy
//     of the allocation / advance logic;
//   · the other-party settle form is one component used by both the Other
//     Creditor Payments / Other Debtor Receipts managers and the hub;
//   · each kind voids through its own lifecycle endpoint;
//   · the customer voucher / advance helpers live in one lib.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const ui = read("src/pages/accounting/index.tsx");
const page = read("src/pages/invoices/payments.tsx");
const lib = read("src/lib/customer-receipt.ts");

const block = (src, from, to) => {
  const a = src.indexOf(from);
  assert.notEqual(a, -1, `${from} not found`);
  const b = src.indexOf(to, a + 1);
  return src.slice(a, b === -1 ? undefined : b);
};

test("three doors, one list: the hub is what the Receipts tab renders", () => {
  assert.match(ui, /\{tab === "receipts" && <ReceiptsHubTab accounts=\{accounts\} \/>\}/);
  assert.doesNotMatch(ui, /function ReceiptsTab\(/, "the old single-door tab is gone, not left dead");
  const hub = block(ui, "function ReceiptsHubTab(", "// =============== TAB: FUND TRANSFER");
  for (const label of ["New Customer Receipt", "New Other Debtor Receipt", "New Official Receipt"]) {
    assert.match(hub, new RegExp(`> ${label}</Button>`), `door "${label}" missing`);
  }
  assert.match(hub, /fetch\(`\/api\/payments\?\$\{bust\}`/);
  assert.match(hub, /fetch\(`\/api\/accounting\/other-party-payments\?type=DEBTOR&\$\{bust\}`/);
  assert.match(hub, /fetch\(`\/api\/accounting\/official-receipts\?\$\{bust\}`/);
  const chips = block(ui, "const RECEIPT_CHIPS", "function ReceiptsHubTab(");
  for (const k of ['"CUSTOMER"', '"OTHER"', '"OFFICIAL"', '"CANCELLED"']) assert.match(chips, new RegExp(`\\{ key: ${k}, label:`));
});

test("one customer-receipt form, rendered by the page AND the hub", () => {
  assert.match(page, /export function CustomerReceiptForm\(\{ editing, onSaved, onCancelEdit \}/);
  assert.match(page, /<CustomerReceiptForm\s+key=\{editing\?\.id \?\? "new"\}/);
  const hub = block(ui, "function ReceiptsHubTab(", "// =============== TAB: FUND TRANSFER");
  assert.match(hub, /<CustomerReceiptForm key=\{custEditing\?\.id \?\? "new"\} editing=\{custEditing\} onSaved=\{reload\} onCancelEdit=\{closeDoor\} \/>/);
  // The allocation logic exists once, in the form.
  assert.equal((page.match(/const canSubmit = !!selectedCustomerId && receivedSen > 0 && !overAllocated && !receivedUnreadable;/g) ?? []).length, 1);
  assert.doesNotMatch(hub, /canSubmit|editBaseline/);
});

test("one other-party settle form, used by the managers and the hub", () => {
  assert.match(ui, /function OtherPartyPaymentForm\(\{ parties, accounts, side, editing, onSaved, onCancelEdit \}/);
  const mgr = block(ui, "function OtherPartyPaymentsManager(", "// =============== TAB: GENERAL LEDGER");
  assert.match(mgr, /<OtherPartyPaymentForm\s+key=\{editing\?\.paymentNo \?\? "new"\}/);
  assert.doesNotMatch(mgr, /allocMoneyError|loadOpenBills/, "the manager no longer carries its own form logic");
  const hub = block(ui, "function ReceiptsHubTab(", "// =============== TAB: FUND TRANSFER");
  assert.match(hub, /<OtherPartyPaymentForm key=\{odEditing\?\.paymentNo \?\? "new"\} parties=\{parties\} accounts=\{accounts\} side="DEBTOR"/);
  assert.equal((ui.match(/if \(allocMoneyError\)/g) ?? []).length, 1, "exactly one allocation refusal gate");
});

test("each kind voids through its own document's endpoint", () => {
  const hub = block(ui, "function ReceiptsHubTab(", "// =============== TAB: FUND TRANSFER");
  assert.match(hub, /`\/api\/payments\/\$\{encodeURIComponent\(r\.cust\.id\)\}\/lifecycle`/);
  assert.match(hub, /`\/api\/accounting\/other-party-payments\/\$\{encodeURIComponent\(r\.od\.paymentNo\)\}\/lifecycle`/);
  assert.match(hub, /`\/api\/accounting\/official-receipts\/\$\{r\.or!\.id\}\/lifecycle`/);
  // Official receipts have no in-place edit — only customer / other-debtor rows offer it.
  assert.match(hub, /r\.lifecycleState === "ACTIVE" && \(r\.cust \|\| r\.od\) && \(/);
});

test("the customer voucher / advance helpers live in one lib, used by both pages", () => {
  assert.match(lib, /export function unallocatedSen\(/);
  assert.match(lib, /export function hasUnallocated\(/);
  assert.match(lib, /export function buildCustomerPaymentVoucher\(/);
  assert.match(page, /import \{ buildCustomerPaymentVoucher, hasUnallocated, unallocatedSen \} from "@\/lib\/customer-receipt";/);
  assert.match(ui, /import \{ buildCustomerPaymentVoucher, hasUnallocated, unallocatedSen \} from "@\/lib\/customer-receipt";/);
  assert.doesNotMatch(page, /\nfunction buildCustomerPaymentVoucher\(/);
});
