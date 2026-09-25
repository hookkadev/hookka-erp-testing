// summariseQueue — per-model OCR tab aggregation (src/api/lib/ocr-accuracy-core.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const { summariseQueue, rowOutcome, percentile } = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/ocr-accuracy-core.ts")).href
);

const po = { customerPO: "PO-1", customerName: "Houzs", items: [{ productCode: "A", quantity: 2 }] };
const row = (o) => ({
  id: o.id ?? "q", kind: "po", model: "claude-sonnet-4-6", status: "done", secs: 10,
  consumed: true, raw: po, corrected: null, fileName: "f.pdf", error: null,
  createdAt: "2026-09-01T00:00:00Z", ...o,
});

test("outcomes: failed / clean / edited / discarded / pending", () => {
  assert.equal(rowOutcome(row({ status: "failed" })).outcome, "failed");
  assert.equal(rowOutcome(row({ corrected: po })).outcome, "clean");
  const e = rowOutcome(row({ corrected: { ...po, items: [{ productCode: "A", quantity: 3 }] } }));
  assert.equal(e.outcome, "edited");
  assert.deepEqual(e.fields, ["Qty"]);
  assert.equal(rowOutcome(row({})).outcome, "discarded");
  assert.equal(rowOutcome(row({ consumed: false })).outcome, "pending");
});

test("groups by kind × model; failures count against the model, not hidden", () => {
  const { groups, problems } = summariseQueue([
    row({ id: "1", corrected: po, secs: 4 }),
    row({ id: "2", corrected: { ...po, customerPO: "PO-2" }, secs: 6, createdAt: "2026-09-03" }),
    row({ id: "3", status: "failed", error: "timeout", secs: 99, createdAt: "2026-09-02" }),
    row({ id: "4", model: null }),
    row({ id: "5", kind: "supplier", model: "claude-haiku-4-5", corrected: { docs: [] }, raw: { docs: [] } }),
  ]);
  const son = groups.find((g) => g.kind === "po" && g.model === "claude-sonnet-4-6");
  assert.equal(son.scans, 3);
  assert.equal(son.imported, 2);
  assert.equal(son.accuracy, 50);
  assert.equal(son.failureRate, 33.3);
  assert.equal(son.avgSec, 5); // failed row's time excluded
  assert.deepEqual(son.fields, [{ field: "Customer PO", fails: 1, rate: 50 }]);
  assert.ok(groups.some((g) => g.model === "Not recorded" && g.discarded === 1));
  assert.ok(groups.some((g) => g.kindLabel === "Supplier doc" && g.accuracy === 100));
  assert.deepEqual(problems.map((p) => p.id), ["2", "3"]); // newest first
});

test("percentile is nearest-rank", () => {
  assert.equal(percentile([], 90), null);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(percentile([5], 90), 5);
});
