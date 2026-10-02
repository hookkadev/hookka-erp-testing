// ---------------------------------------------------------------------------
// pl-inline-drill.test.mjs — owner 2026-09-29 「我要点开看 detail，就是这样」
// (a screenshot of the Houzs P&L with one account line opened: Date,
// Description, Other side, Ref. 1, Ref. 2, Debit, Credit).
//
// Click an account line's name on the P&L → its ledger lines for the period
// open underneath. The lines come from the SAME pass as the statement
// (glWindowSigned with a trace), so they sum to the line; report-layer
// additions (payroll from payslips not yet posted, the opening month's share)
// show as their own rows.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const lib = await import(pathToFileURL(resolve(process.cwd(), "src/lib/ledger-drill.ts")).href);

const api = readFileSync("src/api/routes/accounting.ts", "utf8").replace(/\r\n/g, "\n");
const ui = readFileSync("src/pages/accounting/index.tsx", "utf8").replace(/\r\n/g, "\n");
const slice = (src, from, to) => { const a = src.indexOf(from); assert.notEqual(a, -1, from); const b = src.indexOf(to, a + 1); return src.slice(a, b === -1 ? undefined : b); };

test("Ref. 1 is the document number the posting wrote into the description", () => {
  assert.equal(lib.docNoFromDescription("Sales · invoice INV-2609-011"), "INV-2609-011");
  assert.equal(lib.docNoFromDescription("JV JE-2609-0001"), "JE-2609-0001");
  assert.equal(lib.docNoFromDescription("HPV-2609-016 · Electric Bill For July'26"), "HPV-2609-016");
  assert.equal(lib.docNoFromDescription("Other creditor bill · OCB-2609-004 · GALLERY"), "OCB-2609-004");
  assert.equal(lib.docNoFromDescription("Bank charges"), null);
  assert.equal(lib.docNoFromDescription(null), null);
});

test("Other side = the opposite side of the same entry, own account left out, largest first", () => {
  const cr = { accountCode: "500-0000", debitSen: 0, creditSen: 10000 };
  // A sales invoice: CR sales + CR SST output, DR trade debtors.
  const inv = [{ accountCode: "300-0000", debitSen: 10600, creditSen: 0 }, cr, { accountCode: "350-0000", debitSen: 0, creditSen: 600 }];
  assert.deepEqual(lib.otherSideCodes(cr, inv), ["300-0000"], "a credit's other side is the debits only");
  // A voucher paying two expenses: the bank leg's other side is both expenses, biggest first.
  const bank = { accountCode: "310-0010", debitSen: 0, creditSen: 5000 };
  const pv = [bank, { accountCode: "900-W001", debitSen: 1000, creditSen: 0 }, { accountCode: "900-O001", debitSen: 4000, creditSen: 0 }];
  assert.deepEqual(lib.otherSideCodes(bank, pv), ["900-O001", "900-W001"]);
  // Old codes resolve before comparing, so an alias of the own account never shows as its other side.
  const alias = [{ accountCode: "OLD-500", debitSen: 0, creditSen: 100 }, { accountCode: "300-0000", debitSen: 100, creditSen: 0 }];
  assert.deepEqual(lib.otherSideCodes({ accountCode: "500-0000", debitSen: 0, creditSen: 100 }, alias, (c) => (c === "OLD-500" ? "500-0000" : c)), ["300-0000"]);
  // Nothing on the opposite side (a same-side reclass) → every other leg.
  const same = [{ accountCode: "900-A", debitSen: 100, creditSen: 0 }, { accountCode: "900-B", debitSen: -100, creditSen: 0 }];
  assert.deepEqual(lib.otherSideCodes(same[0], same), ["900-B"]);
});

test("month label as the P&L names months", () => {
  assert.equal(lib.monthLabel("2026-09"), "Sep'26");
  assert.equal(lib.monthLabel("2026-05"), "May'26");
  assert.equal(lib.monthLabel("bad"), "bad");
});

