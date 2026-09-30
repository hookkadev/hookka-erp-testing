// ---------------------------------------------------------------------------
// ledger-source-links.test.mjs — a ledger line's source link opens the
// document itself where there is a page for it (owner 2026-09-29 「直接点开
// invoice，而不是跳去 purchase invoice list」, first fixed on AP Invoices in
// #559; the General Ledger's source links still sent a purchase invoice to the
// list, and a supplier payment to the PI list).
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const ui = readFileSync("src/pages/accounting/index.tsx", "utf8").replace(/\r\n/g, "\n");
const fn = ui.slice(ui.indexOf("function sourceHref("), ui.indexOf("\n}\n", ui.indexOf("function sourceHref(")));

test("a purchase invoice leg opens that invoice; a supplier payment opens the supplier-payment page", () => {
  assert.match(fn, /case "purchase_invoice":\n      return `\/procurement\/pi\/\$\{encodeURIComponent\(sourceId\)\}`;/);
  assert.match(fn, /case "supplier_payment":\n      return "\/invoices\/supplier-payments";/);
  assert.doesNotMatch(fn, /return "\/procurement\/pi";/, "no source link lands on the PI list any more");
  // Sales invoices already opened themselves.
  assert.match(fn, /return `\/invoices\/\$\{sourceId\}`;/);
});
