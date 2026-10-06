// ---------------------------------------------------------------------------
// pay-card.test.mjs — BUG-2026-10-06-259, the one My Pay card.
//
// Every worker and month reads Net, then Earnings (base − absent − late + OT +
// allowances = the payslip's Gross), then Deductions, then Gross − Deductions
// = Net. The builders must rebuild payroll's own figure or return null (the
// page then keeps the old card). Figures below are real staging months.
// Also pins that the live estimate tells the engine the worker is per-day.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on newer Node.
}
register("./tests/_alias-loader.mjs", pathToFileURL("./"));

const { payTotals, liveMonthCard, payslipCard } = await import(
  pathToFileURL(resolve(process.cwd(), "src/pages/worker/pay-card.tsx")).href
);

const t = (k) => k;
const RATE = 8500; // the staging per-day worker, RM 85.00 a day
const lineOf = (card, label) =>
  [...card.less, ...card.plus, ...card.deductions].find((l) => l.label === label);

test("gross takes absence and late off inside Earnings; net takes the deductions", () => {
  const r = payTotals({
    base: { label: "b", amountSen: 260000 },
    less: [{ label: "absent", amountSen: 40000 }, { label: "late", amountSen: 3650 }],
    plus: [{ label: "ot", amountSen: 5000 }],
    deductions: [{ label: "epf", amountSen: 2000 }, { label: "adv", amountSen: 10000 }],
  });
  assert.deepEqual(r, { grossSen: 221350, totalDeductionsSen: 12000, netSen: 209350 });
});

const live = {
  periodLabel: "Oct 2026",
  workedDays: 0,
  fullSalarySen: 0,
  absentDays: 0,
  absenceDeductionSen: 0,
  shortHourDeductionSen: 0,
  otSen: 0,
  otMinutes: 0,
  efficiencyAllowanceSen: 0,
  leadershipAllowanceSen: 0,
  estimatedGrossSen: 0,
};

test("live month, monthly worker: salary less absent days gives the engine's gross", () => {
  // The monthly worker in the October screenshot: RM 2,600, 4 days absent.
  const card = liveMonthCard(
    { ...live, fullSalarySen: 260000, absentDays: 4, absenceDeductionSen: 40000, absentDates: ["2026-10-01"], estimatedGrossSen: 220000 },
    t,
  );
  assert.equal(card.base.label, "pay.monthlySalary");
  assert.equal(card.base.amountSen, 260000);
  assert.equal(payTotals(card).grossSen, 220000);
  assert.equal(payTotals(card).netSen, 220000);
  assert.equal(card.isEstimate, true);
});

test("live month, per-day worker: days × rate less late, then the advance", () => {
  // The staging test month: 4 days, 2h late, RM 50 advance.
  const card = liveMonthCard(
    { ...live, payMode: "DAILY", dailyRateSen: RATE, workedDays: 4, shortHourDeductionSen: 1700, lateDays: [{ date: "2026-10-02", hours: 0.5 }], estimatedGrossSen: 32300, advanceSen: 5000 },
    t,
  );
  assert.equal(card.base.amountSen, 34000);
  assert.equal(card.base.label, "pay.dailyRateEarnings");
  assert.deepEqual(lineOf(card, "pay.lateShortDeduction").chips, ["02 Oct · 30m"]);
  assert.deepEqual(payTotals(card), { grossSen: 32300, totalDeductionsSen: 5000, netSen: 27300 });
});

test("live month the engine floored at RM 0 keeps the old card", () => {
  assert.equal(
    liveMonthCard({ ...live, fullSalarySen: 100000, absentDays: 20, absenceDeductionSen: 150000, estimatedGrossSen: 0 }, t),
    null,
  );
});

