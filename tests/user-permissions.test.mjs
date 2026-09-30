// ---------------------------------------------------------------------------
// user-permissions.test.mjs — per-account permissions (owner 2026-09-30).
//
// What must hold, against the REAL gate / menu / routes with a stub DB:
//   * an account never edited keeps exactly its role's access (day one changes
//     nothing), including when the table does not exist yet;
//   * an edited account uses ITS list, for the gate AND the menu alike;
//   * a DB error on the lookup DENIES (fail closed), never falls to the role;
//   * SUPER_ADMIN / ADMIN are untouched and cannot be edited;
//   * only a Super Admin may read or change anyone's access;
//   * only rights the catalog knows are saved — no wildcards, no unknowns;
//   * the catalog carries every (resource, action) a gate in src/api checks.
// Each test uses its own user id: the lookup is memoised for 5 s per isolate.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Hono } from 'hono';

try {
  register('tsx/esm', pathToFileURL('./'));
} catch {
  // Native type-stripping handles it on newer Node.
}
register('./tests/_alias-loader.mjs', pathToFileURL('./'));

const src = (p) => pathToFileURL(resolve(process.cwd(), p)).href;
const { requirePermission, hasPermission } = await import(src('src/api/lib/rbac.ts'));
const { _resetUserPermissionsForTests } = await import(src('src/api/lib/user-permissions.ts'));
const { default: permsApp, catalog } = await import(src('src/api/routes/user-permissions.ts'));
const { default: authApp } = await import(src('src/api/routes/auth.ts'));

const ENV = {};
const quiet = (fn) => async () => {
  const w = console.warn;
  const e = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.warn = w;
    console.error = e;
  }
};

// overrides: Map userId → string[] | Error (thrown) ; missingTable: bool
function makeDb({ overrides = new Map(), missingTable = false, users = new Map() } = {}) {
  const writes = [];
  function prepare(sql) {
    let b = [];
    const stmt = {
      bind(...a) {
        b = a;
        return stmt;
      },
      async first() {
        if (/FROM user_permissions WHERE user_id = \?/i.test(sql)) {
          if (missingTable) throw new Error('relation "user_permissions" does not exist');
          const o = overrides.get(b[0]);
          if (o instanceof Error) throw o;
          return o ? { permissions: JSON.stringify(o) } : null;
        }
        if (/FROM users WHERE id = \?/i.test(sql)) return users.get(b[0]) ?? null;
        if (/FROM users u\s+LEFT JOIN roles/i.test(sql)) {
          const u = users.get(b[0]);
          return u ? { roleId: null, legacyRole: u.role, roleName: null } : null;
        }
        return null;
      },
      async all() {
        return { results: [], success: true };
      },
      async run() {
        if (/^\s*(INSERT INTO user_permissions|DELETE FROM user_permissions|CREATE TABLE)/i.test(sql)) {
          writes.push({ sql: sql.trim().split(/\s+/).slice(0, 3).join(' '), b });
          if (/^\s*INSERT INTO user_permissions/i.test(sql)) overrides.set(b[0], JSON.parse(b[1]));
          if (/^\s*DELETE FROM user_permissions/i.test(sql)) overrides.delete(b[0]);
        }
        return { success: true };
      },
    };
    return stmt;
  }
  return { db: { prepare, batch: async () => [] }, writes, overrides };
}

function gateApp(db, role, userId) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('DB', db);
    c.set('userRole', role);
    if (userId) c.set('userId', userId);
    await next();
  });
  app.get('/gate/:r/:a', async (c) => (await requirePermission(c, c.req.param('r'), c.req.param('a'))) ?? c.json({ ok: true }));
  app.get('/field/:r/:a', async (c) => c.json({ allowed: await hasPermission(c, c.req.param('r'), c.req.param('a')) }));
  return app;
}
const get = (app, p) => app.request(p, undefined, ENV);

// SALES is a code role: it has sales-orders, and no accounting.
test('an account never edited keeps its role: SALES may read sales orders, not accounting', async () => {
  _resetUserPermissionsForTests();
  const { db } = makeDb();
  const app = gateApp(db, 'SALES', 'u-plain');
  assert.equal((await get(app, '/gate/sales-orders/read')).status, 200);
  assert.equal((await get(app, '/gate/accounting/read')).status, 403);
});

test('before the first save the table does not exist — every account still follows its role', async () => {
  _resetUserPermissionsForTests();
  const { db } = makeDb({ missingTable: true });
  const app = gateApp(db, 'SALES', 'u-notable');
  assert.equal((await get(app, '/gate/sales-orders/read')).status, 200);
  assert.equal((await get(app, '/gate/accounting/read')).status, 403);
});

test('an edited account uses ITS list: gains what was ticked, loses what its role had', async () => {
  _resetUserPermissionsForTests();
  const { db } = makeDb({ overrides: new Map([['u-edited', ['accounting:read']]]) });
  const app = gateApp(db, 'SALES', 'u-edited');
  assert.equal((await get(app, '/gate/accounting/read')).status, 200, 'granted on the account');
  const refused = await get(app, '/gate/sales-orders/read');
  assert.equal(refused.status, 403, 'the role no longer applies to this account');
  assert.equal((await refused.json()).missingPermission, 'sales-orders:read');
  assert.equal((await (await get(app, '/field/accounting/read')).json()).allowed, true);
  assert.equal((await (await get(app, '/field/sales-orders/read')).json()).allowed, false);
});

test('a DB error on the account lookup DENIES — it never falls through to the role', quiet(async () => {
  _resetUserPermissionsForTests();
  const { db } = makeDb({ overrides: new Map([['u-err', new Error('connection reset')]]) });
  const app = gateApp(db, 'SALES', 'u-err');
  assert.equal((await get(app, '/gate/sales-orders/read')).status, 403);
  assert.equal((await (await get(app, '/field/sales-orders/read')).json()).allowed, false);
}));

