// Staging-only: never PR this into main.
// "View as" a user: parsing, the client per-tab read, and the server gate
// (staging host + real SUPER_ADMIN + active user, never /api/auth writes).
// Pure, no network: the DB is a stub.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const client = await import("../src/lib/staging-view-as.ts");
const { stagingViewAsUser } = await import("../src/api/lib/staging-view-as.ts");

function fakeWindow(hostname, stored) {
  const store = new Map(stored ? [[client.STAGING_VIEW_AS_KEY, stored]] : []);
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

const USERS = {
  u_sales: { id: "u_sales", role: "SALES", isActive: 1, orgId: "org_a" },
  u_gone: { id: "u_gone", role: "SALES", isActive: 0, orgId: "org_a" },
};
function ctx(host, header, { bound = true, method = "GET", path = "/api/sales-orders", dbThrows = false } = {}) {
  return {
    env: bound ? { HYPERDRIVE_STAGING: { connectionString: "x" } } : {},
    req: {
      url: `https://${host}${path}`,
      method,
      path,
      header: (n) => (n === "X-Staging-View-As" ? header : undefined),
    },
    var: {
      DB: {
        prepare: () => ({
          bind: (id) => ({
            first: async () => {
              if (dbThrows) throw new Error("db down");
              return USERS[id] ?? null;
            },
          }),
        }),
      },
    },
  };
}
const STAGING = "staging.hookka-erp-testing.pages.dev";
const PROD = "hookka-erp-testing.pages.dev";
const ME = { userId: "u_me", role: "SUPER_ADMIN" };

test("parseViewAsId accepts plain ids only", () => {
  assert.equal(client.parseViewAsId("u_sales-1"), "u_sales-1");
  assert.equal(client.parseViewAsId(""), null);
  assert.equal(client.parseViewAsId("a b"), null);
  assert.equal(client.parseViewAsId("x".repeat(65)), null);
  assert.equal(client.parseViewAsId(undefined), null);
});

test("client round-trips the pick on staging only", () => {
  const store = fakeWindow(STAGING);
  client.writeStagingViewAs({ id: "u_sales", role: "sales", name: "Ali" });
  assert.deepEqual(client.readStagingViewAs(), { id: "u_sales", role: "SALES", name: "Ali" });
  client.writeStagingViewAs(null);
  assert.equal(store.has(client.STAGING_VIEW_AS_KEY), false);
  fakeWindow(PROD, JSON.stringify({ id: "u_sales", role: "SALES", name: "Ali" }));
  assert.equal(client.readStagingViewAs(), null);
  fakeWindow(STAGING, "not json");
  assert.equal(client.readStagingViewAs(), null);
});

test("server acts as the picked active user for a real SUPER_ADMIN on staging", async () => {
  assert.deepEqual(await stagingViewAsUser(ctx(STAGING, "u_sales"), ME), {
    userId: "u_sales",
    role: "SALES",
    orgId: "org_a",
  });
  // Reads under /api/auth follow the pick (the menu's /me/permissions).
  assert.equal((await stagingViewAsUser(ctx(STAGING, "u_sales", { path: "/api/auth/me/permissions" }), ME))?.userId, "u_sales");
});

test("server refuses every other case", async () => {
  // ADMIN cannot manage users, so it must not be able to act as anyone.
  assert.equal(await stagingViewAsUser(ctx(STAGING, "u_sales"), { userId: "u_me", role: "ADMIN" }), null);
  assert.equal(await stagingViewAsUser(ctx(STAGING, "u_sales"), { userId: "u_me", role: "SALES" }), null);
  assert.equal(await stagingViewAsUser(ctx(PROD, "u_sales"), ME), null);
  assert.equal(await stagingViewAsUser(ctx("canary-x.hookka-erp-testing.pages.dev", "u_sales"), ME), null);
  assert.equal(await stagingViewAsUser(ctx(STAGING, "u_sales", { bound: false }), ME), null);
  assert.equal(await stagingViewAsUser(ctx(STAGING, "u_gone"), ME), null);
  assert.equal(await stagingViewAsUser(ctx(STAGING, "u_missing"), ME), null);
  assert.equal(await stagingViewAsUser(ctx(STAGING, "u_me"), ME), null);
  assert.equal(await stagingViewAsUser(ctx(STAGING, ""), ME), null);
  assert.equal(await stagingViewAsUser(ctx(STAGING, undefined), ME), null);
  assert.equal(await stagingViewAsUser(ctx(STAGING, "u_sales", { dbThrows: true }), ME), null);
  // Own-account writes (password, 2FA, logout) stay yours.
  assert.equal(await stagingViewAsUser(ctx(STAGING, "u_sales", { method: "POST", path: "/api/auth/change-password" }), ME), null);
});

test("sign-out clears the pick so the next account starts as itself", async () => {
  const store = fakeWindow(STAGING);
  const mem = new Map();
  globalThis.localStorage = {
    get length() { return mem.size; },
    key: (i) => [...mem.keys()][i] ?? null,
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  globalThis.sessionStorage = globalThis.window.sessionStorage;
  try {
    const { clearAuth } = await import("../src/lib/auth.ts");
    client.writeStagingViewAs({ id: "u_sales", role: "SALES", name: "Ali" });
    clearAuth();
    assert.equal(store.has(client.STAGING_VIEW_AS_KEY), false);
  } finally {
    delete globalThis.localStorage;
    delete globalThis.sessionStorage;
  }
});
