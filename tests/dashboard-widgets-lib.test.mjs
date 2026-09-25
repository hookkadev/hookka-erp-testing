// ---------------------------------------------------------------------------
// dashboard-widgets-lib.test.mjs — the /dashboard formulas that
// /dashboard-experimental uses (src/pages/dashboards/dashboard-widgets-lib.ts,
// mirroring dashboard-b/index.tsx), the aging bucket sums and the truncating
// formatters (owner 2026-09-23: no rounding, truncate to 2 decimals).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import {
  CUR_YM, monthWindow, dispatchChain, pendingDeliveryTotalSen, orderPipeline,
  complianceSummary, deptBacklogRows, completedHeadline, stateTags, plantLoad,
  capacityPerWorkerMin, toQuarterly, fabricView, customerRevenue,
  concentrationShares, financeRatios,
} from "../src/pages/dashboards/dashboard-widgets-lib.ts";
import { agingBucketTotals } from "../src/lib/aging-export.ts";
import {
  truncDp, fmtDec2, fmtPct2, fmtRM2, fmtHM, widgetPeriod, widgetPeriodLabel,
} from "../src/pages/dashboards/dashboard-shared-lib.ts";
import { formatCurrency } from "../src/lib/utils.ts";

// ---- truncating formatters ------------------------------------------------

test("truncDp truncates, never rounds", () => {
  assert.equal(truncDp(0.29), 0.29, "a float that is 28.999… ×100 is still 0.29");
  assert.equal(truncDp(0.299), 0.29);
  assert.equal(truncDp(1.005), 1);
  assert.equal(truncDp(-1.239), -1.23);
  assert.ok(Object.is(truncDp(-0.001), 0), "-0 becomes 0");
  assert.equal(truncDp(NaN), 0);
  assert.equal(truncDp(12.3456, 1), 12.3);
});

test("fmtDec2 / fmtPct2 print truncated 2dp", () => {
  assert.equal(fmtDec2(-0.001), "0.00");
  assert.equal(fmtDec2(0.299), "0.29");
  assert.equal(fmtDec2(1234.567), "1,234.56");
  assert.equal(fmtPct2(66.6666), "66.66%");
  assert.equal(fmtPct2(null), "—");
  assert.equal(fmtPct2(undefined), "—");
});

test("fmtRM2 truncates to whole sen; fmtHM truncates minutes", () => {
  assert.equal(fmtRM2(12345.9), formatCurrency(12345));
  assert.equal(fmtRM2(-0.4), formatCurrency(0));
  assert.equal(fmtRM2(null), formatCurrency(0));
  assert.equal(fmtHM(125.9), "2h 5m");
  assert.equal(fmtHM(-5), "0h 0m");
  assert.equal(fmtHM(null), "0h 0m");
});

test("widgetPeriod: YTD reads all-time, anything else its month", () => {
  assert.equal(widgetPeriod({ mode: "ytd", month: "2026-09" }), "all");
  assert.equal(widgetPeriod({ mode: "monthly", month: "2026-09", day: "2026-09-23" }), "2026-09");
  assert.equal(widgetPeriod({ mode: "range", month: "2026-08", from: "2026-08-01", to: "2026-08-07" }), "2026-08");
  assert.equal(widgetPeriodLabel({ mode: "ytd", month: "2026-09" }), "All-time");
  assert.equal(widgetPeriodLabel({ mode: "monthly", month: "2026-09" }), "Sep 2026");
});

// ---- /dashboard formulas ----------------------------------------------------

