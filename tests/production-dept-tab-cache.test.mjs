// ---------------------------------------------------------------------------
// production-dept-tab-cache.test.mjs — switching between /production dept tabs
// downloaded the whole sheet again every time (owner 2026-10-07).
//
// Measured on staging: each dept sheet is 6-7 MB decoded (~1,300 orders), over
// the ~5 MB localStorage quota, so cached-fetch's write always failed and there
// was never a saved copy to paint from. And the 8 s poll called
// invalidateCachePrefix("/api/production-orders"), which wiped every dept's
// copy anyway. Fix: oversized bodies are kept in memory, and the poll refetches
// without the blanket invalidate.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// A localStorage that refuses anything over 1 KB, like the real quota does for
// a 6 MB sheet. Set up (with __BUILD_ID__) BEFORE cached-fetch.ts loads.
const store = new Map();
globalThis.window = {
  localStorage: {
    get length() { return store.size; },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      if (v.length > 1024) throw new Error("QuotaExceededError");
      store.set(k, v);
    },
    removeItem: (k) => { store.delete(k); },
  },
};
globalThis.BroadcastChannel = undefined; // keep node from holding the loop open
globalThis.__BUILD_ID__ = "test-build";
const { cachedFetchJson, peekCache, invalidateCachePrefix } = await import("../src/lib/cached-fetch.ts");

function serve(body) {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => body });
}

const big = { success: true, data: [{ id: "po-1", note: "x".repeat(4096) }] };

test("a body too big for localStorage is still served from cache", async () => {
  const url = "/api/production-orders?fields=minimal&dept=FAB_CUT";
  serve(big);
  await cachedFetchJson(url);
  assert.deepEqual(peekCache(url), big, "revisiting the tab must paint from the saved copy");
});

test("small bodies keep using localStorage", async () => {
  const url = "/api/departments";
  serve({ data: [1] });
  await cachedFetchJson(url);
  assert.ok([...store.keys()].some((k) => k.endsWith(url)));
});

test("invalidateCachePrefix drops the in-memory copy too", async () => {
  const url = "/api/production-orders?fields=minimal&dept=FAB_SEW";
  serve(big);
  await cachedFetchJson(url);
  invalidateCachePrefix("/api/production-orders");
  assert.equal(peekCache(url), null, "an edit must not leave a stale sheet behind");
});

const PAGE = readFileSync(resolve(process.cwd(), "src/pages/production/index.tsx"), "utf8");

test("the 8 s poll's refetch does not wipe the saved copies; edits still do", () => {
  // The poll and the come-back-to-the-window refresh both call fetchOrders.
  const fn = PAGE.slice(PAGE.indexOf("const fetchOrders = useCallback("), PAGE.indexOf("}, [refreshOrders, refreshOverdueCounts]);"));
  assert.ok(fn.length > 0 && fn.length < 400, "fetchOrders not found");
  assert.doesNotMatch(fn, /invalidateCache/, "a refetch must not drop every dept's saved copy");
  // The write paths that refetch through fetchOrders invalidate first. The
  // stock-PO create is on every branch; the sequence-unlock dialog ("the only
  // honest picture.") exists only where the sequence lock has shipped.
  assert.ok(PAGE.includes("onCreated={() => {"), "stock-PO create path missing");
  for (const anchor of ["onCreated={() => {", "the only honest picture."]) {
    const at = PAGE.indexOf(anchor);
    if (at < 0) continue;
    assert.match(PAGE.slice(at, at + 200), /invalidateCachePrefix\("\/api\/production-orders"\);\s*fetchOrders\(\);/);
  }
});
