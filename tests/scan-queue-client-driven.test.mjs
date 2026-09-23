// ---------------------------------------------------------------------------
// scan-queue-client-driven.test.mjs — BUG-2026-09-22-178.
//
// "Scanning the second PO takes more than 5 minutes." The OCR worker ran
// under ctx.waitUntil() after the upload response; Cloudflare cancels
// waitUntil tasks 30 s after the response, so every page slower than that was
// killed mid-Sonnet-call, sat 'processing' until the 5-minute sweeper
// re-queued it, and was killed again on the re-kick. Three cancelled attempts
// later the row was 'failed'.
//
// The fix: the BROWSER drives the rows. POST /batch/:id/work processes one
// row per held-open request (no duration limit), and the modal keeps a small
// pool of those open. This file pins:
//   1. scan-queue.ts has NO waitUntil kick at all — a cancelled claim blocks
//      its row for STUCK_MS, so a "harmless" re-add is the bug coming back.
//   2. the /work route exists and every scan modal wires the driver + stops it.
//   3. the driver's loop: processes until drained, backs off on busy, exits on
//      error, and stop() aborts.
// ---------------------------------------------------------------------------
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createScanQueueDriver } from "../src/lib/scan-queue-client.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("scan-queue.ts never kicks the OCR worker under waitUntil", () => {
  // Comments are allowed to SAY waitUntil (they explain why it is banned).
  const src = read("src/api/routes/scan-queue.ts").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/waitUntil\s*\(/.test(src), "waitUntil( kick found in scan-queue.ts");
  assert.ok(!/function processBatch\b/.test(src), "processBatch is back");
  assert.match(src, /app\.post\("\/batch\/:batchId\/work"/);
});

test("every scan modal drives its batch and stops the driver on cleanup", () => {
  for (const f of ["src/components/scan-po-modal.tsx", "src/components/scan-supplier-modal.tsx"]) {
    const src = read(f);
    assert.match(src, /createScanQueueDriver\(activeBatchId/, `${f}: driver not created`);
    assert.match(src, /driver\.poke\(\)/, `${f}: driver never poked`);
    assert.match(src, /driver\.stop\(\)/, `${f}: driver never stopped`);
  }
});

function stubFetch(script) {
  // script: array of { status?, body? } | Error, consumed per call.
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    if (init?.signal?.aborted) throw new Error("aborted");
    const next = script.shift() ?? { body: { success: true, data: { processed: null, drained: true, busy: false } } };
    if (next instanceof Error) throw next;
    return {
      ok: (next.status ?? 200) < 400,
      json: async () => next.body,
    };
  };
  return calls;
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const row = (id) => ({ body: { success: true, data: { processed: id, drained: false, busy: false } } });
const drained = { body: { success: true, data: { processed: null, drained: true, busy: false } } };
const busy = { body: { success: true, data: { processed: null, drained: false, busy: true } } };

test("driver processes rows until drained, one worker per slot, then idles", async () => {
  const calls = stubFetch([row("a"), row("b"), row("c"), drained, drained, drained]);
  const done = [];
  const d = createScanQueueDriver("B1", { concurrency: 3, onProcessed: (id) => done.push(id) });
  d.poke();
  assert.equal(d.active(), 3);
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(done.sort(), ["a", "b", "c"]);
  assert.equal(d.active(), 0, "workers exit once the batch is drained");
  assert.ok(calls.every((c) => c.url === "/api/scan-queue/batch/B1/work" && c.method === "POST"));
  // A later poke (poll saw a re-queued row) wakes the pool again.
  stubFetch([row("d"), drained, drained, drained]);
  d.poke();
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(done.at(-1), "d");
  assert.equal(d.active(), 0);
});

test("driver backs off on busy, exits on error, and stop() halts the pool", async () => {
  stubFetch([busy, row("x"), drained]);
  const done = [];
  const d = createScanQueueDriver("B2", { concurrency: 1, backoffMs: 1, onProcessed: (id) => done.push(id) });
  d.poke();
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(done, ["x"]);
  assert.equal(d.active(), 0);

  stubFetch([{ status: 500, body: {} }]);
  d.poke();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(d.active(), 0, "an HTTP error exits the worker instead of looping");

  const forever = new Promise(() => {});
  globalThis.fetch = async (_u, init) =>
    new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
  d.poke();
  assert.equal(d.active(), 1);
  d.stop();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(d.active(), 0, "stop() aborts the in-flight request");
  d.poke();
  assert.equal(d.active(), 0, "a stopped driver never restarts");
  void forever;
});
