// ---------------------------------------------------------------------------
// worker-today-live-hours.test.mjs — BUG-2026-10-01-243.
//
// GET /api/worker/today ticks "Hours worked today" for an open punch. It read
// the clock with UTC getHours() while clockIn is Malaysia wall time (UTC+8),
// so from clock-in until ~4pm the figure went negative, clamped to 0, and the
// worker home card hid it. The office POST /api/attendance defaulted its
// date/time from the same UTC clock.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { liveWorkingMinutes } from "../src/api/routes/worker.ts";

test("live minutes read the Malaysia clock, not UTC", () => {
  // 02:30 UTC = 10:30 in Malaysia. The old UTC maths gave 150 - 485 → 0.
  const now = Date.parse("2026-10-01T02:30:00Z");
  assert.equal(liveWorkingMinutes("08:05", now), 145);
});

test("late afternoon and just after clock-in", () => {
  assert.equal(liveWorkingMinutes("08:00", Date.parse("2026-10-01T09:45:00Z")), 585); // 17:45 MY
  assert.equal(liveWorkingMinutes("08:00", Date.parse("2026-10-01T00:00:00Z")), 0); // 08:00 MY
});

test("/today uses the helper; office punch defaults are Malaysia-local", () => {
  const worker = readFileSync(resolve(process.cwd(), "src/api/routes/worker.ts"), "utf8");
  const att = readFileSync(resolve(process.cwd(), "src/api/routes/attendance.ts"), "utf8");
  assert.ok(worker.includes(": liveWorkingMinutes(attendance.clockIn)"));
  assert.ok(!/\.getHours\(\)/.test(worker), "worker.ts must not read UTC getHours()");
  assert.ok(!/\.getHours\(\)/.test(att), "attendance.ts must not read UTC getHours()");
});
