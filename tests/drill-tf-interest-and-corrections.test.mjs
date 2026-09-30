// ---------------------------------------------------------------------------
// drill-tf-interest-and-corrections.test.mjs — measured on prod after the
// balance-sheet drill (#607/#609): the last lines without a Ref. 2 were
// trade-finance interest (P&L, balance sheet and cash flow), a PI edit's
// correction (its sourceId is `<PI id>:edit-<time>`, so the PI lookup missed
// it), and in the Cash Flow drill an official receipt and a JV. They now name
// their counterparty like every other line (owner 2026-09-30 「我想看 supplier
// 名字」/「Balance sheet 也要这样点开看」).
//
// The drills show the document's description instead of the ledger text, which
// hid what a correction is ("Void · PI …"); a correction now says it after the
// description ("Purchase invoice · void").
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const drill = await import(pathToFileURL(resolve(process.cwd(), "src/lib/ledger-drill.ts")).href);
const tf = await import(pathToFileURL(resolve(process.cwd(), "src/lib/trade-finance.ts")).href);

const api = readFileSync("src/api/routes/accounting.ts", "utf8").replace(/\r\n/g, "\n");
const slice = (src, from, to) => { const a = src.indexOf(from); assert.notEqual(a, -1, from); const b = src.indexOf(to, a + 1); return src.slice(a, b === -1 ? undefined : b); };

test("a correction entry says what it is; an ordinary posting says nothing", () => {
  const v = drill.drillVariant;
  assert.equal(v("supplier_payment_restate_rev:1727000000000", "HPV-2609-001"), "reversed on edit");
  // An edit's re-post hides the older legs, so it IS the document (345 lines
  // on prod carried a needless label before this).
  assert.equal(v("invoice_restate_post:1727000000000", "inv-1"), "");
  assert.equal(v("supplier_payment_restate_post:1727000000000", "HPV-2609-001"), "");
  assert.equal(v("purchase_invoice_restate_post", "pi-1"), "GL re-sync", "a PI's re-sync carries no stamp");
  assert.equal(v("purchase_invoice_unvoid", "pi-1"), "unvoid");
  assert.equal(v("payment_voucher_void", "pv-1"), "void");
  assert.equal(v("manual_reversal", "je-1"), "reversal");
  assert.equal(v("purchase_invoice", "pi-1:edit-1727000000000"), "edit adjustment");
  assert.equal(v("purchase_invoice", "pi-1"), "");
  assert.equal(v("supplier_payment", "HPV-2609-001"), "");
  assert.equal(v("tf_interest", "tfint-2026-09-02-PV-2607-002"), "");
});

test("one definition of the interest sourceId: the draw it belongs to", () => {
  assert.equal(tf.tfInterestDrawId("tfint-2026-09-02-PV-2607-002"), "PV-2607-002");
  assert.equal(tf.tfInterestDrawId("HPV-2609-001"), "HPV-2609-001", "anything else is left alone");
  const lib = readFileSync("src/lib/trade-finance.ts", "utf8");
  assert.match(lib, /const key = isInterest \? tfInterestDrawId\(l\.sourceId\) : l\.sourceId;/, "the draw maths reads the same definition");
});

test("P&L / balance-sheet lines: a PI edit finds its PI, interest names the lender", () => {
  const fn = slice(api, "async function buildDrillLines(", "\n}\n");
  assert.match(fn, /const id = l\.sourceId\.replace\(\/:edit-\\d\+\$\/, ""\);/);
  assert.match(fn, /chunked<Record<string, unknown>>\(\[\.\.\.piSourceIds\.keys\(\)\], \(ph\) => `SELECT id, piNo, poRef, supplier_invoice_no, supplierName FROM purchase_invoices WHERE id IN/);
  assert.match(fn, /for \(const sourceId of piSourceIds\.get\(String\(r\.id\)\) \?\? \[\]\) \{\n\s+setInfo\(isPi, sourceId, \{/);
  // Interest: the lender of the facility account on the same entry.
  assert.match(fn, /const lenderByAcct = new Map\(\(await getTfSources\(db\)\)\.map\(\(s\) => \[resolve\(s\.accountCode\), s\.lenderName\] as const\)\);/);
  assert.match(fn, /party: \(entryLegs\.get\(key\) \?\? \[\]\)\.map\(\(x\) => lenderByAcct\.get\(resolve\(x\.accountCode\)\) \?\? ""\)\.find\(Boolean\) \|\| null,/);
  assert.match(fn, /SELECT payment_no, supplier_name FROM supplier_payments WHERE payment_no IN \(\$\{ph\}\) AND org_id = \?/);
  assert.match(fn, /SELECT payment_no, party_name FROM other_party_payments WHERE payment_no IN/, "a draw that paid an other creditor");
  assert.match(fn, /docs: paid \? `Drawn to pay \$\{paid\}` : null,/);
  assert.match(fn, /const variant = drillVariant\(l\.sourceType, l\.sourceId\);/);
});

test("Cash Flow lines: official receipts, JVs and interest have their counterparty / description", () => {
  const fn = slice(api, "async function computeCashflowStatement(", 'app.get("/cashflow-statement"');
  assert.match(fn, /SELECT id, receivedFrom, description FROM official_receipts WHERE id IN/);
  assert.match(fn, /SELECT id, description FROM journal_entries WHERE id IN/);
  assert.match(fn, /: sourceType\.startsWith\("official_receipt"\) \? "or"\n\s+: sourceType\.startsWith\("tf_interest"\) \? "tf"\n\s+: sourceType === "manual" \|\| sourceType\.startsWith\("manual_"\) \? "jv" : "";/);
  assert.match(fn, /: kind === "or" \|\| kind === "jv" \? ownPurpose\.get\(`\$\{kind\}::\$\{e\.sourceId\}`\) : undefined;/);
  assert.match(fn, /const lender = \(byEntry\.get\(`\$\{e\.sourceType\}::\$\{e\.sourceId\}`\) \?\? \[\]\)\.map\(\(l\) => tfAccounts\.get\(l\.code\)\?\.lenderName \?\? ""\)\.find\(Boolean\) \?\? "";/);
  assert.match(fn, /if \(paid\) docs\.set\(`tf::\$\{e\.sourceId\}`, `Drawn to pay \$\{paid\}`\);/);
  assert.match(fn, /const variant = drillVariant\(e\.sourceType, e\.sourceId\);/);
});

test("a description that says nothing does not replace the ledger text", () => {
  const own = drill.ownDescription;
  assert.equal(own("Rental - Sep'26"), "Rental - Sep'26");
  assert.equal(own("  from "), null, "an official receipt keyed as 'from'");
  assert.equal(own("To"), null);
  assert.equal(own(""), null);
  assert.equal(own(null), null);
  assert.equal(own("from HONG LEONG"), "from HONG LEONG", "a real sentence stays");
  const fn = slice(api, "async function buildDrillLines(", "\n}\n");
  assert.match(fn, /header: ownDescription\(str\(r\.description\)\) \?\? "Official receipt" \}\);/, "an official receipt falls back to its kind");
  assert.match(fn, /header: ownDescription\(str\(r\.description\)\) \}\);/, "a voucher / JV falls back to the ledger text");
  const cf = slice(api, "async function computeCashflowStatement(", 'app.get("/cashflow-statement"');
  assert.match(cf, /ownDescription\(String\(r\.description \?\? ""\)\) \?\? "Official receipt"\);/);
  assert.doesNotMatch(cf, /const purpose = String\(r\.description \?\? ""\)\.trim\(\);/, "every voucher purpose goes through ownDescription");
});
