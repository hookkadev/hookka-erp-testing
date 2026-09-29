// ---------------------------------------------------------------------------
// cashflow-unified-signs.test.mjs — owner 2026-09-29 「确定一下整体的符号哦，
// 有点乱，loan from houzs … 应该是我借出去吧」→「做，统一符号」.
//
// LOAN and UNALLOCATED used to be inflow-signed while every other block below
// the operating result was outflow-signed, so the same bracket meant opposite
// things (Aug'26: CAPEX (61,400.00) = money IN — a machine sold to Houzs; Loan
// (71,457.13) = money OUT — lent to Houzs Venture). Now every block except
// Revenue Collection reads: amount = money out, (amount) = money in. Figures
// and the cash surplus are unchanged; only those two blocks flip direction.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const cf = await import(pathToFileURL(resolve(process.cwd(), "src/lib/cashflow-engine.ts")).href);

test("every section except Revenue Collection is outflow-signed", () => {
  for (const s of cf.SECTION_ORDER) {
    if (s === "REVENUE_COLLECTION") assert.equal(cf.displaySign(s), 1, "collections stay money-in positive");
    else assert.equal(cf.displaySign(s), -1, `${s} must read money out positive`);
  }
  assert.equal(cf.SECTION_LABELS.LOAN, "Loan repaid / lent · (received)");
});

test("money lent / repaid shows positive under Loan, a loan received in brackets; Unallocated money out positive; the surplus identity holds", () => {
  const acct = (code, type, name, sat = null) => ({ code, name, type, sat });
  const coa = new Map([
    ["310-0010", acct("310-0010", "ASSET", "CASH AT BANK", "SBK")],
    ["440-0030", acct("440-0030", "LIABILITY", "LOAN FROM RELATED PARTY - HOUZS VENTURE")],
    ["130-0000", acct("130-0000", "ASSET", "STOCK - FABRIC M")],
    ["200-0030", acct("200-0030", "ASSET", "PLANT & MACHINERY")],
  ]);
  const leg = (accountCode, debitSen, creditSen, sourceId) => ({ accountCode, debitSen, creditSen, ym: "2026-08", sourceType: "x", sourceId });
  const st = cf.buildStatement({
    classified: [
      leg("440-0030", 7145713, 0, "lent"),       // DR loan · CR bank = money out
      leg("440-0030", 0, 1000000, "borrowed"),   // CR loan · DR bank = money in
      leg("130-0000", 10789890, 0, "stock"),     // DR stock · CR bank = money out (unallocated)
      leg("200-0030", 0, 6140000, "sold"),       // CR asset · DR bank = money in (capex disposal)
    ],
    bankLegs: [
      { accountCode: "310-0010", debitSen: 0, creditSen: 7145713, ym: "2026-08" },
      { accountCode: "310-0010", debitSen: 1000000, creditSen: 0, ym: "2026-08" },
      { accountCode: "310-0010", debitSen: 0, creditSen: 10789890, ym: "2026-08" },
      { accountCode: "310-0010", debitSen: 6140000, creditSen: 0, ym: "2026-08" },
    ],
    coa, map: {}, rmSplit: {}, stockGroupOverride: {}, fyeMonth: 8, period: "2026-08",
  });
  const m = st.columns.findIndex((c) => c.key === "2026-08");
  const head = (sec) => st.rows.find((r) => r.kind === "group" && r.groupId === sec);
  assert.equal(head("LOAN").values[m], 7145713 - 1000000, "net money out to lenders / borrowers → positive");
  assert.equal(head("UNALLOCATED").values[m], 10789890, "money out → positive");
  assert.equal(head("CAPEX").values[m], -6140000, "machine sold → money in → brackets (unchanged)");
  // Cash surplus = operating result − Σ(every block below it), all read the same way.
  const result = st.rows.find((r) => r.kind === "result").values[m];
  const total = st.rows.find((r) => r.kind === "total").values[m];
  const below = ["TRADE_FINANCE", "FINANCE_COST", "CAPEX", "DEPOSIT", "LOAN", "UNALLOCATED"].reduce((s, sec) => s + (head(sec)?.values[m] ?? 0), 0);
  assert.equal(result - below, total);
});

test("the page states the rule and the dev preview mirrors the engine", () => {
  const ui = readFileSync("src/pages/accounting/index.tsx", "utf8").replace(/\r\n/g, "\n");
  assert.match(ui, /Signs: Revenue Collection = money in\. Every other block, above and below Net operation surplus: amount = money out, \(amount\) = money in\./);
  assert.match(ui, /const OUTFLOW = new Set\(\["RAW_MATERIALS", "DIRECT_LABOUR", "FACTORY_OVERHEAD", "GENERAL_EXPENSE", "TAXATION", "FINANCE_COST", "CAPEX", "DEPOSIT", "LOAN", "UNALLOCATED"\]\);/);
  assert.doesNotMatch(ui, /Loan \/ \(Repayment\)/);
});
