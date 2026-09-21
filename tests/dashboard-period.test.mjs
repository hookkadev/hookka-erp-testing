// dashboard-period.test.mjs — the period picker's pure logic, shared by the
// desktop PeriodPicker and the /m PeriodChip (dashboard-shared-lib.ts).
import test from "node:test";
import assert from "node:assert/strict";
import {
  stepPeriod, periodPresets, presetActive, calendarCells, shiftMonth,
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

test("presets anchor to the newest day WITH DATA, not the clock or the month end", () => {
  const p = periodPresets("2026-09-15", months);
  assert.deepEqual(p.map((x) => x.label), ["Today", "Yesterday", "Last 7 Days"]);
  assert.deepEqual(p[0].period, { mode: "monthly", month: "2026-09", day: "2026-09-15" });
  assert.deepEqual(p[1].period, { mode: "monthly", month: "2026-09", day: "2026-09-14" });
  assert.deepEqual(p[2].period, { mode: "range", month: "2026-09", from: "2026-09-09", to: "2026-09-15", label: "Last 7 Days" });
});

test("presets cross a month boundary, fall back to the newest month, and are empty with no data", () => {
  const p = periodPresets("2026-09-02", months);
  assert.equal(p[1].period.day, "2026-09-01");
  assert.deepEqual([p[2].period.from, p[2].period.to, p[2].period.month], ["2026-08-27", "2026-09-02", "2026-08"]);
  assert.equal(periodPresets("", months)[0].period.day, "2026-09-01");
  assert.deepEqual(periodPresets("", []), []);
});

test("presetActive: a day preset matches the highlighted day, a range preset the exact window", () => {
  const [today, , last7] = periodPresets("2026-09-15", months);
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
