// ---------------------------------------------------------------------------
// schedule-department-share.test.mjs: the Production Schedule has a department
// summary under the top boxes (job cards, planned time, share of the day's time
// and of its job cards, heaviest first) and a "Show full list" link in the email.
// Display only: every figure is already on the department headers.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { renderScheduleHtml } from "../src/api/lib/schedule-overdue-report.ts";

const dept = (code, name, count, prodMinutes) => ({ code, name, count, quantity: count, prodMinutes, rows: [] });
const data = {
  date: "2026-10-02",
  generatedAtIso: "2026-10-02T00:00:00.000Z",
  totals: { jobCards: 100, departments: 3, quantity: 100, prodMinutes: 1000 },
  byDepartment: [dept("A", "Light", 20, 100), dept("B", "Heavy", 50, 600), dept("C", "Middle", 30, 300)],
};
const url = "https://example.test/api/reports/schedule?date=2026-10-02";

test("department table: heaviest first, shares of planned time and of job cards", () => {
  const html = renderScheduleHtml(data, { email: true, fullListUrl: url });
  const rows = [...html.matchAll(/<tr><td>(\w+)<\/td><td class="num">(\d+)<\/td><td class="num">([^<]+)<\/td><td class="num">([^<]+)<\/td><td class="num">([^<]+)<\/td><\/tr>/g)].map((m) => m.slice(1));
  assert.deepEqual(rows.map((r) => r[0]), ["Heavy", "Middle", "Light"]);
  assert.deepEqual(rows[0], ["Heavy", "50", "10h", "60.0%", "50.0%"]);
  assert.deepEqual(rows[2], ["Light", "20", "1h 40m", "10.0%", "20.0%"]);
  assert.match(html, /<th>% of planned time<\/th><th>% of job cards<\/th>/);
});

test("the email links to the full list under the table; the in-app page does not repeat it", () => {
  assert.ok(renderScheduleHtml(data, { email: true, fullListUrl: url }).includes(`<a href="${url}">Show full list</a>`));
  assert.match(renderScheduleHtml(data, { email: true }), /Full list in Reports/);
  assert.doesNotMatch(renderScheduleHtml(data), /Show full list|Full list in Reports/);
});

test("no departments: no table, no division by zero", () => {
  const empty = { ...data, totals: { jobCards: 0, departments: 0, quantity: 0, prodMinutes: 0 }, byDepartment: [] };
  assert.doesNotMatch(renderScheduleHtml(empty, { email: true }), /class="share"/);
  const zero = { ...data, totals: { ...data.totals, prodMinutes: 0, jobCards: 0 } };
  assert.match(renderScheduleHtml(zero, { email: true }), /<td class="num">—<\/td><td class="num">—<\/td><\/tr>/);
});
