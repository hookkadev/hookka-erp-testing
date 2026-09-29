// ---------------------------------------------------------------------------
// cashflow-staff-contribution-accruals.test.mjs — owner 2026-09-29, on the
// Cash Flow's "EPF / SOCSO accrual under Direct Labour":
// 「这个是普通 staff，不是 direct 的」.
//
// The payroll accruals under the salary accrual's parent (410-0000 ACCRUALS on
// this chart) default to: salary accrual + the parent → Direct Labour (split
// by department by the caller); every other accrual there — EPF / SOCSO /
// EIS — → General Expense. The P&L books that EPF as STAFFS' EPF, not
// PRODUCTION - EPF, so the two statements now agree. Both sections sit above
// the operating result: the operating result and the cash surplus do not move.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const cf = await import(pathToFileURL(resolve(process.cwd(), "src/lib/cashflow-engine.ts")).href);

const acct = (code, type, name, parentCode = null, sat = null) => ({ code, name, type, sat, parentCode });
const chart = (salaryParent = "410-0000") => new Map([
  ["310-0010", acct("310-0010", "ASSET", "CASH AT BANK", null, "SBK")],
  ["410-0000", acct("410-0000", "LIABILITY", "ACCRUALS")],
  ["410-0010", acct("410-0010", "LIABILITY", "ACCRUAL - SALARY", salaryParent)],
  ["410-0020", acct("410-0020", "LIABILITY", "ACCRUAL - EPF", "410-0000")],
  ["410-0030", acct("410-0030", "LIABILITY", "ACCRUAL - SOCSO", "410-0000")],
  ["410-0040", acct("410-0040", "LIABILITY", "ACCRUAL - EIS", "410-0000")],
  ["900-S000", acct("900-S000", "EXPENSE", "SALARIES & CONTRIBUTION")],
  ["900-S005", acct("900-S005", "EXPENSE", "STAFFS' EPF", "900-S000")],
]);

test("salary accrual and its parent → Direct Labour; EPF / SOCSO / EIS accruals → General Expense", () => {
  const s = cf.payrollAccrualSections(chart(), "410-0010");
  assert.deepEqual(Object.fromEntries(s), {
    "410-0000": "DIRECT_LABOUR",
    "410-0010": "DIRECT_LABOUR",
    "410-0020": "GENERAL_EXPENSE",
    "410-0030": "GENERAL_EXPENSE",
    "410-0040": "GENERAL_EXPENSE",
  });
  assert.equal(s.has("900-S005"), false, "only the accruals under that parent get a default");
});

test("found from the chart: no parent → no defaults; another parent code works the same", () => {
  assert.equal(cf.payrollAccrualSections(chart(null), "410-0010").size, 0);
  const other = new Map([
    ["480-0000", acct("480-0000", "LIABILITY", "PAYROLL ACCRUALS")],
    ["480-0001", acct("480-0001", "LIABILITY", "ACCRUAL - SALARY", "480-0000")],
    ["480-0002", acct("480-0002", "LIABILITY", "ACCRUAL - EPF", "480-0000")],
  ]);
  assert.deepEqual(Object.fromEntries(cf.payrollAccrualSections(other, "480-0001")), {
    "480-0000": "DIRECT_LABOUR", "480-0001": "DIRECT_LABOUR", "480-0002": "GENERAL_EXPENSE",
  });
});

test("paid EPF / SOCSO accruals show under General Expense, nested under ACCRUALS; result and cash surplus unchanged", () => {
  const coa = chart();
  const leg = (accountCode, debitSen, creditSen, sourceId) => ({ accountCode, debitSen, creditSen, ym: "2026-08", sourceType: "payment_voucher", sourceId });
  const classified = [leg("410-0020", 761800, 0, "pv-epf"), leg("410-0030", 103450, 0, "pv-socso")];
  const bankLegs = [
    { accountCode: "310-0010", debitSen: 0, creditSen: 761800, ym: "2026-08" },
    { accountCode: "310-0010", debitSen: 0, creditSen: 103450, ym: "2026-08" },
  ];
  const run = (map) => cf.buildStatement({ classified, bankLegs, coa, map, rmSplit: {}, stockGroupOverride: {}, fyeMonth: 8, period: "2026-08" });
  const toMap = (sections) => Object.fromEntries([...sections].map(([code, section]) => [code, { section, order: 10 }]));

  const now = run(toMap(cf.payrollAccrualSections(coa, "410-0010")));
  const m = now.columns.findIndex((c) => c.key === "2026-08");
  const head = (st, id) => st.rows.find((r) => r.kind === "group" && r.groupId === id);
  assert.equal(head(now, "GENERAL_EXPENSE").values[m], -(761800 + 103450), "money out → negative, in General Expense");
  assert.equal(head(now, "DIRECT_LABOUR")?.values[m] ?? 0, 0, "nothing left under Direct Labour");
  const epf = now.rows.find((r) => r.kind === "line" && r.label === "ACCRUAL - EPF");
  assert.equal(epf.groupId, "GENERAL_EXPENSE>410-0000", "nested under the ACCRUALS parent inside General Expense");

  // The old default (everything under Direct Labour) gives the same operating result and cash surplus.
  const before = run(toMap(new Map([["410-0020", "DIRECT_LABOUR"], ["410-0030", "DIRECT_LABOUR"]])));
  for (const kind of ["result", "total"]) {
    assert.equal(now.rows.find((r) => r.kind === kind).values[m], before.rows.find((r) => r.kind === kind).values[m], `${kind} must not move`);
  }
});
