// Staging-only: never PR this into main.
// "View as role": parsing, the client per-tab read, and the server gate
// (staging host + real SUPER_ADMIN + known role). Pure, no network.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const client = await import("../src/lib/staging-role.ts");
const { stagingRoleFromRequest } = await import("../src/api/lib/staging-role.ts");

function fakeWindow(hostname, stored) {
  const store = new Map(stored ? [[client.STAGING_ROLE_KEY, stored]] : []);
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
      url: `https://${host}/api/sales-orders`,
      header: (n) => (n === "X-Staging-Role" ? header : undefined),
    },
  };
}
const STAGING = "staging.hookka-erp-testing.pages.dev";
const PROD = "hookka-erp-testing.pages.dev";

test("parseStagingRole accepts picker roles only", () => {
  assert.equal(client.parseStagingRole("sales"), "SALES");
  assert.equal(client.parseStagingRole(" R_AND_D "), "R_AND_D");
  assert.equal(client.parseStagingRole("ROOT"), null);
  assert.equal(client.parseStagingRole(""), null);
  assert.equal(client.parseStagingRole(undefined), null);
});

test("client reads the pick on staging only", () => {
  fakeWindow(STAGING, "FINANCE");
  assert.equal(client.readStagingRole(), "FINANCE");
  fakeWindow(PROD, "FINANCE");
  assert.equal(client.readStagingRole(), null);
});

test("writeStagingRole stores a valid role and clears otherwise", () => {
  const store = fakeWindow(STAGING);
  client.writeStagingRole("hr");
  assert.equal(store.get(client.STAGING_ROLE_KEY), "HR");
  client.writeStagingRole("nonsense");
  assert.equal(store.has(client.STAGING_ROLE_KEY), false);
});

test("server honours the header for a real SUPER_ADMIN on staging", () => {
  assert.equal(stagingRoleFromRequest(ctx(STAGING, "WORKER"), "SUPER_ADMIN"), "WORKER");
  assert.equal(stagingRoleFromRequest(ctx(STAGING, "WORKER"), "super_admin"), "WORKER");
});

test("server refuses every other case", () => {
  // ADMIN cannot manage users, so it must not be able to pick SUPER_ADMIN.
  assert.equal(stagingRoleFromRequest(ctx(STAGING, "SUPER_ADMIN"), "ADMIN"), null);
  assert.equal(stagingRoleFromRequest(ctx(STAGING, "SUPER_ADMIN"), "SALES"), null);
  assert.equal(stagingRoleFromRequest(ctx(STAGING, "SALES"), null), null);
  assert.equal(stagingRoleFromRequest(ctx(PROD, "SALES"), "SUPER_ADMIN"), null);
  assert.equal(stagingRoleFromRequest(ctx("canary-x.hookka-erp-testing.pages.dev", "SALES"), "SUPER_ADMIN"), null);
  assert.equal(stagingRoleFromRequest(ctx(STAGING, "SALES", { bound: false }), "SUPER_ADMIN"), null);
  assert.equal(stagingRoleFromRequest(ctx(STAGING, "ROOT"), "SUPER_ADMIN"), null);
  assert.equal(stagingRoleFromRequest(ctx(STAGING, undefined), "SUPER_ADMIN"), null);
});