test("the statement's own pass does the tracing, so the drill sums to the line", () => {
  const gw = slice(api, "async function glWindowSigned(", "// loadMaterialCost (F6 T4b)");
  assert.match(gw, /\n  trace\?: PnlTrace,\n\): Promise</);
  assert.match(gw, /const cached = trace \? undefined : dc\.glMemo\?\.get\(memoKey\);/, "a traced call never reads the memo");
  assert.match(gw, /if \(!trace\) dc\.glMemo\?\.set\(memoKey, out\);/, "…nor writes it");
  // The leg is traced right where it is added to the account's figure.
  assert.match(gw, /net\.set\(code, \(net\.get\(code\) \?\? 0\) \+ \(Number\(l\.debitSen\) \|\| 0\) - \(Number\(l\.creditSen\) \|\| 0\)\);\n    if \(trace && code === trace\.account\) \{\n      trace\.legs\.push\(\{/);
  // Payroll injected from payslips and the opening-month slice are traced as their own rows.
  assert.match(gw, /net\.set\(account, \(net\.get\(account\) \?\? 0\) \+ sen\);\n      if \(trace && account === trace\.account && sen !== 0\) trace\.extra\.push\(\{ kind: "payroll", ym, sen \}\);/);
  assert.match(gw, /const slice = trace \? \(net\.get\(trace\.account\) \?\? 0\) - before : 0;/);
  assert.match(gw, /trace\.extra\.push\(\{ kind: "opening_slice", ym: obDate\.slice\(0, 7\), sen: slice \}\);/);
});

test("GET /pl-drill: read permission, same period window, refs, other side, tie flag", () => {
  const ep = slice(api, 'app.get("/pl-drill"', 'app.get("/pl-monthly"');
  assert.match(ep, /requirePermission\(c, "accounting", "read"\)/);
  assert.match(ep, /const startYm = ranged \? fromQ : periodStartYm\(period\);\n  const endYm = ranged \? toQ : periodEndYm\(period\);/, "the statement's own window, or the Monthly P&L's run of months (2026-10-01)");
  assert.match(ep, /const ranged = ymRe\.test\(fromQ\) && ymRe\.test\(toQ\) && fromQ <= toQ;/);
  assert.match(ep, /selectHistoricalWindow\(historical, openingMonth, startYm, "all"\)/, "a month from the old books says so");
  assert.match(ep, /await glWindowSigned\(db, orgId, startYm, endYm, dc, trace\);/);
  // The lines come from the builder shared with the balance-sheet drill (2026-09-30).
  assert.match(ep, /const lines = await buildDrillLines\(db, orgId, trace\.legs, trace\.entryLegs, resolve, coa\);/);
  assert.match(ep, /tied: debitSen - creditSen === netSen,/);
  // Since 2026-09-30 (owner 「p&L 点开要看的东西和 cash flow 一样」): Ref. 2 = the
  // counterparty; the SO / supplier invoice no. moved to the hover (docs).
  const lines = slice(api, "async function buildDrillLines(", "\n}\n");
  assert.match(lines, /SELECT id, invoiceNo, salesOrderId, doNo, customerName FROM invoices WHERE id IN/);
  assert.match(lines, /SELECT id, companySOId FROM sales_orders WHERE id IN/, "an invoice's SO rides along for the hover");
  assert.match(lines, /SELECT id, piNo, poRef, supplier_invoice_no, supplierName FROM purchase_invoices WHERE id IN/);
  assert.match(lines, /r\.supplierInvoiceNo \?\? r\.supplier_invoice_no/, "dual-key read of the snake_case column");
  assert.match(lines, /const ref1 = docNoFromDescription\(l\.description\) \?\? r\?\.ref1 \?\? l\.sourceId;/);
  assert.match(lines, /otherSide: otherSideCodes\(l, entryLegs\.get\(key\) \?\? \[\], resolve\)/);
});

test("computed lines that ARE one account's ledger figure open too, without joining the edit-mode drag", () => {
  const rows = slice(api, "function buildPnlRows(", "\n}\n");
  assert.match(rows, /line\("PURCHASE", 3, pg\.purchasesSen, yg\?\.purchasesSen \?\? 0, undefined, undefined, pg\.group\);/);
  assert.match(rows, /line\("CARRIAGE INWARDS", 1, p\.carriageSen, y\.carriageSen, undefined, undefined, "700-1015"\);/);
  assert.match(rows, /line\("SST CHARGES", 1, p\.sstSen, y\.sstSen, undefined, undefined, "706-0000"\);/);
});

test("the P&L: name opens the lines under the row (not in edit mode); the panel shows its columns", () => {
  const tab = slice(ui, "function PLStatementTab(", "\nfunction ");
  assert.match(tab, /const drillCode = row\.drillCode \?\? row\.accountCode;/);
  assert.match(tab, /const canDrill = !edit && !!drillCode;/, "edit mode keeps the row for dragging");
  assert.match(tab, /const drillKey = drillCode \? `\$\{period\}\|\$\{drillCode\}` : "";/, "a new period starts closed");
  assert.match(tab, /<tr><td colSpan=\{5\} className="p-0"><PlDrillPanel period=\{period\} account=\{drillCode\} line=\{line\} \/><\/td><\/tr>/);
  const panel = slice(ui, "function PlDrillPanel(", "function PLStatementTab(");
  assert.match(panel, /fetch\(`\/api\/accounting\/pl-drill\?period=\$\{encodeURIComponent\(period\)\}&account=\$\{encodeURIComponent\(account\)\}`\)/);
  for (const h of ["Date", "Description", "Other side", "Ref. 1", "Ref. 2", "Amount"]) assert.ok(panel.includes(`>${h}</th>`), `column ${h}`);
  assert.match(panel, /from the payslips, not posted to the ledger yet/);
  assert.match(panel, /Opening balance: this month's share/);
});
