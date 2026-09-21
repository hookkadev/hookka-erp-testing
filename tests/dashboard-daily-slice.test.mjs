// dashboard-daily-slice.test.mjs — the "Daily (Lim)" feed slice definitions:
// plan = target_end_date day, actual = COMPLETED on completed_date day, cancelled
// excluded, revenue = poValueSen of orders completed that day, null when values
// could not be loaded, unpriced completed orders counted not hidden.
import test from "node:test";
import assert from "node:assert/strict";
import { buildDailySlice } from "../src/api/lib/dashboard-daily-slice.ts";

const po = (id, status, qty, target, done) => ({ id, status, quantity: qty, targetEndDate: target, completedDate: done });

test("orders: plan by target day, actual by completion day, cancelled excluded", () => {
  const s = buildDailySlice(
    [
      po("a", "COMPLETED", "3", "2026-09-01", "2026-09-02T08:00:00Z"),
      po("b", "PENDING", 2, "2026-09-01", null),
      po("c", "CANCELLED", 9, "2026-09-01", null),
      po("d", "COMPLETED", 1, null, "2026-09-02"),
    ],
    [],
    new Map(),
  );
  const d1 = s.orders.byDay.find((d) => d.date === "2026-09-01");
  const d2 = s.orders.byDay.find((d) => d.date === "2026-09-02");
  assert.deepEqual([d1.planOrders, d1.planUnits, d1.actualOrders], [2, 5, 0]);
  assert.deepEqual([d2.planOrders, d2.actualOrders, d2.actualUnits], [0, 2, 4]);
  assert.equal(s.orders.withoutTarget, 1);
  assert.equal(s.orders.completedTotal, 2);
});

test("stages: due_date plan vs completed/transferred actual per department", () => {
  const jc = (dept, status, due, done) => ({ departmentCode: dept, status, dueDate: due, completedDate: done });
  const s = buildDailySlice([], [
    jc("SEW", "COMPLETED", "2026-09-01", "2026-09-01"),
    jc("SEW", "TRANSFERRED", "2026-09-01", "2026-09-02"),
    jc("SEW", "CANCELLED", "2026-09-01", null),
    jc("CUT", "PENDING", null, null),
  ], null);
  const sew1 = s.stages.byDay.find((r) => r.dept === "SEW" && r.date === "2026-09-01");
  assert.deepEqual([sew1.plan, sew1.actual], [2, 1]);
  assert.equal(s.stages.byDay.find((r) => r.date === "2026-09-02").actual, 1);
  assert.equal(s.stages.cardsWithoutDue, 1);
});

test("revenue: sen per completion day, unpriced counted, null without value map", () => {
  const rows = [po("a", "COMPLETED", 1, null, "2026-09-02"), po("b", "COMPLETED", 1, null, "2026-09-02"), po("c", "PENDING", 1, null, null)];
  const s = buildDailySlice(rows, [], new Map([["a", 12345.4]]));
  assert.deepEqual(s.revenue.byDay, [{ date: "2026-09-02", orders: 2, unpricedOrders: 1, revenueSen: 12345 }]);
  assert.equal(s.revenue.unpricedOrders, 1);
  const n = buildDailySlice(rows, [], null, "boom");
  assert.equal(n.revenue, null);
  assert.equal(n.revenueError, "boom");
});
