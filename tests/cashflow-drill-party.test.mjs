// ---------------------------------------------------------------------------
// cashflow-drill-party.test.mjs — owner 2026-09-30, on the Cash Flow drill:
// 「refer 2 是看 supplier 名字和 overall description 就好，不需要看每一张
// invoice 的 number」→「可以，做」.
//
// Ref. 2 = who the money went to / came from (supplier, other creditor,
// voucher payee, customer). Description = the overall description: the
// voucher's purpose when the payment went through a voucher, else the ledger
// text without its number, the name and "(edited)". The PIs / bills a
// payment settled are no longer in the column — they show on hover.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const ld = await import(pathToFileURL(resolve(process.cwd(), "src/lib/ledger-drill.ts")).href);
const api = readFileSync("src/api/routes/accounting.ts", "utf8").replace(/\r\n/g, "\n");
const ui = readFileSync("src/pages/accounting/index.tsx", "utf8").replace(/\r\n/g, "\n");
const slice = (src, from, to) => { const a = src.indexOf(from); assert.notEqual(a, -1, from); const b = src.indexOf(to, a + 1); return src.slice(a, b === -1 ? undefined : b); };

test("the overall description: no number, no name, no (edited)", () => {
  const t = ld.tidyDescription;
  assert.equal(t("Supplier payment HPV-2606-045", "HPV-2606-045", "INFAB CLASSIC INDUSTRIES SDN BHD"), "Supplier payment");
  assert.equal(t("Supplier payment (edited) · HPV-2607-027", "HPV-2607-027", "ALPHA SOFAS M SDN. BHD."), "Supplier payment");
  assert.equal(t("Receipt HOR-2606-008 · Houzs Century", "HOR-2606-008", "Houzs Century"), "Receipt");
  assert.equal(t("Receipt HOR-2606-008 (edited)", "HOR-2606-008", "Houzs Century"), "Receipt");
  assert.equal(t("Other creditor payment · HPV-2606-070 · Houzs Venture Holding Sdn Bhd", "HPV-2606-070", "Houzs Venture Holding Sdn Bhd"), "Other creditor payment");
  assert.equal(t("HPV-2608-030 · to ECMS", "HPV-2608-030", "ECMS"), "to ECMS", "nothing but 'to' left → the text without its number");
  assert.equal(t("Bank charges", null, null), "Bank charges");
});

test("Ref. 2 is the counterparty; the documents ride along for the hover; AP vouchers lend their purpose", () => {
  const fn = slice(api, "async function computeCashflowStatement(", 'app.get("/cashflow-statement"');
  assert.match(fn, /SELECT payment_no, purchase_invoice_id, supplier_name FROM supplier_payments WHERE payment_no IN/);
  assert.match(fn, /SELECT payment_no, bill_id, party_name FROM other_party_payments WHERE payment_no IN/);
  assert.match(fn, /SELECT id, customerName FROM payment_records WHERE id IN/, "a customer receipt names the customer");
  assert.match(fn, /SELECT pvNo, description FROM payment_vouchers WHERE pvNo IN/, "a payment made through a voucher takes its purpose");
  assert.match(fn, /ref2: who,/);
  assert.match(fn, /docs: kind \? docs\.get\(`\$\{kind\}::\$\{e\.sourceId\}`\) \?\? null : null,/);
  assert.match(fn, /const description = purpose \?\? tidyDescription\(legText, ref1, who\);/);
  assert.doesNotMatch(fn, /ref2\.set\(`sp::/, "the invoice list is not Ref. 2 any more");
});

test("the panel shows the name, and the documents only on hover", () => {
  const panel = slice(ui, "function CfDrillPanel(", "\nfunction ");
  assert.match(panel, /<span className="underline decoration-dotted cursor-help" title=\{it\.docs\}>\{it\.ref2 \|\| "—"\}<\/span>/);
});
