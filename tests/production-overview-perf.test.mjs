// ---------------------------------------------------------------------------
// production-overview-perf.test.mjs — /production Overview lag (2026-09-23).
//
// Measured on prod: (1) the 8 s poll re-downloaded a byte-identical 11.8 MB
// body and blocked the main thread ~350 ms rebuilding rows from a "new" object;
// (2) the row virtualizer lived in the ~9.7k-line ProductionPage, so every
// scroll frame re-rendered the whole page (30–60 ms/step with ~20 rows mounted).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// cached-fetch.ts reads the Vite-injected __BUILD_ID__ at load — set it first
// (same pattern as cached-fetch-503-retry.test.mjs).
globalThis.__BUILD_ID__ = "test-build";
const { readJsonBody } = await import("../src/lib/cached-fetch.ts");

const PAGE = readFileSync(resolve(process.cwd(), "src/pages/production/index.tsx"), "utf8");

test("reuseUnchanged: an identical body returns the SAME object", async () => {
  const url = "/test/identical";
  const a = await readJsonBody(new Response('{"data":[1,2]}'), url, true);
  const b = await readJsonBody(new Response('{"data":[1,2]}'), url, true);
  assert.equal(a, b, "unchanged poll must not hand React a new object");
});

test("reuseUnchanged: a changed body returns a new object", async () => {
  const url = "/test/changed";
  const a = await readJsonBody(new Response('{"data":[1]}'), url, true);
  const b = await readJsonBody(new Response('{"data":[2]}'), url, true);
  assert.notEqual(a, b);
  assert.deepEqual(b, { data: [2] });
});

test("without the opt-in every fetch is a fresh object (default unchanged)", async () => {
  const url = "/test/default";
  const a = await readJsonBody(new Response('{"x":1}'), url, false);
  const b = await readJsonBody(new Response('{"x":1}'), url, false);
  assert.notEqual(a, b);
});

test("/production opts its orders fetch in", () => {
  assert.match(PAGE, /\{ reuseUnchanged: true \}/);
});

test("the Overview virtualizer is hosted by OverviewVirtualRows, not ProductionPage", () => {
  const uses = PAGE.match(/useVirtualizer\(/g) ?? [];
  assert.equal(uses.length, 1, "exactly one useVirtualizer call in the page file");
  const host = PAGE.indexOf("function OverviewVirtualRows(");
  assert.ok(host > 0 && PAGE.indexOf("useVirtualizer(") > host,
    "it must live inside OverviewVirtualRows — hosting it in ProductionPage re-renders the whole page per scroll frame");
});
