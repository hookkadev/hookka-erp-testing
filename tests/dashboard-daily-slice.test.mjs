// dashboard-daily-slice.test.mjs — the "Daily (Lim)" feed slice definitions:
// plan vs actual is job-card based (the Schedule email's job cards / units /
// planned time): plan = due_date day, actual = COMPLETED/TRANSFERRED on
// completed_date day, cancelled cards and cards of cancelled orders excluded;
// revenue = the SQL's per-day rows (last-UPH-JC day, same as the main
// dashboard) passed through sorted + numeric, null when the query failed.
import test from "node:test";
import assert from "node:assert/strict";
import { buildDailySlice } from "../src/api/lib/dashboard-daily-slice.ts";

const po = (id, status, qty) => ({ id, status, quantity: qty });

test("stages: job cards, units and planned time, plan by due day vs actual by completion day", () => {
  const jc = (po, dept, status, due, done, est, wip, act = null) => ({
    productionOrderId: po, departmentCode: dept, status, dueDate: due, completedDate: done,
    estMinutes: est, actualMinutes: act, wipQty: wip,
  });
  const s = buildDailySlice(
    [po("p1", "IN_PROGRESS", "2"), po("p2", "PENDING", 3), po("px", "CANCELLED", 9)],
    [
      jc("p1", "SEW", "COMPLETED", "2026-09-01", "2026-09-01", "10", "2"),
      jc("p2", "SEW", "TRANSFERRED", "2026-09-01", "2026-09-02", 5, 3, 99),
      jc("p1", "SEW", "CANCELLED", "2026-09-01", null, 10, 1),
      jc("px", "SEW", "WAITING", "2026-09-01", null, 10, 1),
      // FAB_CUT stores the per-SET total: not multiplied by wipQty.
      jc("p2", "FAB_CUT", "WAITING", "2026-09-01", null, 30, 4),
      // No estimate: falls back to actual minutes.
      jc("p1", "UPH", "COMPLETED", "2026-09-02", "2026-09-02", null, 1, 7),
      jc("p1", "CUT", "PENDING", null, null, 1, 1),
    ],
    null,
  );
  const row = (dept, date) => s.stages.byDay.find((r) => r.dept === dept && r.date === date);
  const sew1 = row("SEW", "2026-09-01");
  assert.deepEqual([sew1.plan, sew1.planUnits, sew1.planMin], [2, 5, 35]);
  assert.deepEqual([sew1.actual, sew1.actualUnits, sew1.actualMin], [1, 2, 20]);
  // Actual uses the same estimate as plan, so the late card books 15 min, not 99×3.
  const sew2 = row("SEW", "2026-09-02");
  assert.deepEqual([sew2.plan, sew2.actual, sew2.actualUnits, sew2.actualMin], [0, 1, 3, 15]);
  assert.deepEqual([row("FAB_CUT", "2026-09-01").planMin, row("FAB_CUT", "2026-09-01").planUnits], [30, 3]);
  assert.equal(row("UPH", "2026-09-02").actualMin, 7);
  assert.equal(s.stages.cardsWithoutDue, 1);
  assert.equal("orders" in s, false);
});

test("revenue: per-day SQL rows normalised + sorted, unpriced summed, null on error", () => {
  // Postgres hands SUM/COUNT back as strings; the slice must not concatenate them.
  const s = buildDailySlice([], [], [
    { date: "2026-09-22", orders: "3", unpricedOrders: "1", revenueSen: "1413400" },
    { date: "2026-09-21T00:00:00", orders: 1, unpricedOrders: 0, revenueSen: 12345.4 },
  ]);
  assert.deepEqual(s.revenue.byDay, [
    { date: "2026-09-21", orders: 1, unpricedOrders: 0, revenueSen: 12345 },
    { date: "2026-09-22", orders: 3, unpricedOrders: 1, revenueSen: 1413400 },
  ]);
  assert.equal(s.revenue.unpricedOrders, 1);
  // Revenue is NOT derived from PO status/completed_date any more.
  const byPo = buildDailySlice([po("a", "COMPLETED", 1)], [], []);
  assert.deepEqual(byPo.revenue.byDay, []);
  const n = buildDailySlice([], [], null, "boom");
  assert.equal(n.revenue, null);
  assert.equal(n.revenueError, "boom");
});
