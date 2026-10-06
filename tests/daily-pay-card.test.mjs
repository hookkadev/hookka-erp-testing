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

const { computeDailyPay, dailyCardFromPayslip } = await import(
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
  // and for a past month whose payslip it can rebuild
  assert.match(page, /slip && pay\.current\.payMode === "DAILY"\s*\?\s*dailyCardFromPayslip\(slip/);
});

// Past months: rebuilt from the stored payslip. Figures are the staging
// per-day worker's real 2026 payslips (RM 85.00 a day).
const t = (k) => k;
const RATE = 8500;

test("a past month gives back its days and late charge from the payslip", () => {
  // Sept: 21 days paid, 0.8h late (RM 6.80), RM 100 advance.
  const sep = dailyCardFromPayslip(
    { grossSen: 177820, netSen: 167820, shortHourDeductionSen: 680, advanceDeductionSen: 10000, lateDays: [{ date: "2026-09-10", hours: 0.8 }] },
    RATE, t,
  );
  assert.equal(sep.daysWorked, 21);
  assert.equal(sep.lateShortSen, 680);
  assert.equal(computeDailyPay(sep).netSen, 167820);
  // Aug: 24 days, 5h late.
  const aug = dailyCardFromPayslip({ grossSen: 199750, netSen: 199750, shortHourDeductionSen: 4250 }, RATE, t);
  assert.equal(aug.daysWorked, 24);
  assert.equal(aug.lateShortSen, 4250);
});

test("a month paid before per-day late docks existed shows no late charge", () => {
  // June: late records exist today (RM 6.38) but the payslip paid 24 full days.
  const jun = dailyCardFromPayslip(
    { grossSen: 204000, netSen: 204000, shortHourDeductionSen: 638, lateDays: [{ date: "2026-06-03", hours: 0.75 }] },
    RATE, t,
  );
  assert.equal(jun.daysWorked, 24);
  assert.equal(jun.lateShortSen, 0);
  assert.deepEqual(jun.lateDays, []);
});

test("no fit keeps the old card", () => {
  // The day rate changed since the payslip was made.
  assert.equal(dailyCardFromPayslip({ grossSen: 177820, netSen: 167820, shortHourDeductionSen: 680, advanceDeductionSen: 10000 }, 9000, t), null);
  // Net also carries a penalty the card has no line for.
  assert.equal(dailyCardFromPayslip({ grossSen: 177820, netSen: 167320, shortHourDeductionSen: 680, advanceDeductionSen: 10000 }, RATE, t), null);
});
