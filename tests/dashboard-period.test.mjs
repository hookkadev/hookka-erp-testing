// dashboard-period.test.mjs — the period picker's pure logic, shared by the
// desktop PeriodPicker and the /m PeriodChip (dashboard-shared-lib.ts).
import test from "node:test";
import assert from "node:assert/strict";
import {
  stepPeriod, stepDay, yearsWithData, periodLabel, periodPresets, presetActive, calendarCells, shiftMonth,
  warnDays, dayList, overallEfficiencyPct,
} from "../src/pages/dashboards/dashboard-shared-lib.ts";

const months = ["2025-11", "2025-12", "2026-06", "2026-08", "2026-09"];

test("monthly steps to the neighbouring month THAT HAS DATA, and stops at the ends", () => {
  assert.deepEqual(stepPeriod({ mode: "monthly", month: "2026-08" }, months, -1), { mode: "monthly", month: "2026-06" });
  assert.deepEqual(stepPeriod({ mode: "monthly", month: "2026-08" }, months, 1), { mode: "monthly", month: "2026-09" });
  assert.equal(stepPeriod({ mode: "monthly", month: "2026-09" }, months, 1), null);
  assert.equal(stepPeriod({ mode: "monthly", month: "2025-11" }, months, -1), null);
});

test("stepping drops a highlighted day and steps a range back out to a plain month", () => {
  assert.deepEqual(stepPeriod({ mode: "monthly", month: "2026-09", day: "2026-09-12" }, months, -1), { mode: "monthly", month: "2026-08" });
  assert.deepEqual(
    stepPeriod({ mode: "range", month: "2026-09", from: "2026-09-09", to: "2026-09-15", label: "Last 7 Days" }, months, -1),
    { mode: "monthly", month: "2026-08" },
  );
});

test("YTD steps by YEAR and lands on that year's newest month", () => {
  assert.deepEqual(stepPeriod({ mode: "ytd", month: "2026-06" }, months, -1), { mode: "ytd", month: "2025-12" });
  assert.deepEqual(stepPeriod({ mode: "ytd", month: "2025-11" }, months, 1), { mode: "ytd", month: "2026-09" });
  assert.equal(stepPeriod({ mode: "ytd", month: "2026-09" }, months, 1), null);
  assert.equal(stepPeriod({ mode: "ytd", month: "2025-12" }, months, -1), null);
});

// Regression: Today/Yesterday used to anchor to the newest day WITH DATA,
// same as Last 7 Days - so whenever today's sales hadn't posted yet, "Today"
// silently showed yesterday's figures (and the page's own default-open day,
// resolvePeriod's `today` param, disagreed with it). Fixed 2026-09-22.
test("Today / Yesterday follow the real calendar day, even when the book's data lags behind it", () => {
  const p = periodPresets("2026-09-15", months, "2026-09-17");
  assert.deepEqual(p.map((x) => x.label), ["Today", "Yesterday", "Last 7 Days"]);
  assert.deepEqual(p[0].period, { mode: "monthly", month: "2026-09", day: "2026-09-17" });
  assert.deepEqual(p[1].period, { mode: "monthly", month: "2026-09", day: "2026-09-16" });
});

test("Last 7 Days still anchors to the newest day WITH DATA, not the clock or the month end", () => {
  // owner 2026-09-21: anchoring it to the end of the newest month instead
  // selected Sep 24-30 when data stopped on Sep 15 - an all-zero window. A
  // relative multi-day window has no calendar identity of its own to keep,
  // unlike a single named day, so it stays anchored to real data.
  const p = periodPresets("2026-09-15", months, "2026-09-17");
  assert.deepEqual(p[2].period, { mode: "range", month: "2026-09", from: "2026-09-09", to: "2026-09-15", label: "Last 7 Days" });
  const q = periodPresets("2026-09-02", months, "2026-09-02");
  assert.deepEqual([q[2].period.from, q[2].period.to, q[2].period.month], ["2026-08-27", "2026-09-02", "2026-08"]);
});

test("presets with no sales at all: Today/Yesterday still follow the clock; truly nothing returns []", () => {
  const p = periodPresets("", [], "2026-09-17");
  assert.deepEqual(p.map((x) => x.label), ["Today", "Yesterday"]);
  assert.equal(p[0].period.day, "2026-09-17");
  assert.deepEqual(periodPresets("", [], ""), []);
});

test("presetActive: a day preset matches the highlighted day, a range preset the exact window", () => {
  const [today, , last7] = periodPresets("2026-09-15", months, "2026-09-15");
  assert.equal(presetActive(today.period, { mode: "monthly", month: "2026-09", day: "2026-09-15" }), true);
  assert.equal(presetActive(today.period, { mode: "monthly", month: "2026-09" }), false);
  assert.equal(presetActive(last7.period, last7.period), true);
  assert.equal(presetActive(last7.period, { mode: "range", month: "2026-09", from: "2026-09-01", to: "2026-09-15" }), false);
});

test("calendarCells is Monday-first with the right leading blanks and day count", () => {
  // 1 Sep 2026 is a Tuesday -> one blank; February 2026 starts on a Sunday -> six.
  const sep = calendarCells("2026-09");
  assert.deepEqual(sep.slice(0, 2), [null, "2026-09-01"]);
  assert.equal(sep.filter(Boolean).length, 30);
  assert.equal(sep.at(-1), "2026-09-30");
  const feb = calendarCells("2026-02");
  assert.equal(feb.filter((c) => c === null).length, 6);
  assert.equal(feb.filter(Boolean).length, 28);
  assert.equal(calendarCells("2028-02").filter(Boolean).length, 29);
});

