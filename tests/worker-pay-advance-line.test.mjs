// ---------------------------------------------------------------------------
// worker-pay-advance-line.test.mjs — BUG-2026-10-05-257.
//
// A finished month on the worker's My Pay page listed EPF / SOCSO / EIS / Tax
// between Gross and Net, but not the salary advance the payslip had already
// taken off Net. Prod, Sept 2026: Gross RM 2,114.80, Net RM 2,014.80, every
// listed deduction RM 0.00, and nothing to explain the RM 100. The server never
// sent the advance and the card had no line for it.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on Node 22+.
}

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");
const ROUTE = read("src/api/routes/worker.ts");
const PAGE = read("src/pages/worker/pay.tsx");
const i18n = await import(pathToFileURL(resolve(process.cwd(), "src/lib/worker-i18n.ts")).href);

const payslipsHandler = ROUTE.slice(ROUTE.indexOf('app.get("/payslips"'), ROUTE.indexOf("// Live current-month estimate"));

test("the worker payslips history carries the stored advance and its dates", () => {
  assert.match(payslipsHandler, /otPhHours, advance_deduction_sen\s+FROM payslips/);
  assert.match(payslipsHandler, /advanceDeductionSen: Number\(r\.advanceDeductionSen \?\? r\.advance_deduction_sen/);
  assert.match(payslipsHandler, /advanceDays: advancesByPeriod\.get\(r\.period\)/);
  // The column only exists after the self-apply has run.
  assert.match(payslipsHandler, /await ensureAdvanceTables\(c\.var\.DB\)/);
});

test("a cached My Pay snapshot cannot hide the advance", () => {
  assert.match(payslipsHandler, /"employee_advances",\s*\] as const/);
  assert.match(payslipsHandler, /cacheKey: `\$\{workerId\}:\$\{snapPeriod\}:adv`/);
});

test("the finished-month card shows a Salary advance line", () => {
  const card = PAGE.slice(PAGE.indexOf("function FinalisedBreakdown"), PAGE.indexOf("// ---------- tiny UI helpers"));
  assert.match(card, /slip\.advanceDeductionSen \? \(/);
  assert.match(card, /t\("pay\.salaryAdvance"\)/);
  // It sits after Tax, before the Net total, so the column adds up top to bottom.
  assert.ok(card.indexOf("pay.salaryAdvance") > card.indexOf('label="Tax"'));
  assert.ok(card.indexOf("pay.salaryAdvance") < card.indexOf('label="Net"'));
});

test("the Salary advance label exists in every worker language", () => {
  for (const lang of ["en", "ms", "zh", "my"]) {
    const v = i18n.translateFor(lang, "pay.salaryAdvance");
    assert.notEqual(v, "pay.salaryAdvance", `no ${lang} string`);
    assert.ok(v.trim().length > 0, `blank in ${lang}`);
  }
});
