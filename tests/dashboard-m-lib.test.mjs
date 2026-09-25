// dashboard-m-lib.test.mjs — /m dashboard pure logic + the desktop calculations
// extracted into dashboard-sales-lib.ts (shared by desktop views and /m).
import test from "node:test";
import assert from "node:assert/strict";
import {
  readPeriod, writePeriod, resolvePeriod, tapBucket, compactSen, MOBILE_TABS,
} from "../src/pages/m/screens/dashboard/dashboard-m-lib.ts";
import {
  buildSalesTrend, computeSalesKpis, previousSalesKpis, customerRevenue, overviewTotals, pctDelta,
} from "../src/pages/dashboards/dashboard-sales-lib.ts";
import { opensOnToday } from "../src/pages/dashboards/dashboard-shared-lib.ts";

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
  // Today is outside the book here, so nothing opens on a day.
  assert.deepEqual(resolvePeriod({ mode: "monthly", month: "" }, months, "2026-11-03"), { mode: "monthly", month: "2026-08" });
  assert.equal(resolvePeriod({ mode: "monthly", month: "1999-01" }, months, "2026-11-03").month, "2026-08");
  assert.equal(resolvePeriod({ mode: "monthly", month: "2026-06" }, months, "2026-11-03").month, "2026-06");
});

test("a bare URL opens on TODAY; anything the user picked is left alone", () => {
  const today = "2026-08-14";
  assert.deepEqual(resolvePeriod({ mode: "monthly", month: "" }, months, today), { mode: "monthly", month: "2026-08", day: today });
  // Cleared highlight (month now in the URL), another month, a picked day, YTD, a range: untouched.
  assert.deepEqual(resolvePeriod({ mode: "monthly", month: "2026-08" }, months, today), { mode: "monthly", month: "2026-08" });
  assert.deepEqual(resolvePeriod({ mode: "monthly", month: "2026-06" }, months, today), { mode: "monthly", month: "2026-06" });
  assert.equal(resolvePeriod({ mode: "monthly", month: "2026-07", day: "2026-07-02" }, months, today).day, "2026-07-02");
  assert.equal(resolvePeriod({ mode: "ytd", month: "" }, months, today).day, undefined);
  assert.equal(resolvePeriod({ mode: "range", month: "", from: "2026-08-01", to: "2026-08-07" }, months, today).day, undefined);
  // Feed not loaded yet: no months, so no day and no crash.
  assert.deepEqual(resolvePeriod({ mode: "monthly", month: "" }, [], today), { mode: "monthly", month: "" });
});

test("Overview and Sales open on the MONTH; the other tabs open on today", () => {
  const today = "2026-08-14";
  for (const tab of ["overview", "sales"]) assert.equal(opensOnToday(tab), false, tab);
  for (const tab of ["operations", "people", "service", "finance", undefined]) assert.equal(opensOnToday(tab), true, String(tab));
  // Bare URL on a monthly tab: this month, no day.
  assert.deepEqual(resolvePeriod({ mode: "monthly", month: "" }, months, today, false), { mode: "monthly", month: "2026-08" });
  // A day the user picked is still honoured there.
  assert.equal(resolvePeriod({ mode: "monthly", month: "2026-08", day: "2026-08-03" }, months, today, false).day, "2026-08-03");
});

test("Overview totals follow a focused day and compare it with the day before", () => {
  const byDay = [
    { date: "2026-08-13", orders: 2, revenueSen: 200 },
    { date: "2026-08-14", orders: 3, revenueSen: 300 },
    { date: "2026-08-20", orders: 9, revenueSen: 900 },
  ];
  const day = overviewTotals(byDay, { mode: "monthly", month: "2026-08", day: "2026-08-14" }, months);
  assert.deepEqual([day.revenueSen, day.orders, day.prevRevenueSen, day.prevLabel, day.deltaPct], [300, 3, 200, "13 Aug 2026", 50]);
  const month = overviewTotals(byDay, { mode: "monthly", month: "2026-08" }, months);
  assert.deepEqual([month.revenueSen, month.orders, month.prevLabel], [1400, 14, "Jul 2026"]);
  // First of the month: the day before is in the previous month.
  assert.equal(overviewTotals(byDay, { mode: "monthly", month: "2026-08", day: "2026-08-01" }, months).prevLabel, "31 Jul 2026");
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
  // Pending Delivery card carries its value: sum of SHIPPED orders only.
  const pd = computeSalesKpis([
    { customer: "A", status: "SHIPPED", totalSen: 700, createdAt: "2026-08-03" },
    { customer: "B", status: "SHIPPED", totalSen: 300, createdAt: "2026-08-04" },
    { customer: "C", status: "CONFIRMED", totalSen: 5000, createdAt: "2026-08-04" },
  ]);
  assert.equal(pd.pendingDelivery, 2);
  assert.equal(pd.pendingDeliverySen, 1000);
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
