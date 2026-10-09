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
  assert.match(lib, /const key = kind \? tfInterestDrawId\(l\.sourceId\) : l\.sourceId;/, "the draw maths reads the same definition");
  // DEV-63: bank charges share the definition under their own `tfbc-` prefix.
  assert.equal(tf.tfInterestDrawId("tfbc-2026-10-09-PV-2607-002"), "PV-2607-002");
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
  assert.match(fn, /for \(const \[id, r\] of await officialReceiptTexts\(c\.var\.DB, orIds\)\) \{/);
  assert.match(fn, /SELECT id, description FROM journal_entries WHERE id IN/);
  assert.match(fn, /: sourceType\.startsWith\("official_receipt"\) \? "or"\n\s+: tfChargeKind\(sourceType\) \? "tf"\n\s+: sourceType === "manual" \|\| sourceType\.startsWith\("manual_"\) \? "jv" : "";/);
  assert.match(fn, /: kind === "or" \|\| kind === "jv" \? ownPurpose\.get\(`\$\{kind\}::\$\{e\.sourceId\}`\) : undefined;/);
  assert.match(fn, /const lender = \(byEntry\.get\(`\$\{e\.sourceType\}::\$\{e\.sourceId\}`\) \?\? \[\]\)\.map\(\(l\) => tfAccounts\.get\(l\.code\)\?\.lenderName \?\? ""\)\.find\(Boolean\) \?\? "";/);
  assert.match(fn, /if \(paid\) docs\.set\(`tf::\$\{e\.sourceId\}`, `Drawn to pay \$\{paid\}`\);/);
  assert.match(fn, /const variant = drillVariant\(e\.sourceType, e\.sourceId\);/);
});

test("BUG-2026-09-30-228: a receipt reads its note, else its lines, never a lone 'from'", () => {
  // The receipt's header note was empty and its text sat on its line; the
  // drill fell back to the ledger text "<no> · from <payer>", took the payer
  // out (it is Ref. 2) and left "from".
  assert.equal(drill.tidyDescription("HOR-2609-003 · from THE BANK", "HOR-2609-003", "THE BANK"), "from THE BANK", "never a lone 'from'");
  assert.equal(drill.tidyDescription("HPV-2608-030 · to A SUPPLIER", "HPV-2608-030", "A SUPPLIER"), "to A SUPPLIER", "nor a lone 'to'");
  assert.equal(drill.ownDescription("  Rental - Sep'26 "), "Rental - Sep'26");
  assert.equal(drill.ownDescription("   "), null);
  assert.equal(drill.ownDescription(null), null);
  const helper = slice(api, "async function officialReceiptTexts(", "\n}\n");
  assert.match(helper, /SELECT receiptId, description FROM official_receipt_lines WHERE receiptId IN \(\$\{ph\}\) ORDER BY lineOrder/);
  assert.match(helper, /const id = String\(r\.receiptId \?\? r\.receipt_id \?\? ""\)/, "dual-key read");
  assert.match(helper, /text: ownDescription\(String\(r\.description \?\? ""\)\) \?\? \(lineText\.get\(id\)\?\.join\(" · "\) \|\| "Official receipt"\),/, "note, else the lines, else the kind");
  assert.match(helper, /\} catch \{ \/\* the header note, or the kind \*\/ \}/, "a failed line read keeps the rest");
  const fn = slice(api, "async function buildDrillLines(", "\n}\n");
  assert.match(fn, /header: ownDescription\(str\(r\.description\)\) \}\);/, "a voucher / JV without a description keeps the ledger text");
  const cf = slice(api, "async function computeCashflowStatement(", 'app.get("/cashflow-statement"');
  assert.match(cf, /setOnce\(ownPurpose, `or::\$\{id\}`, r\.text\);/);
  assert.doesNotMatch(cf, /const purpose = String\(r\.description \?\? ""\)\.trim\(\);/, "every voucher purpose goes through ownDescription");
});
