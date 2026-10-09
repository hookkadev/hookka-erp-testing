// ---------------------------------------------------------------------------
// DEV-36 Department efficiency KPI: it must read exactly what Dashboard
// Experimental > People > Efficiency shows (src/api/lib/workforce-perf.ts).
//
// The page computes its figure in the browser: filterSlice (employee-filter.ts)
// narrows to a department's workers, overallEfficiencyPct (dashboard-shared-
// lib.ts) adds up the month. The KPI computes it on the server with
// poolEfficiencyPct. These tests feed both the same days and require the same
// number, so a change to either side that makes them disagree fails here.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPerfDays, poolEfficiencyPct, dailyEfficiencyPct } from "../src/api/lib/workforce-perf.ts";
import { filterSlice } from "../src/pages/dashboards/employee-filter.ts";
import { overallEfficiencyPct } from "../src/pages/dashboards/dashboard-shared-lib.ts";

const PROD = new Set(["FAB_CUT", "UPHOLSTERY"]);
const workers = [
  { id: "w1", name: "Ali", dept: "UPHOLSTERY" },
  { id: "w2", name: "Bala", dept: "UPHOLSTERY" },
  { id: "w3", name: "Chen", dept: "FAB_CUT" },
  { id: "w4", name: "Dina", dept: "R_AND_D" },
];
const { perfDays } = buildPerfDays({
  productionDepts: PROD,
  whe: [
    { workerId: "w1", date: "2026-09-01", departmentCode: "UPHOLSTERY", hours: 8 },
    { workerId: "w2", date: "2026-09-01", departmentCode: "UPHOLSTERY", hours: 8 },
    { workerId: "w3", date: "2026-09-01", departmentCode: "FAB_CUT", hours: 8 },
    { workerId: "w1", date: "2026-09-02", departmentCode: "UPHOLSTERY", hours: 4 },
    // Non-production hours never count as clocked time.
    { workerId: "w4", date: "2026-09-02", departmentCode: "R_AND_D", hours: 8 },
    { workerId: "w1", date: "2026-10-01", departmentCode: "UPHOLSTERY", hours: 8 },
  ],
  jobCards: [
    { id: "j1", departmentCode: "UPHOLSTERY", pic1Id: "w1", pic2Id: "w2", completedDate: "2026-09-01", estMinutes: 120, actualMinutes: null, wipQty: 4 },
    { id: "j2", departmentCode: "FAB_CUT", pic1Id: "w3", pic2Id: null, completedDate: "2026-09-01", estMinutes: 300, actualMinutes: null, wipQty: 3 },
    { id: "j3", departmentCode: "UPHOLSTERY", pic1Id: "w1", pic2Id: null, completedDate: "2026-09-02", estMinutes: 60, actualMinutes: 90, wipQty: 2 },
  ],
  pics: [],
});
const page = (dept) => {
  const slice = filterSlice({ workers, attendance: [], performance: { byDay: perfDays } }, dept, "");
  return overallEfficiencyPct(slice.performance.byDay, { mode: "monthly", month: "2026-09" });
};
const kpi = (depts) => {
  const ids = depts ? new Set(workers.filter((w) => depts.includes(w.dept)).map((w) => w.id)) : null;
  return poolEfficiencyPct(perfDays, ids, (d) => d.startsWith("2026-09")).pct;
};

test("one department: the KPI equals the page with that department picked", () => {
  assert.equal(kpi(["UPHOLSTERY"]), page("UPHOLSTERY"));
  assert.equal(kpi(["FAB_CUT"]), page("FAB_CUT"));
  // Upholstery, Sep: earned 480 + 120 (j3: est 60 x 2) = 600 min on 1200 clocked.
  assert.equal(kpi(["UPHOLSTERY"]), 50);
});

test("no department: the KPI equals the page with nothing picked (day totals)", () => {
  assert.equal(kpi(null), page(""));
});

test("several departments pool their minutes", () => {
  const p = poolEfficiencyPct(
    perfDays,
    new Set(["w1", "w2", "w3"]),
    (d) => d.startsWith("2026-09"),
  );
  // Upholstery 600 + Fab Cut 300 earned, on 1200 + 480 clocked.
  assert.equal(p.productionMinutes, 900);
  assert.equal(p.workingMinutes, 1680);
});

test("a department with only non-production hours has no figure, not 0%", () => {
  assert.equal(kpi(["R_AND_D"]), null);
});

test("the dashboard route builds its figures with the shared function", () => {
  const src = readFileSync("src/api/routes/dashboard-prototype.ts", "utf8");
  assert.ok(src.includes("buildPerfDays({"), "dashboard-prototype.ts must call buildPerfDays");
  assert.ok(!src.includes("perfByDayWorker"), "the inline copy must not come back");
});

// The card's chart must plot what the page's "Daily efficiency" line plots
// (DailyEfficiencyCard in EmployeesInsights.tsx: production ÷ working per day
// of the filtered slice, days with no working minutes dropped, 0.1 rounding).
test("daily line: the KPI card's points equal the page's Daily efficiency chart", () => {
  for (const dept of ["UPHOLSTERY", "FAB_CUT", ""]) {
    const slice = filterSlice({ workers, attendance: [], performance: { byDay: perfDays } }, dept, "");
    const pageLine = slice.performance.byDay
      .filter((d) => d.date.startsWith("2026-09") && d.workingMinutes > 0)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((d) => ({ date: d.date, pct: Math.round((d.productionMinutes / d.workingMinutes) * 1000) / 10 }));
    const ids = dept ? new Set(workers.filter((w) => w.dept === dept).map((w) => w.id)) : null;
    assert.deepEqual(dailyEfficiencyPct(perfDays, ids, (d) => d.startsWith("2026-09")), pageLine, dept || "whole floor");
  }
  // October hours never leak into a September line.
  assert.ok(dailyEfficiencyPct(perfDays, null, (d) => d.startsWith("2026-09")).every((p) => p.date.startsWith("2026-09")));
});