test("payslip, monthly worker: late is what the stored gross leaves over", () => {
  // The September screenshot: RM 2,600, late RM 36.50, advance RM 100.
  const card = payslipCard(
    { status: "DRAFT", basicSen: 260000, grossSen: 256350, netSen: 246350, advanceDeductionSen: 10000, lateDays: [{ date: "2026-09-03", hours: 2 }] },
    { periodLabel: "Sep 2026", payMode: "MONTHLY" },
    t,
  );
  assert.equal(lineOf(card, "pay.lateShortDeduction").amountSen, 3650);
  assert.deepEqual(payTotals(card), { grossSen: 256350, totalDeductionsSen: 10000, netSen: 246350 });
  assert.equal(card.isEstimate, true);
});

test("payslip, per-day worker: the days come back from the stored gross", () => {
  const ctx = { periodLabel: "x", payMode: "DAILY", dailyRateSen: RATE };
  // Sept: 21 days, 0.8h late (RM 6.80), RM 100 advance.
  const sep = payslipCard({ grossSen: 177820, netSen: 167820, shortHourDeductionSen: 680, advanceDeductionSen: 10000 }, ctx, t);
  assert.equal(sep.base.amountSen, 21 * RATE);
  assert.equal(lineOf(sep, "pay.lateShortDeduction").amountSen, 680);
  // Aug: 24 days, 5h late.
  const aug = payslipCard({ grossSen: 199750, netSen: 199750, shortHourDeductionSen: 4250 }, ctx, t);
  assert.equal(aug.base.amountSen, 24 * RATE);
  // June: late records exist today, but the payslip (before per-day late docks)
  // paid 24 full days and charged none.
  const jun = payslipCard({ grossSen: 204000, netSen: 204000, shortHourDeductionSen: 638, lateDays: [{ date: "2026-06-03", hours: 0.75 }] }, ctx, t);
  assert.equal(jun.base.amountSen, 24 * RATE);
  assert.equal(lineOf(jun, "pay.lateShortDeduction").amountSen, 0);
});

test("a deducted penalty is a Deductions line; without it the month keeps the old card", () => {
  const slip = { basicSen: 260000, grossSen: 260000, netSen: 255000 };
  assert.equal(payslipCard(slip, { periodLabel: "x", penaltySen: 5000 }, t).deductions.at(-1).amountSen, 5000);
  assert.equal(payslipCard(slip, { periodLabel: "x" }, t), null);
});

test("a day rate that changed since the payslip keeps the old card", () => {
  assert.equal(
    payslipCard({ grossSen: 177820, netSen: 167820, shortHourDeductionSen: 680, advanceDeductionSen: 10000 }, { periodLabel: "x", payMode: "DAILY", dailyRateSen: 9000 }, t),
    null,
  );
});

// The live estimate must tell the engine the worker is paid by the day.
// Without payMode / dailyRateSen it priced the per-day worker as a RM 0
// monthly worker, and My Pay showed "Basic RM 0.00".
const route = readFileSync("src/api/routes/worker.ts", "utf8");
const handler = route.slice(route.indexOf('app.get("/payslips"'), route.indexOf("GET /api/worker/penalties"));

test("the worker payslips estimate passes the pay mode and day rate to the engine", () => {
  const call = handler.slice(handler.indexOf("const labor = computeMonthlyLabor("));
  assert.match(call.slice(0, 600), /payMode: payWorker\?\.payMode,/);
  assert.match(call.slice(0, 600), /dailyRateSen: Number\(payWorker\?\.dailyRateSen\) \|\| 0,/);
  assert.match(handler, /dailyRateSen: labor\.payrollDailyRateSen,/);
  assert.match(handler, /advanceSen: \(advancesByPeriod\.get\(period\)/);
});

test("My Pay builds every month's card with PayCard", () => {
  const page = readFileSync("src/pages/worker/pay.tsx", "utf8");
  assert.match(page, /liveMonthCard\(\{ \.\.\.pay\.current/);
  assert.match(page, /payslipCard\(\s*slip,/);
  assert.match(page, /\{card \? \(\s*<PayCard t=\{t\} card=\{card\}>/);
});
