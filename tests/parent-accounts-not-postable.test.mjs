// ---------------------------------------------------------------------------
// parent-accounts-not-postable.test.mjs — owner 2026-09-29 「by right 410-0000
// 不能选吧？我有注意到 410-0000 pv 开过去」→「做 a b d」.
//
// Measured on prod that day: of every account in the chart that has child
// accounts, 410-0000 ACCRUALS was the only one still flagged postable, so
// salary vouchers were paid against it instead of 410-0010 ACCRUAL - SALARY
// (and the Cash Flow showed them as "Unallocated").
//   b. An account with children is a header and is NEVER postable, whatever
//      its stored flag: every line validation reads the effective flag, the
//      JE post refuses it, pickers no longer offer it, and the COA editor
//      cannot flag a parent postable.
//   d. Cash Flow: the payroll accruals under 410-0010's parent get default
//      sections — salary (and the parent) Direct Labour, EPF / SOCSO / EIS
//      General Expense since the owner's 「这个是普通 staff，不是 direct 的」
//      (behaviour in tests/cashflow-staff-contribution-accruals.test.mjs);
//      the parent's salary payments split by department like 410-0010's.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const api = readFileSync("src/api/routes/accounting.ts", "utf8").replace(/\r\n/g, "\n");

test("one definition of 'postable': a parent is never postable", () => {
  assert.match(api, /const EFFECTIVE_POSTABLE_SQL =\s*\n\s*"CASE WHEN EXISTS \(SELECT 1 FROM chart_of_accounts k WHERE k\.parentCode = chart_of_accounts\.code\) THEN 0 ELSE isPostable END AS is_postable";/);
  assert.match(api, /async function accountHasChildren\(db: Env\["Variables"\]\["DB"\], code: string\): Promise<boolean> \{/);
  // Every line-validation COA load and both bill checks use it; the raw flag is gone from them.
  assert.equal((api.match(/`SELECT code, type, specialAccountType, \$\{EFFECTIVE_POSTABLE_SQL\} FROM chart_of_accounts`/g) ?? []).length, 6);
  assert.equal((api.match(/`SELECT code, \$\{EFFECTIVE_POSTABLE_SQL\} FROM chart_of_accounts WHERE code = \?`/g) ?? []).length, 2);
  assert.doesNotMatch(api, /"SELECT code, type, specialAccountType, isPostable FROM chart_of_accounts"/);
  assert.doesNotMatch(api, /"SELECT code, isPostable FROM chart_of_accounts WHERE code = \?"/);
});

test("the journal post, the account list and the COA editor all honour it", () => {
  assert.match(api, /if \(\(acct\.isPostable \?\? 1\) === 0 \|\| \(await accountHasChildren\(c\.var\.DB, l\.accountCode\)\)\) \{/);
  const get = api.slice(api.indexOf('app.get("/coa", async (c) => {'), api.indexOf('app.post("/coa", async (c) => {'));
  assert.match(get, /return parents\.has\(row\.code\) \? \{ \.\.\.row, isPostable: false \} : row;/);
  const put = api.slice(api.indexOf('app.put("/coa", async (c) => {'), api.indexOf("\napp.", api.indexOf('app.put("/coa", async (c) => {') + 10));
  assert.match(put, /if \(await accountHasChildren\(c\.var\.DB, String\(code\)\)\) \{\s*\n\s*if \(body\.isPostable === true\) \{/);
  assert.match(put, /a parent \(header\) account can't be postable/);
  assert.match(put, /merged\.isPostable = 0;/);
});

test("Cash Flow takes the payroll-accrual defaults from the chart", () => {
  const body = api.slice(api.indexOf("async function computeCashflowStatement("), api.indexOf('app.get("/cashflow-statement"'));
  assert.match(body, /const salaryAccrualParent = coa\.get\(LABOUR_ACCRUAL_ACCT\)\?\.parentCode \?\? null;/);
  assert.match(body, /for \(const \[code, section\] of payrollAccrualSections\(coa, LABOUR_ACCRUAL_ACCT\)\) if \(!map\[code\]\) map\[code\] = \{ section, order: 10 \};/, "the owner's drags win");
  assert.match(body, /else if \(l\.code === LABOUR_ACCRUAL_ACCT \|\| \(salaryAccrualParent && l\.code === salaryAccrualParent\)\)/, "the parent's salary payments split by department too");
  assert.doesNotMatch(body, /"410-0000"/, "no hard-coded parent code");
});