test("shiftMonth wraps the year in both directions", () => {
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftMonth("2025-12", 1), "2026-01");
  assert.equal(shiftMonth("2026-09", -14), "2025-07");
});

// Regression: the period's month is "" until the feed has loaded. calendarCells("")
// did `Array(NaN)` -> RangeError "Array length must be a positive integer of safe
// magnitude" and crashed /m/dashboard on first paint (the sheet's children are
// evaluated even while it is closed).
test("the picker logic survives a period whose month has not loaded yet", () => {
  for (const bad of ["", "2026", "2026-13", "nope"]) {
    assert.deepEqual(calendarCells(bad), [], bad);
    assert.equal(shiftMonth(bad, 1), bad, bad);
  }
  assert.equal(stepPeriod({ mode: "monthly", month: "" }, [], 1), null);
  assert.equal(stepPeriod({ mode: "ytd", month: "" }, [], -1), null);
  assert.deepEqual(periodPresets("", []), []);
});

// ---- Day / Month / YTD nav redesign (2026-09-22) --------------------------

test("stepDay moves one calendar day, uncapped going back, never past maxDay going forward", () => {
  assert.equal(stepDay("2026-08-22", 1, "2026-09-17"), "2026-08-23");
  assert.equal(stepDay("2026-08-22", -1, "2026-09-17"), "2026-08-21");
  assert.equal(stepDay("2026-09-01", -1, "2026-09-17"), "2026-08-31", "crosses a month boundary");
  assert.equal(stepDay("2026-09-17", 1, "2026-09-17"), null, "cannot step into the future");
  assert.equal(stepDay("2026-01-01", -365, "2026-09-17"), "2025-01-01", "a past day is always a real answer");
});

test("yearsWithData returns the distinct years, oldest first", () => {
  assert.deepEqual(yearsWithData(months), ["2025", "2026"]);
  assert.deepEqual(yearsWithData([]), []);
});

test("periodLabel: YTD reads '(Jan – Present)' for the real current year, '(Jan – Dec)' for a past one", () => {
  assert.equal(periodLabel({ mode: "ytd", month: "2026-06" }, "2026-09-17"), "2026 (Jan – Present)");
  assert.equal(periodLabel({ mode: "ytd", month: "2025-06" }, "2026-09-17"), "2025 (Jan – Dec)");
  // No `today` passed: every read-only caller across the dashboard views that
  // never shows the current in-progress year must keep working unchanged.
  assert.equal(periodLabel({ mode: "ytd", month: "2026-06" }), "2026");
  assert.equal(periodLabel({ mode: "monthly", month: "2026-08" }, "2026-09-17"), "Aug 2026", "monthly/day untouched by `today`");
});

test("warnDays: a time-audit flag carries the days that person's own ratio was outside the band", () => {
  const days = [
    { date: "2026-09-25", w: 480, p: 300 }, // 62.5% under
    { date: "2026-09-03", w: 480, p: 480 }, // 100% inside
    { date: "2026-09-10", w: 480, p: 400 }, // 83.3% under
    { date: "2026-09-12", w: 0, p: 60 },    // production with no clock: over, not NaN
    { date: "2026-09-13", w: 0, p: 0 },     // nothing: neither side
    { date: "2026-09-15", w: 480, p: 432 }, // exactly 90%: inside
  ];
  assert.deepEqual(warnDays(days, false, 90, 110), ["2026-09-10", "2026-09-25"], "under, sorted");
  assert.deepEqual(warnDays(days, true, 90, 110), ["2026-09-12"]);
  assert.equal(dayList(["2026-09-25"]), "25 Sep");
  assert.equal(dayList(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"]), "1 Sep, 2 Sep, 3 Sep +2 more");
  assert.equal(dayList([]), "");
});

test("overall efficiency is a weighted total over the period, not an average of daily %", () => {
  const byDay = [
    { date: "2026-09-01", workingMinutes: 600, productionMinutes: 300 }, // 50%
    { date: "2026-09-02", workingMinutes: 60, productionMinutes: 60 }, // 100%
    { date: "2026-08-31", workingMinutes: 999, productionMinutes: 1 }, // other month
  ];
  const sep = { mode: "monthly", month: "2026-09" };
  // (300 + 60) / (600 + 60) = 54.5%, where the mean of 50% and 100% would be 75%.
  assert.equal(overallEfficiencyPct(byDay, sep).toFixed(1), "54.5");
  assert.equal(overallEfficiencyPct(byDay, { ...sep, day: "2026-09-02" }), 100);
  // No clocked time in the period: null (the card shows a dash), never 0.
  assert.equal(overallEfficiencyPct(byDay, { mode: "monthly", month: "2026-07" }), null);
  assert.equal(overallEfficiencyPct([], sep), null);
});

test("overall efficiency skips days whose hours are not in yet", () => {
  // Today: cards completed, hours entered after the day. Its earned minutes
  // must not push the month up, and the day on its own has no figure.
  const byDay = [
    { date: "2026-09-24", workingMinutes: 600, productionMinutes: 540 }, // 90%
    { date: "2026-09-25", workingMinutes: 0, productionMinutes: 300 },
  ];
  const sep = { mode: "monthly", month: "2026-09" };
  assert.equal(overallEfficiencyPct(byDay, sep), 90);
  assert.equal(overallEfficiencyPct(byDay, { ...sep, day: "2026-09-25" }), null);
});
