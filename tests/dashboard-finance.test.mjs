// dashboard-finance.test.mjs — the Finance tab's pure maths (ROA/ROE/ROI,
// per-head, P/E rules incl. n/m and no-valuation, YoY with an empty prior
// year, forward forecast, headcount reconstruction) and the shared forecast.
import test from "node:test";
import assert from "node:assert/strict";
import {
  addMonths, buildFinancePayload, computeReturns, fiscalYearStart, headcountAt,
  peRatio, perHead, ratio, yoy, buildForecast,
} from "../src/api/lib/dashboard-finance.ts";
import { rollingForecast } from "../src/lib/revenue-forecast.ts";
import { countsToHeadcount } from "../src/api/lib/headcount-rule.ts";

const row = (ym, o = {}) => ({
  ym, revenueSen: 0, labourSen: 0, netProfitSen: 0,
  assetsSen: 0, liabilitiesSen: 0, ltLiabilitiesSen: 0, equitySen: 0, headcount: 0, ...o,
});
// 24 months 2024-09 .. 2026-08, revenue 1,000,000 sen, profit 100,000, labour 300,000, 10 heads
const series = (from, n, o) => Array.from({ length: n }, (_, i) => row(addMonths(from, i), o));
const full = series("2024-09", 24, {
  revenueSen: 1_000_000, labourSen: 300_000, netProfitSen: 100_000,
  assetsSen: 10_000_000, liabilitiesSen: 4_000_000, ltLiabilitiesSen: 1_000_000, equitySen: 6_000_000, headcount: 10,
});

test("ratio: null for zero/negative/absent denominators", () => {
  assert.equal(ratio(5, 10), 0.5);
  assert.equal(ratio(5, 0), null);
  assert.equal(ratio(5, -3), null);
  assert.equal(ratio(5, null), null);
});

test("perHead: sen per head, null without headcount", () => {
  assert.equal(perHead(300_000, 10), 30_000);
  assert.equal(perHead(300_000, 0), null);
  assert.equal(perHead(300_000, null), null);
});

test("returns: YTD as-is, monthly annualised x12; ROI = equity + long-term liabilities", () => {
  const bs = { assetsSen: 10_000_000, equitySen: 6_000_000, ltLiabilitiesSen: 1_000_000 };
  const ytd = computeReturns(700_000, "ytd", bs);
  assert.equal(ytd.annualised, false);
  assert.equal(ytd.roa, 0.07);
  assert.ok(Math.abs(ytd.roe - 700_000 / 6_000_000) < 1e-12);
  assert.ok(Math.abs(ytd.roi - 700_000 / 7_000_000) < 1e-12);
  const m = computeReturns(100_000, "monthly", bs);
  assert.equal(m.annualised, true);
  assert.equal(m.basisProfitSen, 1_200_000);
  assert.equal(m.roa, 0.12);
  assert.equal(computeReturns(1, "ytd", null).roa, null);
  assert.equal(computeReturns(1, "ytd", { assetsSen: 0, equitySen: -5, ltLiabilitiesSen: 0 }).roe, null);
});

test("P/E: no valuation shows no number; earnings <= 0 is n/m, never negative", () => {
  assert.deepEqual(peRatio(null, 100), { pe: null, status: "no-valuation" });
  assert.deepEqual(peRatio(0, 100), { pe: null, status: "no-valuation" });
  assert.deepEqual(peRatio(1000, null), { pe: null, status: "no-data" });
  assert.deepEqual(peRatio(1000, 0), { pe: null, status: "nm" });
  assert.deepEqual(peRatio(1000, -50), { pe: null, status: "nm" });
  assert.deepEqual(peRatio(1000, 250), { pe: 4, status: "ok" });
});

test("yoy: empty prior year is absent, not zero", () => {
  const none = yoy(500, 0, false);
  assert.equal(none.hasPrior, false);
  assert.equal(none.prior, null);
  assert.equal(none.deltaAbs, null);
  assert.equal(none.deltaPct, null);
  const y = yoy(150, 100, true);
  assert.deepEqual([y.deltaAbs, y.deltaPct], [50, 0.5]);
  assert.equal(yoy(10, 0, true).deltaPct, null); // 0 prior: no % (but abs is real)
  assert.equal(yoy(-50, -100, true).deltaPct, 0.5); // relative to |prior|
});

test("fiscalYearStart honours the FYE month", () => {
  assert.equal(fiscalYearStart("2026-08", 12), "2026-01");
  assert.equal(fiscalYearStart("2026-08", 3), "2026-04");
  assert.equal(fiscalYearStart("2026-02", 3), "2025-04");
});

test("payload (YTD): per head, returns, YoY and P/E variants over a full book", () => {
  const p = buildFinancePayload(full, { mode: "ytd", month: "2026-08", endYm: "2026-08", fyeMonth: 12, valuationSen: 12_000_000 });
  // 8 months Jan..Aug 2026
  assert.equal(p.perHead.headcount, 10);
  assert.equal(p.perHead.labourSen, 8 * 300_000);
  assert.equal(p.perHead.labourPerHeadSen, 240_000);
  assert.equal(p.perHead.revenuePerHeadSen, 800_000);
  assert.equal(p.returns.netProfitSen, 800_000);
  assert.equal(p.returns.annualised, false);
  assert.equal(p.returns.roa, 800_000 / 10_000_000);
  assert.equal(p.returns.liabilitiesVsAssets.liabilitiesToAssets, 0.4);
  assert.equal(p.coverage.priorHasData, true);
  assert.equal(p.yoy.revenue.deltaAbs, 0);
  assert.equal(p.yoy.roa.deltaAbs, 0);
  const by = Object.fromEntries(p.pe.variants.map((v) => [v.key, v]));
  // current: 8 months x 100k annualised = 1.2m; valuation 12m -> 10x
  assert.equal(by.current.earningsSen, 1_200_000);
  assert.equal(by.current.pe, 10);
  assert.equal(by.trailing.earningsSen, 1_200_000);
  assert.equal(by.lastYear.earningsSen, 1_200_000); // FY2025 fully covered (Jan-Dec 2025)
  assert.equal(by.forward.status, "ok");
  assert.equal(by.forward.earningsSen, 1_200_000); // flat revenue x 10% margin x 12
});

