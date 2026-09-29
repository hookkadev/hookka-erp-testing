// ---------------------------------------------------------------------------
// cashflow-inline-drill.test.mjs — owner 2026-09-29 「cash flow 也要这样点开看」
// (after the P&L inline drill, #586).
//
// Click a Cash Flow line's name → the payments / receipts behind it open under
// the row. The engine records, per line, every leg that fed it (and the share
// it put there when a payment is split across materials or departments); the
// caller turns those into rows with date, description, bank, Ref. 1 / Ref. 2.
// Same computation as the statement, so a month's rows sum to the figure.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const cf = await import(pathToFileURL(resolve(process.cwd(), "src/lib/cashflow-engine.ts")).href);

const api = readFileSync("src/api/routes/accounting.ts", "utf8").replace(/\r\n/g, "\n");
const ui = readFileSync("src/pages/accounting/index.tsx", "utf8").replace(/\r\n/g, "\n");
const slice = (src, from, to) => { const a = src.indexOf(from); assert.notEqual(a, -1, from); const b = src.indexOf(to, a + 1); return src.slice(a, b === -1 ? undefined : b); };

const acct = (code, type, name, parentCode = null, sat = null) => ({ code, name, type, sat, parentCode });
const coa = new Map([
  ["310-0010", acct("310-0010", "ASSET", "CASH AT BANK", null, "SBK")],
  ["400-0000", acct("400-0000", "LIABILITY", "TRADE CREDITORS", null, "SCC")],
  ["900-W001", acct("900-W001", "EXPENSE", "WATER & ELECTRICITY")],
  ["310-0020", acct("310-0020", "LIABILITY", "TRADE FINANCE - LENDER")],
]);
const leg = (accountCode, debitSen, creditSen, ym, sourceType, sourceId, lineLabel) => ({ accountCode, debitSen, creditSen, ym, sourceType, sourceId, ...(lineLabel ? { lineLabel } : {}) });
const input = (trace) => ({
  classified: [
    // A supplier payment of 1,000.01 settling a PI that is 2/3 fabric, 1/3 filler.
    leg("400-0000", 100001, 0, "2026-09", "supplier_payment", "HPV-2609-001"),
    // Electricity, paid in two months.
    leg("900-W001", 38153, 0, "2026-09", "payment_voucher", "pv-a"),
    leg("900-W001", 13815, 0, "2026-08", "payment_voucher", "pv-b"),
    // A repayment to the trade-finance lender.
    leg("310-0020", 50000, 0, "2026-09", "supplier_payment", "HPV-2609-002", "Repaid to LENDER"),
  ],
  bankLegs: [
    { accountCode: "310-0010", debitSen: 0, creditSen: 100001, ym: "2026-09" },
    { accountCode: "310-0010", debitSen: 0, creditSen: 38153, ym: "2026-09" },
    { accountCode: "310-0010", debitSen: 0, creditSen: 13815, ym: "2026-08" },
    { accountCode: "310-0010", debitSen: 0, creditSen: 50000, ym: "2026-09" },
  ],
  coa,
  map: { "400-0000": { section: "RAW_MATERIALS", order: 10 }, "310-0020": { section: "TRADE_FINANCE", order: 10 } },
  rmSplit: { "HPV-2609-001": [{ line: "B.M-FABR", weight: 200 }, { line: "B.FILLER", weight: 100 }] },
  stockGroupOverride: {}, fyeMonth: 7, period: "2026-09", trace,
});

test("without trace the statement carries no sources; every line still has its key", () => {
  const st = cf.buildStatement(input(false));
  assert.equal(st.sources, undefined);
  for (const r of st.rows.filter((x) => x.kind === "line")) assert.equal(r.lineKey, `${r.section}|${r.label}`);
});

test("with trace: each line's sources sum to the line in every column; a split carries its whole amount", () => {
  const st = cf.buildStatement(input(true));
  const lines = st.rows.filter((r) => r.kind === "line");
  assert.ok(lines.length >= 4);
  for (const r of lines) {
    const srcs = st.sources[r.lineKey] ?? [];
    st.columns.forEach((col, i) => {
      const sum = srcs.filter((s) => (col.accum ? true : s.ym === col.key)).reduce((t, s) => t + s.sen, 0);
      assert.equal(r.values[i] ?? 0, cf.displaySign(r.section) * sum, `${r.lineKey} · ${col.key}`);
    });
  }
  // The split payment: two shares, each knowing the whole, adding back to it to the sen.
  const fab = st.sources["RAW_MATERIALS|B.M-FABR"], fil = st.sources["RAW_MATERIALS|B.FILLER"];
  assert.equal(fab.length, 1); assert.equal(fil.length, 1);
  assert.equal(fab[0].of, -100001); assert.equal(fil[0].of, -100001);
  assert.equal(fab[0].sen + fil[0].sen, -100001);
  assert.equal(fab[0].sourceId, "HPV-2609-001");
  // An unsplit leg has no "of"; the facility repayment lands on its own labelled line.
  const elec = st.sources["GENERAL_EXPENSE|WATER & ELECTRICITY"];
  assert.deepEqual(elec.map((s) => [s.ym, s.sen, s.of]), [["2026-09", -38153, undefined], ["2026-08", -13815, undefined]]);
  assert.deepEqual(st.sources["TRADE_FINANCE|Repaid to LENDER"].map((s) => [s.sourceId, s.sen]), [["HPV-2609-002", -50000]]);
});

