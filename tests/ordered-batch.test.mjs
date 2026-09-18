// ---------------------------------------------------------------------------
// ordered-batch — "complete the earlier step too" completes the earlier step
// FIRST, proven by watching what happens, not by reading a line of source
// (PRD T-013 R6/R7).
//
// The old bulk-patch dispatched every patch with Promise.all, so the order of
// the list said nothing about the order of execution: a slow upstream PATCH
// and a fast downstream PATCH landed downstream-first, the consume preceded
// the produce, and the remedy for a skipped stage created the very negative
// WIP row the lock exists to prevent.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runGroupedInOrder } from "../src/api/lib/ordered-batch.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("two patches on ONE order run one after the other, even when the first is slow", async () => {
  const events = [];
  const patches = [
    { poId: "PO-1", jobCardId: "FRAMING", delay: 40 }, // upstream, slow
    { poId: "PO-1", jobCardId: "WEBBING", delay: 1 }, // the blocked card, fast
  ];
  await runGroupedInOrder(
    patches,
    (p) => p.poId,
    async (p) => {
      events.push(`start ${p.jobCardId}`);
      await sleep(p.delay);
      events.push(`end ${p.jobCardId}`);
      return p.jobCardId;
    },
  );
  assert.deepEqual(events, ["start FRAMING", "end FRAMING", "start WEBBING", "end WEBBING"]);
});

test("under Promise.all the same input lands downstream-first — the bug, reproduced", async () => {
  // Kept so the scale of the fix is not re-argued: this is exactly what the
  // old handler did with the same two patches.
  const events = [];
  const patches = [
    { poId: "PO-1", jobCardId: "FRAMING", delay: 40 },
    { poId: "PO-1", jobCardId: "WEBBING", delay: 1 },
  ];
  await Promise.all(
    patches.map(async (p) => {
      events.push(`start ${p.jobCardId}`);
      await sleep(p.delay);
      events.push(`end ${p.jobCardId}`);
    }),
  );
  assert.equal(events[2], "end WEBBING", "downstream finished before upstream");
});

test("different orders still run side by side", async () => {
  const events = [];
  const patches = [
    { poId: "PO-1", jobCardId: "A", delay: 30 },
    { poId: "PO-2", jobCardId: "B", delay: 1 },
  ];
  const t0 = Date.now();
  await runGroupedInOrder(
    patches,
    (p) => p.poId,
    async (p) => {
      await sleep(p.delay);
      events.push(p.jobCardId);
    },
  );
  assert.deepEqual(events, ["B", "A"], "PO-2 did not wait for PO-1");
  assert.ok(Date.now() - t0 < 30 + 25, "ran concurrently, not 30 + 1 in series");
});

test("results come back in input order, whatever order they finished in", async () => {
  const out = await runGroupedInOrder(
    [
      { k: "x", v: 1, delay: 20 },
      { k: "y", v: 2, delay: 1 },
      { k: "x", v: 3, delay: 1 },
    ],
    (p) => p.k,
    async (p) => {
      await sleep(p.delay);
      return p.v * 10;
    },
  );
  assert.deepEqual(out, [10, 20, 30]);
});

test("a failure in one order does not stop the others, and is reported in place", async () => {
  const out = await runGroupedInOrder(
    [
      { k: "x", ok: false },
      { k: "y", ok: true },
    ],
    (p) => p.k,
    async (p) => (p.ok ? "ok" : "failed"),
  );
  assert.deepEqual(out, ["failed", "ok"]);
});

test("bulk-patch uses it, keyed by production order", () => {
  const po = readFileSync("src/api/routes/production-orders.ts", "utf8");
  const handler = po.slice(po.indexOf('app.post("/bulk-patch"'));
  const head = handler.slice(0, handler.indexOf("// ── Verify-readback"));
  assert.match(head, /runGroupedInOrder\(\s*patches,\s*\(p\) => String\(p\.poId \?\? ""\)/);
  assert.equal(/Promise\.all\(\s*patches\.map/.test(head), false, "the concurrent dispatch is gone");
});