test("payload: no valuation -> every variant says so, with no P/E number", () => {
  const p = buildFinancePayload(full, { mode: "monthly", month: "2026-08", endYm: "2026-08", fyeMonth: 12, valuationSen: null });
  for (const v of p.pe.variants) {
    assert.equal(v.status, "no-valuation");
    assert.equal(v.pe, null);
  }
  assert.equal(p.returns.annualised, true);
});

test("payload: losses give n/m, not a negative P/E", () => {
  const loss = series("2024-09", 24, { revenueSen: 1_000_000, netProfitSen: -50_000, labourSen: 100_000, headcount: 5 });
  const p = buildFinancePayload(loss, { mode: "ytd", month: "2026-08", endYm: "2026-08", fyeMonth: 12, valuationSen: 5_000_000 });
  for (const v of p.pe.variants) {
    assert.equal(v.status, "nm");
    assert.equal(v.pe, null);
  }
});

test("payload: a young book (no prior year, <12 months) says so instead of faking", () => {
  const young = series("2026-04", 5, { revenueSen: 1_000_000, netProfitSen: 100_000, labourSen: 300_000, headcount: 10, assetsSen: 5_000_000, equitySen: 3_000_000, liabilitiesSen: 2_000_000 });
  const rows = [...series("2024-09", 19, {}), ...young]; // zeros before 2026-04
  const p = buildFinancePayload(rows, { mode: "ytd", month: "2026-08", endYm: "2026-08", fyeMonth: 12, valuationSen: 10_000_000 });
  assert.equal(p.coverage.priorHasData, false);
  assert.equal(p.yoy.revenue.hasPrior, false);
  assert.equal(p.yoy.revenue.prior, null);
  assert.equal(p.yoy.roa.hasPrior, false);
  const by = Object.fromEntries(p.pe.variants.map((v) => [v.key, v]));
  assert.equal(by.trailing.status, "no-data"); // 12 months not covered
  assert.equal(by.lastYear.status, "no-data");
  assert.equal(by.current.earningsSen, 500_000 * 12 / 5); // annualised over the 5 months with data
});

test("forecast: shared 3-month rolling average; profit = trailing margin x revenue", () => {
  const rows = [
    row("2026-05", { revenueSen: 100, netProfitSen: 10 }),
    row("2026-06", { revenueSen: 200, netProfitSen: 20 }),
    row("2026-07", { revenueSen: 300, netProfitSen: 30 }),
  ];
  const f = buildForecast(rows, "2026-07");
  assert.equal(f.marginPct, 10);
  const pj = f.points.filter((p) => p.projected);
  assert.equal(pj.length, 12);
  assert.equal(pj[0].ym, "2026-08");
  assert.equal(pj[0].revenueSen, 200); // (100+200+300)/3
  assert.equal(pj[0].profitSen, 20);
  assert.equal(f.next12RevenueSen, 2400);
  // under 3 months of data: revenue estimate yes, profit estimate no
  const g = buildForecast(rows.slice(0, 2), "2026-06");
  assert.equal(g.next12ProfitSen, null);
  assert.equal(buildForecast([], "2026-07").next12RevenueSen, null);
});

test("rollingForecast: the Sales tab's rule (target null until 3 prior months; hit flag)", () => {
  const { actual, projected } = rollingForecast([["2026-01", 30], ["2026-02", 30], ["2026-03", 30], ["2026-04", 40]], 2);
  assert.equal(actual[2].targetSen, null);
  assert.equal(actual[3].targetSen, 30);
  assert.equal(actual[3].hit, true);
  assert.deepEqual(projected.map((p) => [p.ym, p.sen]), [["2026-05", (30 + 30 + 40) / 3], ["2026-06", (30 + 30 + 40) / 3]]);
  assert.deepEqual(rollingForecast([], 3).projected, []);
});

test("headcount: shared ACTIVE non-TEST rule; finished months reconstructed from dates", () => {
  assert.equal(countsToHeadcount("ACTIVE", "E001"), true);
  assert.equal(countsToHeadcount("ACTIVE", "test9"), false);
  assert.equal(countsToHeadcount("RESIGNED", "E002"), false);
  const w = [
    { empNo: "E1", status: "ACTIVE", joinDate: "2025-01-10", resignedAt: null },
    { empNo: "E2", status: "RESIGNED", joinDate: "2024-01-01", resignedAt: "2026-06-15" },
    { empNo: "E3", status: "ACTIVE", joinDate: "2026-07-20", resignedAt: null },
    { empNo: "TEST1", status: "ACTIVE", joinDate: "2024-01-01", resignedAt: null },
    { empNo: "E4", status: "INACTIVE", joinDate: null, resignedAt: null },
  ];
  assert.equal(headcountAt(w, "2026-05", "2026-08", countsToHeadcount), 2); // E1 + E2
  assert.equal(headcountAt(w, "2026-06", "2026-08", countsToHeadcount), 1); // E2 left mid-June
  assert.equal(headcountAt(w, "2026-07", "2026-08", countsToHeadcount), 2); // E3 joined 20 Jul
  assert.equal(headcountAt(w, "2026-08", "2026-08", countsToHeadcount), 2); // live rule: E1 + E3
});
