// ---------------------------------------------------------------------------
// pl-drill-like-cashflow.test.mjs — owner 2026-09-30: 「P&L 同理，我想看
// supplier 名字，p&L 点开要看的东西和 cash flow 一样」.
//
// The P&L drill now reads like the Cash Flow drill: Ref. 2 = who the document
// is with (customer / supplier / payee / other creditor / payer), the related
// documents on hover, Description = the document's overall description, one
// Amount column in the line's own direction, month blocks with a total each
// when the period spans months.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const api = readFileSync("src/api/routes/accounting.ts", "utf8").replace(/\r\n/g, "\n");
const ui = readFileSync("src/pages/accounting/index.tsx", "utf8").replace(/\r\n/g, "\n");
const slice = (src, from, to) => { const a = src.indexOf(from); assert.notEqual(a, -1, from); const b = src.indexOf(to, a + 1); return src.slice(a, b === -1 ? undefined : b); };

test("Ref. 2 is the counterparty for every kind of document; the related documents ride along", () => {
  const ep = slice(api, 'app.get("/pl-drill"', 'app.get("/pl-monthly"');
  assert.match(ep, /party: str\(r\.customerName \?\? r\.customer_name\) \|\| null,\n\s+docs: so \?\? /, "invoice → customer; its SO on hover");
  assert.match(ep, /party: str\(r\.supplierName \?\? r\.supplier_name\) \|\| null,/, "PI → supplier");
  assert.match(ep, /SELECT id, pvNo, payee, description FROM payment_vouchers WHERE id IN/, "voucher → payee + its purpose");
  assert.match(ep, /SELECT billNo, partyName, referenceNo, description FROM other_party_bills WHERE billNo IN/, "bill → other creditor");
  assert.match(ep, /SELECT id, description FROM journal_entries WHERE id IN/, "JV → its own description");
  assert.match(ep, /\[\[isCn, "credit_notes", "Credit note"\], \[isDn, "debit_notes", "Debit note"\]\]/);
  assert.match(ep, /SELECT id, receivedFrom, description FROM official_receipts WHERE id IN/, "official receipt → payer");
  assert.match(ep, /description: r\?\.header \?\? tidyDescription\(l\.description, ref1, party\),/);
  assert.match(ep, /ref2: party,\n\s+docs: r\?\.docs \?\? null,/);
  assert.match(ep, /header: "Sales invoice",/);
  assert.match(ep, /header: "Purchase invoice",/);
});

test("the panel: one Amount column in the line's direction, month blocks, the related documents on hover", () => {
  const panel = slice(ui, "function PlDrillPanel(", "function PLStatementTab(");
  assert.match(panel, /const creditNormal = data\?\.account\?\.type === "REVENUE";/);
  assert.match(panel, /const signed = \(debitSen: number, creditSen: number\) => \(creditNormal \? creditSen - debitSen : debitSen - creditSen\);/);
  assert.doesNotMatch(panel, />Debit<\/th>|>Credit<\/th>/, "the two money columns are back");
  assert.match(panel, /const byMonth = months\.length > 1;/);
  assert.match(panel, /<td className="py-1" colSpan=\{5\}>\{drillMonthLabel\(m\)\} total<\/td>/);
  assert.match(panel, /<span className="underline decoration-dotted cursor-help" title=\{l\.docs\}>\{l\.ref2 \|\| "—"\}<\/span>/);
  assert.match(panel, /shortBankName\(o\.name\) \|\| o\.code/, "other side by short name, full on hover");
  // Report-layer rows keep their own lines, in the same direction.
  assert.match(panel, /const sen = creditNormal \? -e\.sen : e\.sen;/);
});
