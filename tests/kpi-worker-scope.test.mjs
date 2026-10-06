// DEV-36: which floor workers the KPI Library lists for a set of ticked
// departments (src/lib/kpi-worker-scope.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { workerInScope, workerDepts } from "../src/lib/kpi-worker-scope.ts";

const PROD = new Set(["FAB_CUT", "FAB_SEW", "PACKING"]);
const cutter = { departmentCodes: ["FAB_CUT"], categories: ["SOFA"], status: "ACTIVE" };
const sewerAny = { departmentCode: "FAB_SEW", departmentCodes: [], categories: [], status: "ACTIVE" };
const office = { departmentCode: "OFFICE", status: "ACTIVE" };
const resigned = { departmentCodes: ["FAB_CUT"], status: "RESIGNED" };

test("Overall (nothing ticked) lists every active production worker", () => {
  assert.equal(workerInScope(cutter, [], PROD), true);
  assert.equal(workerInScope(sewerAny, [], PROD), true);
  assert.equal(workerInScope(office, [], PROD), false);
  assert.equal(workerInScope(resigned, [], PROD), false);
});

test("a department entry matches the worker's own departments", () => {
  assert.equal(workerInScope(cutter, ["FAB_CUT"], PROD), true);
  assert.equal(workerInScope(cutter, ["FAB_SEW"], PROD), false);
  // Single departmentCode is used when the list is empty.
  assert.deepEqual(workerDepts(sewerAny), ["FAB_SEW"]);
  assert.equal(workerInScope(sewerAny, ["FAB_SEW"], PROD), true);
});

test("a typed entry needs the type, unless the worker lists none", () => {
  assert.equal(workerInScope(cutter, ["FAB_CUT:SOFA"], PROD), true);
  assert.equal(workerInScope(cutter, ["FAB_CUT:BEDFRAME"], PROD), false);
  assert.equal(workerInScope(sewerAny, ["FAB_SEW:BEDFRAME"], PROD), true);
});

test("several entries: any one is enough", () => {
  assert.equal(workerInScope(cutter, ["FAB_SEW", "FAB_CUT:SOFA"], PROD), true);
  assert.equal(workerInScope(resigned, ["FAB_CUT"], PROD), false);
});
