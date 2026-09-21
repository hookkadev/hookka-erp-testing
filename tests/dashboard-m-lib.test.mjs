// dashboard-m-lib.test.mjs — /m dashboard pure logic + the desktop calculations
// extracted into dashboard-sales-lib.ts (shared by desktop views and /m).
import test from "node:test";
import assert from "node:assert/strict";
import {
  readPeriod, writePeriod, resolvePeriod, periodChoices, tapBucket, compactSen, MOBILE_TABS,
} from "../src/pages/m/screens/dashboard/dashboard-m-lib.ts";
import {
  buildSalesTrend, computeSalesKpis, previousSalesKpis, customerRevenue, overviewTotals, pctDelta,
} from "../src/pages/dashboards/dashboard-sales-lib.ts";

const months = ["2026-06", "2026-07", "2026-08"];

test("tabs are in the agreed order", () => {
  assert.deepEqual(MOBILE_TABS.map((t) => t.key), ["overview", "sales", "operations", "people", "service", "finance"]);
});

test("period round-trips through the URL and keeps sub + unrelated params", () => {
  const p = { mode: "monthly", month: "2026-07", day: "2026-07-12" };
  const q = writePeriod(new URLSearchParams("sub=plan&x=1"), p);
  assert.equal(q.get("sub"), "plan");
  assert.equal(q.get("x"), "1");
  assert.deepEqual(readPeriod(q), p);
  assert.equal(writePeriod(new URLSearchParams(), { mode: "monthly", month: "" }).toString(), "");
});

test("resolvePeriod falls back to the newest month; keeps a valid one", () => {
  assert.equal(resolvePeriod({ mode: "monthly", month: "" }, months).month, "2026-08");
  assert.equal(resolvePeriod({ mode: "monthly", month: "1999-01" }, months).month, "2026-08");
  assert.equal(resolvePeriod({ mode: "monthly", month: "2026-06" }, months).month, "2026-06");
});

test("periodChoices: months newest first; YTD lists years at their newest month", () => {
  assert.deepEqual(periodChoices(months, "monthly").map((c) => c.value), ["2026-08", "2026-07", "2026-06"]);
  assert.deepEqual(periodChoices(["2025-11", "2026-01", "2026-02"], "ytd"), [
    { value: "2026-02", label: "2026" },
    { value: "2025-11", label: "2025" },
  ]);
});

test("tapBucket: toggles a day; YTD opens the month", () => {
  const chart = [{ date: "01", iso: "2026-07-01" }, { date: "02", iso: "2026-07-02" }];
  const m = { mode: "monthly", month: "2026-07" };
  assert.equal(tapBucket(m, chart, "02").day, "2026-07-02");
  assert.equal(tapBucket({ ...m, day: "2026-07-02" }, chart, "02").day, undefined);
  assert.equal(tapBucket(m, chart, "99"), m);
  const y = { mode: "ytd", month: "2026-07" };
  assert.deepEqual(tapBucket(y, [{ date: "07", iso: "2026-07" }], "07"), { mode: "monthly", month: "2026-07" });
});

test("compactSen", () => {
  const full = (s) => `full:${s}`;
  assert.equal(compactSen(123_456_700, full), "RM 1.23M");
  assert.equal(compactSen(45_670_000, full), "RM 456.7k");
  assert.equal(compactSen(9_999_900, full), "full:9999900");
});

test("buildSalesTrend zero-fills days, caps at today, rolls YTD per month", () => {
  const byDay = [
    { date: "2026-07-02", orders: 2, revenueSen: 50000 },
    { date: "2026-07-04", orders: 1, revenueSen: 10000 },
  ];
  const t = buildSalesTrend(byDay, { mode: "monthly", month: "2026-07" }, "2026-07-05");
  assert.deepEqual(t.map((d) => d.Revenue), [0, 500, 0, 100, 0]);
  assert.equal(t[1].iso, "2026-07-02");
  const y = buildSalesTrend(byDay, { mode: "ytd", month: "2026-07" }, "2026-12-31");
  assert.deepEqual(y, [{ date: "07", iso: "2026-07", Revenue: 600, Orders: 3 }]);
});

test("sales KPIs count confirmed orders only; previous is null while a day is focused", () => {
  const orders = [
    { customer: "A", status: "CONFIRMED", totalSen: 1000, createdAt: "2026-08-03" },
    { customer: "A", status: "DRAFT", totalSen: 9999, createdAt: "2026-08-03" },
    { customer: "B", status: "CONFIRMED", totalSen: 3000, createdAt: "2026-07-03" },
  ];
  const k = computeSalesKpis(orders.slice(0, 2));
  assert.equal(k.soCount, 1);
  assert.equal(k.revenueSen, 1000);
  const p = { mode: "monthly", month: "2026-08" };
  assert.deepEqual(previousSalesKpis(orders, p, months, false), { label: "Jul 2026", count: 1, revenueSen: 3000 });
  assert.equal(previousSalesKpis(orders, p, months, true), null);
  assert.equal(pctDelta(1500, 1000), "+50.0%");
});

test("customerRevenue ranks by revenue; null customer = Unnamed", () => {
  const r = customerRevenue([
    { customer: null, status: "X", totalSen: 5, createdAt: null },
    { customer: "B", status: "X", totalSen: 9, createdAt: null },
    { customer: "B", status: "X", totalSen: 1, createdAt: null },
  ]);
  assert.deepEqual(r, [{ name: "B", revenueSen: 10, count: 2 }, { name: "Unnamed", revenueSen: 5, count: 1 }]);
});

test("overviewTotals delta is null with no previous revenue", () => {
  const t = overviewTotals([{ date: "2026-06-02", orders: 1, revenueSen: 100 }], { mode: "monthly", month: "2026-06" }, months);
  assert.equal(t.deltaPct, null);
  assert.equal(t.revenueSen, 100);
});
