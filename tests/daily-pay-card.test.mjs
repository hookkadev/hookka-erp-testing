// ---------------------------------------------------------------------------
// daily-pay-card.test.mjs — BUG-2026-10-06-259, the per-day My Pay card.
//
// Gross = days × daily rate + other earnings; Net = Gross − every deduction.
// Half days round through roundSen; a net below zero is shown, not clamped.
// Also pins that the live estimate tells the engine the worker is per-day.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on newer Node.
}
register("./tests/_alias-loader.mjs", pathToFileURL("./"));

const { computeDailyPay } = await import(
  pathToFileURL(resolve(process.cwd(), "src/pages/worker/daily-pay-card.tsx")).href
);

test("gross is days × rate plus other earnings; net subtracts every deduction", () => {
  const r = computeDailyPay({
    ratePerDaySen: 8500,
    daysWorked: 22,
    otherEarnings: [{ label: "Overtime", amountSen: 4250 }],
    lateShortSen: 1063,
    advanceSen: 20000,
    otherDeductions: [{ label: "EPF", amountSen: 2100 }],
  });
  assert.equal(r.dailyEarningsSen, 187000);
  assert.equal(r.grossSen, 191250);
  assert.equal(r.totalDeductionsSen, 23163);
  assert.equal(r.netSen, 168087);
});

test("half days round to whole sen, and a negative net is kept", () => {
  const r = computeDailyPay({
    ratePerDaySen: 8333,
    daysWorked: 0.5,
    lateShortSen: 0,
    advanceSen: 10000,
  });
  assert.equal(r.dailyEarningsSen, 4167);
  assert.equal(r.netSen, 4167 - 10000);
});

// The live estimate must tell the engine the worker is paid by the day.
// Without payMode / dailyRateSen it priced OSC-001 (RM 85/day, no basic) as a
// RM 0 monthly worker, and My Pay showed "Basic RM 0.00".
const { readFileSync } = await import("node:fs");
const route = readFileSync("src/api/routes/worker.ts", "utf8");
const handler = route.slice(route.indexOf('app.get("/payslips"'), route.indexOf("GET /api/worker/penalties"));

test("the worker payslips estimate passes the pay mode and day rate to the engine", () => {
  const call = handler.slice(handler.indexOf("const labor = computeMonthlyLabor("));
  assert.match(call.slice(0, 600), /payMode: payWorker\?\.payMode,/);
  assert.match(call.slice(0, 600), /dailyRateSen: Number\(payWorker\?\.dailyRateSen\) \|\| 0,/);
  assert.match(handler, /dailyRateSen: labor\.payrollDailyRateSen,/);
  assert.match(handler, /advanceSen: \(advancesByPeriod\.get\(period\)/);
});

test("My Pay shows the daily card for a DAILY worker's current month", () => {
  const page = readFileSync("src/pages/worker/pay.tsx", "utf8");
  assert.match(page, /isCurrent && pay\.current\.payMode === "DAILY" \? \(\s*<DailyCurrentMonth/);
});
