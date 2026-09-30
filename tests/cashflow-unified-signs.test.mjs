// ---------------------------------------------------------------------------
// cashflow-unified-signs.test.mjs — the Cash Flow's one sign rule.
//
// History: 2026-09-29 morning 「确定一下整体的符号哦，有点乱」→ every block below
// the collection read money-out positive; the same afternoon the owner ruled
// 「这个 cash flow 我想要更改，全部进钱 positive，出钱 negative」 — the cash view:
// every line, in every block, reads the bank's way: amount = money in,
// (amount) = money out. Figures and the cash surplus never change with the
// sign rule; the operating result and the surplus are plain sums.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const cf = await import(pathToFileURL(resolve(process.cwd(), "src/lib/cashflow-engine.ts")).href);

test("every section reads money in positive, money out negative", () => {
  assert.equal(cf.OUTFLOW_SECTIONS.size, 0, "no block flips the sign any more");
  for (const s of cf.SECTION_ORDER) assert.equal(cf.displaySign(s), 1, `${s} must read the bank's way`);
  assert.equal(cf.SECTION_LABELS.LOAN, "Loan received / (repaid · lent)");
  assert.equal(cf.SECTION_LABELS.DEPOSIT, "Deposit refunded / (paid)");
});

test("money lent / repaid is negative, a loan received positive; spend negative, a sale positive; the rows simply add up", () => {
  const acct = (code, type, name, sat = null) => ({ code, name, type, sat });
  const coa = new Map([
    ["310-0010", acct("310-0010", "ASSET", "CASH AT BANK", "SBK")],
    ["300-0000", acct("300-0000", "ASSET", "TRADE DEBTORS", "SDC")],
    ["440-0030", acct("440-0030", "LIABILITY", "LOAN FROM RELATED PARTY - HOUZS VENTURE")],
    ["130-0000", acct("130-0000", "ASSET", "SOMETHING UNMAPPED")],
    ["200-0030", acct("200-0030", "ASSET", "PLANT & MACHINERY")],
    ["900-0001", acct("900-0001", "EXPENSE", "Transport expense")],
  ]);
  const leg = (accountCode, debitSen, creditSen, sourceId) => ({ accountCode, debitSen, creditSen, ym: "2026-08", sourceType: "x", sourceId });
  const st = cf.buildStatement({
    classified: [
      leg("300-0000", 0, 5000000, "collected"),  // money in
      leg("900-0001", 250000, 0, "spent"),       // money out
      leg("440-0030", 7145713, 0, "lent"),       // money out
      leg("440-0030", 0, 1000000, "borrowed"),   // money in
      leg("130-0000", 10789890, 0, "unmapped"),  // money out (Unallocated)
      leg("200-0030", 0, 6140000, "sold"),       // money in (machine sold)
    ],
    bankLegs: [
      { accountCode: "310-0010", debitSen: 5000000, creditSen: 0, ym: "2026-08" },
      { accountCode: "310-0010", debitSen: 0, creditSen: 250000, ym: "2026-08" },
      { accountCode: "310-0010", debitSen: 0, creditSen: 7145713, ym: "2026-08" },
      { accountCode: "310-0010", debitSen: 1000000, creditSen: 0, ym: "2026-08" },
      { accountCode: "310-0010", debitSen: 0, creditSen: 10789890, ym: "2026-08" },
      { accountCode: "310-0010", debitSen: 6140000, creditSen: 0, ym: "2026-08" },
    ],
    coa, map: {}, rmSplit: {}, stockGroupOverride: {}, fyeMonth: 8, period: "2026-08",
  });
  const m = st.columns.findIndex((c) => c.key === "2026-08");
  const head = (sec) => st.rows.find((r) => r.kind === "group" && r.groupId === sec);
  assert.equal(head("GENERAL_EXPENSE").values[m], -250000);
  assert.equal(head("LOAN").values[m], -(7145713 - 1000000), "net lent / repaid → money out → negative");
  assert.equal(head("UNALLOCATED").values[m], -10789890);
  assert.equal(head("CAPEX").values[m], 6140000, "machine sold → money in → positive");
  const result = st.rows.find((r) => r.kind === "result").values[m];
  assert.equal(result, 5000000 - 250000, "operating result = collections + (negative) costs");
  const total = st.rows.find((r) => r.kind === "total").values[m];
  const below = ["TRADE_FINANCE", "FINANCE_COST", "CAPEX", "DEPOSIT", "LOAN", "UNALLOCATED"].reduce((s, sec) => s + (head(sec)?.values[m] ?? 0), 0);
  assert.equal(result + below, total, "cash surplus = operating result + every block below it");
});

test("the page states the rule and the dev preview mirrors the engine", () => {
  const ui = readFileSync("src/pages/accounting/index.tsx", "utf8").replace(/\r\n/g, "\n");
  assert.match(ui, /Signs: every line reads the bank's way — amount = money in, \(amount\) = money out\./);
  assert.match(ui, /const OUTFLOW = new Set<string>\(\);/);
  assert.doesNotMatch(ui, /Loan \/ \(Repayment\)|Loan repaid \/ lent · \(received\)/);
});
