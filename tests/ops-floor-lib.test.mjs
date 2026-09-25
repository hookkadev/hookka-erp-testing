// Operations > Overview department board: joins backlog (keyed by name) with
// overdue / due-soon (keyed by job-card code). A broken join silently shows
// a department as "0 overdue" on its own row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deptStatusRows, daysTone, deptName } from "../src/pages/dashboards/ops-floor-lib.ts";

test("deptStatusRows joins code-keyed counts onto name-keyed backlog, floor order", () => {
  const backlog = [{ d: { dept: "Packing" } }, { d: { dept: "Fabric Cutting" } }];
  const rows = deptStatusRows(
    backlog,
    [{ department: "FAB_CUT", count: 3 }, { department: "MYSTERY", count: 1 }],
    [{ currentDept: "PACKING" }, { currentDept: "PACKING" }, { currentDept: null }],
  );
  assert.deepEqual(
    rows.map((r) => [r.name, r.overdue, r.dueSoon, !!r.backlog]),
    [
      ["Fabric Cutting", 3, 0, true],
      ["Packing", 0, 2, true],
      ["MYSTERY", 1, 0, false],
      ["(no dept)", 0, 1, false],
    ],
  );
});

test("daysTone uses plantLoad's cut-offs; stalled is red", () => {
  assert.equal(daysTone(7), "green");
  assert.equal(daysTone(7.01), "amber");
  assert.equal(daysTone(12), "amber");
  assert.equal(daysTone(12.01), "red");
  assert.equal(daysTone(null), "red");
  assert.equal(deptName("UPHOLSTERY"), "Upholstery");
});