test("CUR_YM and monthWindow", () => {
  assert.match(CUR_YM, /^\d{4}-\d{2}$/);
  assert.deepEqual(monthWindow("2026-02", "2026-09"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(monthWindow("2024-02", "2026-09"), { from: "2024-02-01", to: "2024-02-29" });
});

test("pending delivery = pending-value + DRAFT + LOADED + IN_TRANSIT", () => {
  const doStats = { valueByStatus: { DRAFT: 100, LOADED: 20, IN_TRANSIT: 3, DELIVERED: 9999 } };
  assert.deepEqual(dispatchChain(doStats), { pendingDispatchSen: 100, inTransitSen: 23 });
  assert.equal(pendingDeliveryTotalSen({ pendingDeliveryValueSen: 1000 }, doStats), 1123);
  assert.equal(pendingDeliveryTotalSen(null, null), 0);
});

test("orderPipeline: all-time from /stats, a month = same-cohort funnel", () => {
  const so = { csRevenueSen: 1000, deliveredItemsSen: 600, outstandingItemsSen: 400 };
  const ov = { salesThisMonthSen: 300, deliveredOfMonthOrdersSen: 200 };
  const all = orderPipeline("all", so, ov);
  assert.equal(all.monthScoped, false);
  assert.deepEqual([all.confirmed, all.delivered, all.outstanding], [1000, 600, 400]);
  assert.equal(all.deliveredRate, 60);
  const m = orderPipeline("2026-09", so, ov);
  assert.deepEqual([m.confirmed, m.delivered, m.outstanding], [300, 200, 100]);
  assert.equal(m.deliveredRate, (200 / 300) * 100, "unrounded — the caller truncates");
  assert.equal(fmtPct2(m.deliveredRate), "66.66%");
  assert.equal(orderPipeline("2026-09", so, {}).deliveredRate, 0);
});

test("complianceSummary: failed / partial / all clear, top-4 chips biggest first", () => {
  const failed = complianceSummary(null, true);
  assert.equal(failed.failed, true);
  assert.match(failed.caption, /not a clean day/);

  const counts = {
    total: 380, checksTotal: 15, overdueOrders: 5, soNoInvoice: 139, pricingIssues: 114,
    cogsIssues: 39, doNotInvoiced: 0, rdStalled: 7, processSkips: null,
  };
  const s = complianceSummary({ data: { counts } }, false);
  assert.deepEqual(s.chips, [["SO not invoiced", 139], ["Pricing issues", 114], ["COGS issues", 39], ["R&D stalled", 7]]);
  assert.equal(s.partial, false);

  const partial = complianceSummary({ data: { counts: { total: 0, checksTotal: 15 }, unavailable: [{ check: "x", message: "boom" }] } }, false);
  assert.equal(partial.partial, true);
  assert.doesNotMatch(partial.caption, /All clear/, "a partial sweep may not say All clear");

  assert.match(complianceSummary({ data: { counts: { total: 0 } } }, false).caption, /All clear/);
});

test("deptBacklogRows: stalled, filtered and the unrounded flag", () => {
  const depts = [
    { dept: "Sewing", sofaMin: 300, bedframeMin: 100, totalMin: 400, dailyCapMin: 150, backlogDays: 2.7 },
    { dept: "Foam", sofaMin: 50, bedframeMin: 0, totalMin: 50, dailyCapMin: 0, backlogDays: null },
  ];
  const server = deptBacklogRows(depts, true, true);
  assert.equal(server.rows[0].showDays, 2.7, "default = the server's 1dp figure (as /dashboard)");
  assert.equal(server.rows[1].showDays, null, "zero capacity is stalled, never divide by 1");
  const raw = deptBacklogRows(depts, true, true, true);
  assert.equal(raw.rows[0].showDays, 400 / 150, "unrounded = totalMin / dailyCapMin");
  assert.equal(fmtDec2(raw.rows[0].showDays), "2.66");
  const sofaOnly = deptBacklogRows(depts, true, false, true);
  assert.equal(sofaOnly.rows[0].showDays, 2, "one category off → only the visible segment's days");
  assert.equal(sofaOnly.rows[0].bedDays, 0);
  assert.equal(raw.mxDays, 400 / 150);
});

test("completedHeadline: yesterday on all-time, the range total on a month", () => {
  const prod = {
    completedYesterday: { bedframeUnits: 4, sofaSets: 2, byCustomer: [] },
    completedLast7: [{ date: "d1", bedframeUnits: 3, sofaSets: 2 }, { date: "d2", bedframeUnits: 5, sofaSets: 2 }],
    completedRange: { bedframeUnits: 8, sofaSets: 3 },
  };
  assert.deepEqual([completedHeadline("all", prod).bedframeUnits, completedHeadline("all", prod).sofaSets], [4, 2]);
  const m = completedHeadline("2026-09", prod);
  assert.deepEqual([m.bedframeUnits, m.sofaSets], [8, 3], "range total, not the double-counting day sum");
  const old = completedHeadline("2026-09", { ...prod, completedRange: undefined });
  assert.deepEqual([old.bedframeUnits, old.sofaSets], [8, 4], "falls back to the sum for an older payload");
});

test("stateTags", () => {
  assert.deepEqual(stateTags(undefined), { reconstructed: false, liveTag: false, asOf: null });
  assert.deepEqual(stateTags({ source: "live", isHistorical: true, asOf: null }), { reconstructed: false, liveTag: true, asOf: null });
  assert.deepEqual(stateTags({ source: "reconstructed", isHistorical: true, asOf: "2026-08-31" }), { reconstructed: true, liveTag: false, asOf: "2026-08-31" });
  assert.equal(stateTags({ source: "snapshot", isHistorical: true, asOf: "2026-08-15" }).asOf, "2026-08-15");
});

test("plantLoad: days / 14 buffer, red > 12, amber > 7, unrounded flag", () => {
  const prod = { dailyCapacityMin: 300, backlogMin: 2000, backlogDays: 6.7 };
  const server = plantLoad(prod);
  assert.equal(server.days, 6.7);
  assert.equal(server.tone, "green");
  const raw = plantLoad(prod, true);
  assert.equal(raw.days, 2000 / 300);
  assert.equal(fmtDec2(raw.days), "6.66");
  assert.equal(raw.bufferPct, (2000 / 300 / 14) * 100);
  assert.equal(plantLoad({ ...prod, backlogDays: 8 }).tone, "amber");
  assert.equal(plantLoad({ ...prod, backlogDays: 12.1 }).tone, "red");
  assert.equal(plantLoad({ ...prod, backlogDays: 30 }).util, 1, "capped at 100%");
  assert.equal(plantLoad({ ...prod, dailyCapacityMin: 0 }, true).days, 6.7, "no capacity → server figure");
  assert.equal(plantLoad(undefined).days, 0);
});

test("capacityPerWorkerMin skips days with no workers", () => {
  const days = [{ minutes: 600, workers: 2 }, { minutes: 0, workers: 0 }, { minutes: 900, workers: 4 }];
  assert.equal(capacityPerWorkerMin(days, 750), 250);
  assert.equal(capacityPerWorkerMin([{ minutes: 0, workers: 0 }], 750), null);
});

test("toQuarterly + fabricView", () => {
  const monthly = [
    { month: "2026-01", meters: 10 }, { month: "2026-02", meters: 5, lateMeters: 2 },
    { month: "2026-04", meters: 7 },
  ];
  assert.deepEqual(toQuarterly(monthly), [
    { label: "2026-Q2", meters: 7, lateMeters: 0 },
    { label: "2026-Q1", meters: 15, lateMeters: 2 },
  ]);
  const list = Array.from({ length: 12 }, (_, i) => ({
    fabCode: `F${i}`, meters: i, past30Meters: 0, next30Meters: 12 - i, buyAvgSen: 0, buyMinSen: 0, buyMaxSen: 0,
  }));
  const prev = fabricView({ list, monthly }, "prev", "month");
  assert.equal(prev.rows.length, 10);
  assert.equal(prev.rows[0].fabCode, "F11", "biggest usage first");
  assert.ok(prev.rows.every((r) => r.meters > 0), "zero-usage fabrics dropped");
  assert.equal(prev.trend[0].label, "2026-04", "newest first");
  assert.equal(prev.max, 10);
  const next = fabricView({ list, monthly }, "next", "quarter");
  assert.equal(next.rows[0].fabCode, "F0");
  assert.equal(next.trend[0].label, "2026-Q2");
  assert.deepEqual(fabricView(undefined, "prev", "month").rows, []);
});

test("concentrationShares: unrounded over the TOTAL, null without revenue", () => {
  const slice = { totalSen: 3000, customerCount: 20, largestName: "A", largestPct: 33.3, largestSen: 1000, top10Pct: 90, top10Sen: 2000 };
  const s = concentrationShares(slice);
  assert.equal(s.largestPct, (1000 / 3000) * 100);
  assert.equal(fmtPct2(s.largestPct), "33.33%", "not the server's rounded 33.3");
  assert.equal(s.top10Pct, (2000 / 3000) * 100);
  assert.deepEqual(concentrationShares({ ...slice, totalSen: 0 }), { largestPct: null, top10Pct: null });
  assert.deepEqual(concentrationShares(null), { largestPct: null, top10Pct: null });
});

test("customerRevenue: category revenue, server total as denominator, top 6 + Others", () => {
  const aov = Array.from({ length: 8 }, (_, i) => ({
    customerName: `C${i}`, bedframeAvgSen: 100, bedframeUnits: i, sofaAvgSen: 1000, sofaSets: i % 2, totalSen: 1000 - i * 10,
  }));
  const conc = (totalSen) => ({ totalSen, customerCount: 50, largestName: "C0", largestPct: 1, largestSen: 1000, top10Pct: 1, top10Sen: totalSen / 2 });
  const ov = {
    aovByCustomer: aov,
    customerConcentration: { all: conc(20000), bedframe: conc(5000), sofa: conc(0), shownCount: 12 },
  };
  const all = customerRevenue(ov, "all");
  assert.equal(all.totalSen, 20000, "the server total over ALL customers, not the shown subtotal");
  assert.equal(all.rows[0].customerName, "C0", "all keeps server order");
  assert.equal(all.composition.length, 7);
  const top6 = all.rows.slice(0, 6).reduce((s, r) => s + r.catRevSen, 0);
  assert.deepEqual(all.composition[6], { name: "Others", valueSen: 20000 - top6 });
  assert.equal(all.shares.largestPct, 5);

  const bed = customerRevenue(ov, "bedframe");
  assert.equal(bed.rows[0].customerName, "C7", "a category sorts by its own revenue");
  assert.equal(bed.rows[0].catRevSen, 700);
  assert.ok(bed.composition.every((c) => c.name === "Others" || c.valueSen > 0));

  const sofa = customerRevenue(ov, "sofa");
  assert.deepEqual(sofa.shares, { largestPct: null, top10Pct: null });

  const legacy = customerRevenue({ aovByCustomer: aov.slice(0, 2) }, "all");
  assert.equal(legacy.totalSen, 1000 + 990, "no concentration payload → shown subtotal");
  assert.equal(legacy.slice, null);
});

test("financeRatios: P&L summed, balance sheet from the last row, unrounded", () => {
  const rows = [
    { actual: { sales: 1000, gross: 300 }, balanceSheet: { currentAssets: 1, currentLiabilities: 1, inventory: 0 } },
    { actual: null, balanceSheet: null },
    { actual: { sales: 2000, gross: 700 }, balanceSheet: { currentAssets: 5000, currentLiabilities: 3000, inventory: 2000 } },
  ];
  const r = financeRatios(rows);
  assert.equal(r.grossMarginPct, (1000 / 3000) * 100);
  assert.equal(fmtPct2(r.grossMarginPct), "33.33%");
  assert.equal(r.currentRatio, 5000 / 3000);
  assert.equal(fmtDec2(r.currentRatio), "1.66", "the server rounds this to 1.67");
  assert.equal(r.quickRatio, 1);
  const none = financeRatios([{ actual: { sales: 0, gross: -5 }, balanceSheet: { currentAssets: 5, currentLiabilities: 0, inventory: 0 } }]);
  assert.deepEqual([none.grossMarginPct, none.currentRatio, none.quickRatio], [null, null, null], "denominator <= 0 → null");
  assert.equal(financeRatios([]).currentRatio, null);
});

test("agingBucketTotals: five buckets and their total", () => {
  const rows = [
    { currentSen: 100, days30Sen: 200, days60Sen: 0, days90Sen: 5, over90Sen: 50 },
    { currentSen: -10, days30Sen: 0, days60Sen: 30, days90Sen: 0, over90Sen: 0 },
  ];
  const t = agingBucketTotals(rows);
  assert.deepEqual(t.buckets.map((b) => b.period), ["Current", "1 month", "2 months", "3 months", "3+ months"]);
  assert.deepEqual(t.buckets.map((b) => b.amountSen), [90, 200, 30, 5, 50]);
  assert.equal(t.totalSen, 375);
  assert.equal(agingBucketTotals([]).totalSen, 0);
});