test('SUPER_ADMIN is untouched even if a row somehow exists for it', async () => {
  _resetUserPermissionsForTests();
  const { db } = makeDb({ overrides: new Map([['u-sa', []]]) });
  const app = gateApp(db, 'SUPER_ADMIN', 'u-sa');
  assert.equal((await get(app, '/gate/accounting/delete')).status, 200);
});

test('the MENU (/me/permissions) returns the same list the gate enforces', async () => {
  _resetUserPermissionsForTests();
  const users = new Map([['u-menu', { id: 'u-menu', role: 'SALES' }]]);
  const { db } = makeDb({ overrides: new Map([['u-menu', ['accounting:read']]]), users });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('DB', db);
    c.set('userRole', 'SALES');
    c.set('userId', 'u-menu');
    await next();
  });
  app.route('/', authApp);
  const res = await app.request('/me/permissions', undefined, ENV);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.customized, true);
  assert.ok(body.permissions.includes('accounting:read'));
  assert.ok(!body.permissions.includes('sales-orders:*'), "the role's list must not leak into the menu");
});

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------
function routeApp(db, role = 'SUPER_ADMIN', me = 'u-owner') {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('DB', db);
    c.set('userRole', role);
    c.set('userId', me);
    await next();
  });
  app.route('/', permsApp);
  return (method, path, body) =>
    app.request(
      path,
      body !== undefined ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { method },
      ENV,
    );
}
const USERS = () =>
  new Map([
    ['u-sales', { id: 'u-sales', email: 's@hookka.com', displayName: 'S', role: 'SALES' }],
    ['u-boss', { id: 'u-boss', email: 'b@hookka.com', displayName: 'B', role: 'SUPER_ADMIN' }],
  ]);

for (const role of ['ADMIN', 'HR', 'SALES']) {
  test(`${role} may not read or change anyone's access, and nothing is written`, async () => {
    _resetUserPermissionsForTests();
    const { db, writes } = makeDb({ users: USERS() });
    const call = routeApp(db, role);
    assert.equal((await call('GET', '/catalog')).status, 403);
    assert.equal((await call('GET', '/u-sales')).status, 403);
    assert.equal((await call('PUT', '/u-sales', { permissions: ['accounting:read'] })).status, 403);
    assert.equal((await call('DELETE', '/u-sales')).status, 403);
    assert.equal(writes.length, 0);
  });
}

test('GET shows an unedited account its role access, marked not customised', async () => {
  _resetUserPermissionsForTests();
  const { db } = makeDb({ users: USERS() });
  const body = await (await routeApp(db)('GET', '/u-sales')).json();
  assert.equal(body.data.customized, false);
  assert.ok(body.data.permissions.includes('sales-orders:*'));
});

test('a Super Admin account is shown locked and cannot be saved', async () => {
  _resetUserPermissionsForTests();
  const { db, writes } = makeDb({ users: USERS() });
  const call = routeApp(db);
  assert.equal((await (await call('GET', '/u-boss')).json()).data.locked, true);
  assert.equal((await call('PUT', '/u-boss', { permissions: ['accounting:read'] })).status, 400);
  assert.equal(writes.filter((w) => /INSERT/.test(w.sql)).length, 0);
});

test('unknown rights and wildcards are refused before anything is written', async () => {
  _resetUserPermissionsForTests();
  const { db, writes } = makeDb({ users: USERS() });
  const call = routeApp(db);
  for (const bad of ['sales-orders:*', '*:read', 'nope:read', 'sales-orders:fly', 'a:b:c']) {
    assert.equal((await call('PUT', '/u-sales', { permissions: [bad] })).status, 400, bad);
  }
  assert.equal(writes.length, 0);
});

test('save then reset: the account uses its list, then follows its role again', async () => {
  _resetUserPermissionsForTests();
  const { db, overrides } = makeDb({ users: USERS() });
  const call = routeApp(db);
  const saved = await call('PUT', '/u-sales', { permissions: ['accounting:read', 'sales-orders:read'] });
  assert.equal(saved.status, 200);
  assert.deepEqual(overrides.get('u-sales'), ['accounting:read', 'sales-orders:read']);
  const gate = gateApp(db, 'SALES', 'u-sales');
  assert.equal((await get(gate, '/gate/accounting/read')).status, 200);
  assert.equal((await get(gate, '/gate/sales-orders/delete')).status, 403);

  assert.equal((await call('DELETE', '/u-sales')).status, 200);
  assert.equal(overrides.has('u-sales'), false);
  assert.equal((await get(gate, '/gate/accounting/read')).status, 403, 'reset: back to the role');
  assert.equal((await get(gate, '/gate/sales-orders/delete')).status, 200);
});

// ---------------------------------------------------------------------------
// The catalog covers every right a gate checks.
// ---------------------------------------------------------------------------
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(n)) out.push(p);
  }
  return out;
}

test('every (resource, action) a gate in src/api checks is offered in the tab', () => {
  const offered = new Set(catalog().flatMap((e) => e.actions.map((a) => `${e.resource}:${a}`)));
  const missing = new Set();
  for (const f of walk('src/api')) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/(?:requirePermission|hasPermission)\(\s*c,\s*"([a-z0-9-]+)",\s*"([a-z0-9-]+)"\s*\)/g)) {
      if (!offered.has(`${m[1]}:${m[2]}`)) missing.add(`${m[1]}:${m[2]} (${f})`);
    }
  }
  assert.deepEqual([...missing], [], 'add these to SPECIAL_ACTIONS / ALL_RESOURCES so the tab can grant them');
});
