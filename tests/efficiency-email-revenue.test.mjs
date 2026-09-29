// ---------------------------------------------------------------------------
// efficiency-email-revenue.test.mjs — BUG-36: the evening efficiency email
// carries production revenue, from the SAME query as the dashboard's Daily
// (Lim) tab (owner-confirmed 28 Sep 2026 = RM 12,002.50).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  renderEfficiencyHtml,
  renderEfficiencyEmailText,
} from "../src/api/lib/efficiency-report.ts";
import { productionRevenueByDay } from "../src/api/lib/production-revenue.ts";

const base = {
  date: "2026-09-28",
  generatedAtIso: "2026-09-28T10:30:00Z",
  totals: { presentCount: 0, workerCount: 0, workingMinutes: 0, productionMinutes: 0, efficiencyPct: 0, jobsCompleted: 0 },
  departments: [],
  workers: [],
};

test("revenue shows in the email HTML and text", () => {
  const data = { ...base, revenue: { revenueSen: 1200250, orders: 24, unpricedOrders: 1 } };
  const html = renderEfficiencyHtml(data);
  assert.match(html, /Production Revenue/);
  assert.match(html, /RM 12,002\.50/);
  assert.match(html, /24 orders upholstered · 1 with no price/);
  assert.match(renderEfficiencyEmailText(data), /Production revenue: RM 12,002\.50/);
});

test("no revenue field = no revenue cell (the HR-readable in-app page)", () => {
  assert.doesNotMatch(renderEfficiencyHtml(base), /Production Revenue/);
  assert.doesNotMatch(renderEfficiencyEmailText(base), /Production revenue/);
});

test("a failed revenue load says unavailable, never RM 0", () => {
  const data = { ...base, revenue: null };
  assert.match(renderEfficiencyHtml(data), /unavailable/);
  assert.doesNotMatch(renderEfficiencyHtml(data), /RM 0\.00/);
  assert.match(renderEfficiencyEmailText(data), /Production revenue: unavailable/);
});

test("productionRevenueByDay filters to the requested day", async () => {
  const rows = [
    { date: "2026-09-27", orders: 3, unpricedOrders: 0, revenueSen: 100 },
    { date: "2026-09-28", orders: 24, unpricedOrders: 1, revenueSen: 1200250 },
  ];
  let bound;
  const db = { prepare: () => ({ bind: (...v) => ((bound = v), { all: async () => ({ results: rows }) }) }) };
  assert.deepEqual(await productionRevenueByDay(db, "hookka", "2026-09-28"), [rows[1]]);
  assert.deepEqual(bound, ["hookka"]);
  assert.equal((await productionRevenueByDay(db, "hookka")).length, 2);
});

test("dashboard and email share one revenue query", () => {
  const dash = readFileSync("src/api/routes/dashboard-prototype.ts", "utf8");
  assert.match(dash, /productionRevenueByDay\(c\.var\.DB, orgId\)/);
  assert.doesNotMatch(dash, /department_code = 'UPHOLSTERY'\s+GROUP BY production_order_id/);
  const rep = readFileSync("src/api/routes/reports.ts", "utf8");
  assert.match(rep, /productionRevenueByDay\(c\.var\.DB, orgId, date\)/);
});
