// ---------------------------------------------------------------------------
// rbac-fail-closed.test.mjs — RBAC audit 2026-09-11, the two fail-open paths.
//
// src/api/lib/rbac.ts granted `*:read` (read the whole ERP) in two situations:
//   1. a role with no grants in role_permissions and no legacy default — so one
//      unrecognised role text was a read-everything account;
//   2. a thrown permission lookup — so one transient DB error was too.
// Every gate added elsewhere could be walked around through either. Both must
// DENY now, and a transient failure must not be cached into a lockout.
//
// Behavioural tests against the real requirePermission / hasPermission with a
// stub DB. Each test uses its own role name: rbac.ts memoises a role's set for
// 5 s per isolate, so sharing a name would let one test answer for another.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';

import { requirePermission, hasPermission } from '../src/api/lib/rbac.ts';

// Worker env with no SESSION_CACHE: getRolePermissions skips KV and goes
// straight to loadRolePermissions. Without an env object c.env is undefined
// and the lookup throws before reaching the code under test.
const TEST_ENV = {};

// Stub for the role_permissions JOIN. `plan` holds one entry per query, in
// order: an array of { resource, action } rows, or an Error to throw. The last
// entry repeats.
function makeDb(plan) {
  const calls = { n: 0 };
  return {
    calls,
    prepare() {
      const step = plan[Math.min(calls.n, plan.length - 1)];
      calls.n += 1;
      const stmt = {
        bind() {
          return stmt;
        },
        async all() {
          if (step instanceof Error) throw step;
          return { results: step, success: true };
        },
      };
      return stmt;
    },
  };
}

function appFor(db, role) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('DB', db);
    c.set('userRole', role);
    await next();
  });
  app.get('/gate/:resource/:action', async (c) => {
    const denied = await requirePermission(c, c.req.param('resource'), c.req.param('action'));
    if (denied) return denied;
    return c.json({ success: true });
  });
  app.get('/field/:resource/:action', async (c) =>
    c.json({ allowed: await hasPermission(c, c.req.param('resource'), c.req.param('action')) }),
  );
  return app;
}

const get = (app, path) => app.request(path, undefined, TEST_ENV);

async function assertDenied(res, missing) {
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.missingPermission, missing);
}

// Keep the expected [rbac] warnings out of the test output.
function quietly(fn) {
  return async () => {
    const original = console.warn;
    console.warn = () => {};
    try {
      await fn();
    } finally {
      console.warn = original;
    }
  };
}

test(
  'fail-open 1: an unrecognised role with no grants is DENIED, not given *:read',
  quietly(async () => {
    const app = appFor(makeDb([[]]), 'TEST_UNRECOGNISED_ROLE');
    await assertDenied(await get(app, '/gate/customers/read'), 'customers:read');
    const field = await (await get(app, '/field/customers/read')).json();
    assert.equal(field.allowed, false);
  }),
);

test(
  'fail-open 2: a thrown permission lookup is DENIED (403), never *:read and never a 500',
  quietly(async () => {
    const outage = new Error('Timed out while creating a new server connection');
    const app = appFor(makeDb([outage]), 'TEST_DB_ROLE_OUTAGE');
    await assertDenied(await get(app, '/gate/customers/read'), 'customers:read');
    const field = await (await get(app, '/field/customers/read')).json();
    assert.equal(field.allowed, false);
  }),
);

test(
  'a transient lookup failure is not cached: the next request is answered from the recovered DB',
  quietly(async () => {
    const outage = new Error('Timed out while creating a new server connection');
    const db = makeDb([outage, [{ resource: 'customers', action: 'read' }]]);
    const app = appFor(db, 'TEST_DB_ROLE_RECOVERS');
    await assertDenied(await get(app, '/gate/customers/read'), 'customers:read');
    const res = await get(app, '/gate/customers/read');
    assert.equal(
      res.status,
      200,
      'the failed lookup must not have been stored — a cached empty set would lock the role out for 5 minutes',
    );
    assert.equal(db.calls.n, 2, 'the second request re-queried instead of reusing the failure');
  }),
);

test(
  'grants in role_permissions are still honoured, and only those',
  quietly(async () => {
    const app = appFor(makeDb([[{ resource: 'customers', action: 'read' }]]), 'TEST_DB_ROLE_GRANTED');
    assert.equal((await get(app, '/gate/customers/read')).status, 200);
    await assertDenied(await get(app, '/gate/customers/update'), 'customers:update');
    await assertDenied(await get(app, '/gate/payroll/read'), 'payroll:read');
  }),
);

test(
  'the explicit READ_ONLY legacy role keeps read-only access — that grant is deliberate',
  quietly(async () => {
    const app = appFor(makeDb([[]]), 'READ_ONLY');
    assert.equal((await get(app, '/gate/customers/read')).status, 200);
    await assertDenied(await get(app, '/gate/customers/update'), 'customers:update');
  }),
);

test('a code-defined role never touches the table and is unaffected', async () => {
  const db = makeDb([new Error('must not be queried')]);
  const app = appFor(db, 'HR');
  assert.equal((await get(app, '/gate/attendance/read')).status, 200);
  await assertDenied(await get(app, '/gate/customers/read'), 'customers:read');
  assert.equal(db.calls.n, 0);
});

test('SUPER_ADMIN and ADMIN still bypass, even when the lookup would fail', async () => {
  for (const role of ['SUPER_ADMIN', 'ADMIN']) {
    const app = appFor(makeDb([new Error('must not be queried')]), role);
    assert.equal((await get(app, '/gate/payroll/read')).status, 200, role);
  }
});

// Source guards: the two literal fail-opens must not come back, in the gate or
// in the menu endpoint that mirrors it.
const read = (p) => readFileSync(resolve(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');

test('rbac.ts no longer grants *:read as a fallback', () => {
  const src = read('src/api/lib/rbac.ts');
  assert.doesNotMatch(src, /set\.add\("\*:read"\)/, 'empty-set fallback to *:read is back');
  assert.doesNotMatch(src, /\?\? \["\*:read"\]/, 'thrown-lookup fallback to *:read is back');
});

test('/me/permissions error fallback grants *:read only to the explicit READ_ONLY role', () => {
  const src = read('src/api/routes/auth.ts');
  assert.match(src, /permissions: legacyRole === "READ_ONLY" \? \["\*:read"\] : \[\]/);
});