test("the caller builds the drill from the engine's sources: one row per entry, bank side, refs, tie per column", () => {
  const fn = slice(api, "async function computeCashflowStatement(", 'app.get("/cashflow-statement"');
  assert.match(fn, /opts\?: \{ traceKey\?: string \},\n\) \{/);
  assert.match(fn, /supplierCategory, fyeMonth, period, editable, trace: !!opts\?\.traceKey,/);
  assert.match(fn, /for \(const s of statement\.sources\?\.\[key\] \?\? \[\]\) \{\n      if \(!inFy\(s\.ym\)\) continue;/, "only the months the statement shows");
  assert.match(fn, /let money = legs\.filter\(\(l\) => bankCodes\.has\(l\.code\)\);/);
  assert.match(fn, /money = legs\.filter\(\(l\) => tfAccounts\.has\(l\.code\)\);/, "a facility draw shows the facility");
  assert.match(fn, /SELECT payment_no, purchase_invoice_id FROM supplier_payments WHERE payment_no IN \(\$\{ph\}\) AND org_id = \?/);
  assert.match(fn, /SELECT payment_no, bill_id FROM other_party_payments WHERE payment_no IN/);
  assert.match(fn, /ref1: docNoFromDescription\(description\) \?\? e\.sourceId,/);
  assert.match(fn, /ofSen: Math\.abs\(entryCash\) !== Math\.abs\(e\.sen\) \? Math\.abs\(entryCash\) : null,/);
  assert.match(fn, /const tied = !!row && statement\.columns\.every\(\(col, i\) => \(row\.values\[i\] \?\? 0\) === sign \* \(col\.accum \? total : \(perMonth\.get\(col\.key\) \?\? 0\)\)\);/);
  assert.match(fn, /date: docDate\(l\.sourceType, l\.sourceId, l\.postedAt\)\.slice\(0, 10\),/);
});

test("endpoints: the drill is read-only and validated; the statement never ships drill-only fields", () => {
  const ep = slice(api, 'app.get("/cashflow-drill"', "\n});\n");
  assert.match(ep, /requirePermission\(c, "accounting", "read"\)/);
  assert.match(ep, /if \(!key \|\| !key\.includes\("\|"\)\) return c\.json\(\{ success: false, error: "key is required \(SECTION\|label\)" \}, 400\);/);
  assert.match(ep, /period must be YYYY-MM/);
  assert.match(ep, /computeCashflowStatement\(c\.var\.DB, period, false, getOrgId\(c\), \{ traceKey: key \}\)/);
  assert.match(api, /const \{ bankByMonth: _bank, drill: _drill, sources: _sources, \.\.\.statement \} = await computeCashflowStatement\(c\.var\.DB, period, editable, getOrgId\(c\)\);/);
});

test("the tab: a line's name opens the payments under the row (not in Edit); month chips, statement month first", () => {
  const tab = slice(ui, "function CashFlowTab(", "\nfunction ");
  assert.match(tab, /const canDrill = !edit && r\.kind === "line" && !!r\.lineKey;/);
  assert.match(tab, /const drillKey = canDrill \? `\$\{period\}\|\$\{r\.lineKey\}` : "";/, "a new period starts closed");
  assert.match(tab, /<tr><td colSpan=\{cols\.length \+ 1\} className="p-0"><CfDrillPanel period=\{period\} lineKey=\{r\.lineKey\} \/><\/td><\/tr>/);
  const panel = slice(ui, "function CfDrillPanel(", "\nfunction ");
  assert.match(panel, /fetch\(`\/api\/accounting\/cashflow-drill\?period=\$\{encodeURIComponent\(period\)\}&key=\$\{encodeURIComponent\(lineKey\)\}`\)/);
  assert.match(panel, /const \[month, setMonth\] = useState<string>\(period\);/);
  for (const h of ["Date", "Description", "Bank", "Ref. 1", "Ref. 2", "Money in", "Money out"]) assert.ok(panel.includes(`>${h}</th>`), `column ${h}`);
  assert.match(panel, /part of \{plDrillAmt\(it\.ofSen\)\}/);
  assert.match(panel, />All months<\/button>/);
});
