// ---------------------------------------------------------------------------
// org-departments-list.test.mjs
//
// Owner asked to add "IT" as a company department on the Org Chart and found
// no way to. There were two separate problems:
//
//   1. "IT" itself was missing from the list.
//   2. The list had no add feature at all — ORG_DEPARTMENTS was a hardcoded
//      array in src/pages/settings/Users.tsx, so a NEW department (not just
//      IT) needed a code change every time.
//
// This is UNRELATED to the manufacturing departments (Fabric Cutting, Wood
// Cutting, …), which have their own CRUD table and a Manage Departments panel
// on Employees → Department Labor. Every factory worker sits under
// "Production" on the org chart regardless of which manufacturing department
// they clock into — that split is a costing dimension, not a reporting line
// (org-chart.ts:14-16). Adding office departments to THAT table would let
// someone log production hours against "IT" and wrong the labor-cost math.
//
// Fix: the office-department list now lives in kv_config under
// "org-departments" — reusing the existing generic GET/PUT
// /api/kv-config/:key endpoint rather than a new table or route. GET is
// open to any signed-in role (a list of department NAMES isn't sensitive);
// PUT already requires users:update (src/api/routes/kv-config.ts), the same
// gate the rest of user-account management uses. DEFAULT_ORG_DEPARTMENTS is
// the seed/fallback for a fresh environment or the one request before
// someone has ever saved.
//
// Two kinds of test:
//   - source guards for the frontend: the seed still contains IT, and both
//     the Org Chart picker and the mailbox-alias picker read ONE list (not
//     two that can drift, which was itself a bug fixed in 2026-08);
//   - a behavioural test against the REAL kv-config router for the actual
//     security property this feature depends on: reading the department
//     list works for anyone, writing to it does not.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Hono } from 'hono';

try {
  register('tsx/esm', pathToFileURL('./'));
} catch {
  // Native type-stripping handles it on newer Node.
}
register('./tests/_alias-loader.mjs', pathToFileURL('./'));

const src = (p) => pathToFileURL(resolve(process.cwd(), p)).href;
const { default: kvConfigApp } = await import(src('src/api/routes/kv-config.ts'));

const SRC = readFileSync(resolve(process.cwd(), 'src/pages/settings/Users.tsx'), 'utf8').replace(
  /\r\n/g,
  '\n',
);

function defaultOrgDepartments() {
  const m = SRC.match(/const DEFAULT_ORG_DEPARTMENTS = \[([\s\S]*?)\] as const;/);
  assert.ok(m, 'DEFAULT_ORG_DEPARTMENTS not found — test anchor needs updating');
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

// ---------------------------------------------------------------------------
// Frontend source guards
// ---------------------------------------------------------------------------

test('IT is in the seed list, alongside the other office departments', () => {
  assert.deepEqual(defaultOrgDepartments(), [
    'Management',
    'Production',
    'R&D',
    'QA',
    'Sales',
    'Office',
    'Finance',
    'HR',
    'IT',
    'Others',
  ]);
});

test('the org chart and the mailbox-alias dropdown read the SAME list', () => {
  // Two `departments={orgDepartments}` call sites (UserDetailDrawer,
  // AddUserDrawer) and one in the alias-dialog <select>.map — never a second,
  // independent list. Two lists that used to disagree (2026-08) meant a
  // person filed under one dialog's department could not be placed on the
  // chart at all.
  const passedToDrawers = (SRC.match(/departments=\{orgDepartments\}/g) ?? []).length;
  assert.equal(passedToDrawers, 2, 'both UserDetailDrawer and AddUserDrawer must read orgDepartments');
  assert.match(SRC, /\{orgDepartments\.map\(\(d\) => \(/);
});

test('the add-department feature saves to kv_config, not a new table or route', () => {
  assert.match(SRC, /ORG_DEPARTMENTS_KV_KEY = "org-departments"/);
  assert.match(SRC, /`\/api\/kv-config\/\$\{ORG_DEPARTMENTS_KV_KEY\}`/);
});

test('Add Department lives in the top-right button, not a separate always-open row', () => {
  // 2026-09-28: that slot used to be an Edit/Save/Cancel bar for a table
  // removed back in 2026-08 — dead ever since, nothing left to populate its
  // draft state. Repurposed rather than just deleted, since "add a
  // department" belongs in exactly that spot. Guards against either the dead
  // bar coming back, or the add control reverting to its own separate row.
  assert.doesNotMatch(SRC, /\borgEdit\b/, 'the dead Edit/Save/Cancel state must not come back');
  assert.match(SRC, /setAddDeptOpen\(\(v\) => !v\)/);
  assert.match(SRC, /\{addDeptOpen \? "Cancel" : "Add Department"\}/);
});

// ---------------------------------------------------------------------------
// Behavioural: the real kv-config router, stub DB
// ---------------------------------------------------------------------------

function makeDb(seed = null) {
  const rows = new Map(seed ? [['org-departments', { value: JSON.stringify(seed), updatedAt: '2026-09-28T00:00:00Z' }]] : []);
  const writes = [];
  return {
    writes,
    db: {
      prepare(sql) {
        let bound = [];
        const stmt = {
          bind(...a) {
            bound = a;
            return stmt;
          },
          async first() {
            if (/SELECT .*FROM kv_config WHERE key = \?/i.test(sql)) {
              const row = rows.get(bound[0]);
              return row ? { key: bound[0], value: row.value, updatedAt: row.updatedAt } : null;
            }
            return null;
          },
          async run() {
            if (/INSERT INTO kv_config/i.test(sql)) {
              const [key, value] = bound;
              rows.set(key, { value, updatedAt: '2026-09-28T00:00:00Z' });
              writes.push({ key, value });
            }
            return { success: true };
          },
        };
        return stmt;
      },
      async batch() {
        return [];
      },
    },
  };
}

function call(db, method, path, role, body) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('DB', db);
    c.set('orgId', 'hookka');
    c.set('userRole', role);
    await next();
  });
  app.route('/', kvConfigApp);
  return app.request(
    path,
    body !== undefined
      ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : { method },
    {},
  );
}

test('reading the department list needs no permission at all', async () => {
  const { db } = makeDb(['Management', 'Production', 'IT', 'Others']);
  const res = await call(db, 'GET', '/org-departments', 'QA');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.data, ['Management', 'Production', 'IT', 'Others']);
});

test('a role without users:update is refused when it tries to add a department', async () => {
  const { db, writes } = makeDb(['Management', 'Production', 'Others']);
  const res = await call(db, 'PUT', '/org-departments', 'HR', ['Management', 'Production', 'IT', 'Others']);
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.missingPermission, 'users:update');
  assert.equal(writes.length, 0, 'a refused write must not reach the database');
});

test('SUPER_ADMIN can add a department, and the write lands as sent', async () => {
  const { db, writes } = makeDb(['Management', 'Production', 'Others']);
  const withIt = ['Management', 'Production', 'IT', 'Others'];
  const res = await call(db, 'PUT', '/org-departments', 'SUPER_ADMIN', withIt);
  assert.equal(res.status, 200);
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].value), withIt);

  const reread = await (await call(db, 'GET', '/org-departments', 'QA')).json();
  assert.deepEqual(reread.data, withIt);
});
