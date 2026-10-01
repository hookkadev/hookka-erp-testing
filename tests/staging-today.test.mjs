// Staging-only: never PR this into main.
// Today override: parsing, the client per-tab read, the server gate, and the
// one server helper that honours it (overdueTodayUtc). Pure, no network.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const client = await import("../src/lib/staging-today.ts");
const { stagingTodayFromRequest } = await import("../src/api/lib/staging-today.ts");
const { overdueTodayUtc } = await import("../src/api/routes/production-orders.ts");
const { todayYmdMY } = await import("../src/lib/utils.ts");

const realToday = () => new Date().toISOString().slice(0, 10);

function fakeWindow(hostname, stored) {
  const store = new Map(stored ? [[client.STAGING_TODAY_KEY, stored]] : []);
  globalThis.window = {
    location: { hostname },
    sessionStorage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  };
  return store;
}
afterEach(() => {
  delete globalThis.window;
});

function ctx(host, header, { bound = true } = {}) {
  return {
    env: bound ? { HYPERDRIVE_STAGING: { connectionString: "x" } } : {},
    req: {
      url: `https://${host}/api/production-orders/overdue-counts`,
      header: (n) => (n === "X-Staging-Today" ? header : undefined),
    },
  };
}
const STAGING = "staging.hookka-erp-testing.pages.dev";
const PROD = "hookka-erp-testing.pages.dev";

test("parse accepts real dates only", () => {
  assert.equal(client.parseStagingToday("2026-10-31"), "2026-10-31");
  assert.equal(client.parseStagingToday("2028-02-29"), "2028-02-29");
  for (const bad of ["2026-02-30", "2026-13-01", "2026-1-01", "31-10-2026", "", "2026-10-31x", null, undefined, 20261031]) {
    assert.equal(client.parseStagingToday(bad), null, String(bad));
  }
});

test("client: off by default, staging host only, invalid ignored", () => {
  assert.equal(client.readStagingToday(), null, "no window (server) is off");
  fakeWindow(STAGING);
  assert.equal(client.readStagingToday(), null, "nothing stored is off");
  assert.equal(client.todayYmdMYForReads(), todayYmdMY());
  fakeWindow(PROD, "2026-10-31");
  assert.equal(client.readStagingToday(), null, "prod host ignores a stored value");
  assert.equal(client.todayYmdMYForReads(), todayYmdMY());
  fakeWindow("localhost", "2026-10-31");
  assert.equal(client.readStagingToday(), null, "local dev ignores it too");
  fakeWindow(STAGING, "2026-02-30");
  assert.equal(client.readStagingToday(), null, "invalid stored value ignored");
  fakeWindow(STAGING, "2026-10-31");
  assert.equal(client.readStagingToday(), "2026-10-31");
  assert.equal(client.todayYmdMYForReads(), "2026-10-31");
  assert.equal(todayYmdMY(), new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), "write helper never sees it");
});

test("client: write sets valid, clears on null or invalid", () => {
  const store = fakeWindow(STAGING);
  client.writeStagingToday("2026-12-31");
  assert.equal(store.get(client.STAGING_TODAY_KEY), "2026-12-31");
  client.writeStagingToday("nope");
  assert.equal(store.has(client.STAGING_TODAY_KEY), false);
  client.writeStagingToday("2026-12-31");
  client.writeStagingToday(null);
  assert.equal(store.has(client.STAGING_TODAY_KEY), false);
});

test("server: header honoured only on a gated staging request", () => {
  assert.equal(stagingTodayFromRequest(ctx(STAGING, "2026-10-31")), "2026-10-31");
  assert.equal(stagingTodayFromRequest(ctx(PROD, "2026-10-31")), null, "prod host");
  assert.equal(stagingTodayFromRequest(ctx("canary-abc.hookka-erp-testing.pages.dev", "2026-10-31")), null, "canary");
  assert.equal(stagingTodayFromRequest(ctx("erp.example.com", "2026-10-31")), null, "custom domain");
  assert.equal(stagingTodayFromRequest(ctx(STAGING, "2026-10-31", { bound: false })), null, "staging DB not bound");
  assert.equal(stagingTodayFromRequest(ctx(STAGING, "2026-02-30")), null, "invalid date");
  assert.equal(stagingTodayFromRequest(ctx(STAGING, undefined)), null, "no header");
});

test("server: overdueTodayUtc is unchanged off staging", () => {
  assert.equal(overdueTodayUtc(), realToday(), "no context (old call shape)");
  assert.equal(overdueTodayUtc(ctx(PROD, "2026-10-31")), realToday(), "prod host ignores header");
  assert.equal(overdueTodayUtc(ctx(STAGING, "bad")), realToday(), "invalid header ignored");
  assert.equal(overdueTodayUtc({ env: {}, req: {} }), realToday(), "cron-like context without a URL");
  assert.equal(overdueTodayUtc(ctx(STAGING, "2026-10-31")), "2026-10-31");
});
