// ---------------------------------------------------------------------------
// worker-pay-late-daily-rate.test.mjs — BUG-2026-10-05-258.
//
// The worker phone priced late / short hours from the monthly basic salary
// only. A per-day (OSC) worker has basic 0, so the charge came out RM 0.00 and
// the "Late / short hours" line was hidden, while payroll and the admin
// payslip docked the real amount. Prod, Sept 2026, one OSC worker on RM 85.00
// a day: late 0.53 h + 0.27 h + 0.40 h, admin payslip RM 10.21, phone nothing.
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

const imp = (p) => import(pathToFileURL(resolve(process.cwd(), p)).href);
const { workerPayrollDayRateSen } = await imp("src/lib/labor-engine.ts");
const { DEFAULT_PAY_RULES, payrollHourDivisor } = await imp("src/lib/pay-rules.ts");
const ROUTE = readFileSync(resolve(process.cwd(), "src/api/routes/worker.ts"), "utf8");

test("the worker routes never price a day from the monthly basic alone", () => {
  assert.doesNotMatch(ROUTE, /\bpayrollDayRateSen\(/);
  assert.equal(ROUTE.match(/workerPayrollDayRateSen\(/g)?.length, 2);
  assert.equal(ROUTE.match(/payMode: w(Row|\?)\.payMode/g)?.length, 2);
});

test("a per-day worker's late hours are charged at the day rate, as payroll does", () => {
  const cfg = { ...DEFAULT_PAY_RULES, hourRateDivisorMode: "hoursPlusLunch", lunchMin: 60 };
  const ctx = { workingDaysPerMonth: 26, calendarDays: 30, workingDaysInMonth: 26 };
  const dayRate = workerPayrollDayRateSen(
    { basicSalarySen: 0, payMode: "DAILY", dailyRateSen: 8500 },
    ctx,
    cfg,
  );
  assert.equal(dayRate, 8500);
  const hourRate = dayRate / payrollHourDivisor(9, cfg);
  const sen = [0.53, 0.27, 0.4].reduce((s, h) => s + Math.round(h * hourRate), 0);
  assert.equal(sen, 1021); // RM 10.21, the admin payslip's figure
});
