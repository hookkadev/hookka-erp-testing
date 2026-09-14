// ---------------------------------------------------------------------------
// leaves-read-permission.test.mjs — RBAC audit 2026-09-11.
//
// GET /api/leaves and GET /api/leaves/balances were readable by every
// logged-in account of every role: the handlers called getOrgId() (which
// company) but never requirePermission() (is this person allowed).
//
// The refusal is asserted three ways — status 403, the missingPermission body,
// and ZERO database calls. "No rows came back" is not a test: it passes against
// a working gate, a broken gate and a dead connection alike.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

import leaves from '../src/api/routes/leaves.ts';

const LEAVE_ROW = {
  id: 'lv-0001',
  workerId: 'wkr-01',
  workerName: 'Worker wkr-01',
  type: 'ANNUAL',
  startDate: '2026-08-10',
  endDate: '2026-08-11',
  days: 2,
  status: 'APPROVED',
  reason: '',
  approvedBy: null,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
};

function makeDb() {
  const seen = [];
  return {
    seen,
    prepare(sql) {
      seen.push(sql);
      const stmt = {
        bind() {
          return stmt;
        },
        async all() {
          return { results: /FROM leaves/.test(sql) ? [LEAVE_ROW] : [], success: true };
        },
        async first() {
          return null;
        },
        async run() {
          return { success: true };
        },
      };
      return stmt;
    },
  };
}

// Worker env. Without it c.env is undefined and rbac.ts's catch fallback grants
// `*:read` to any role, which would let the refusal tests below pass or fail
// for reasons unrelated to the gate. See attendance-list-no-photo-blobs.test.mjs.
const TEST_ENV = {};

async function call(db, path, role) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('orgId', 'hookka');
    c.set('DB', db);
    c.set('userRole', role);
    await next();
  });
  app.route('/api/leaves', leaves);
  return app.request(`/api/leaves${path}`, undefined, TEST_ENV);
}

for (const path of ['', '/balances?year=2026']) {
  test(`RBAC: GET /api/leaves${path} refuses QA with 403 before touching the database`, async () => {
    const db = makeDb();
    const res = await call(db, path, 'QA');
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.missingPermission, 'leaves:read');
    assert.equal(body.role, 'QA');
    assert.equal(db.seen.length, 0, 'a refused request must not reach the database');
  });
}

test('RBAC: HR reads GET /api/leaves through the real role policy, not the rbac.ts fallback', async () => {
  const original = console.warn;
  const rbacWarnings = [];
  console.warn = (...args) => {
    if (String(args[0]).includes('[rbac]')) rbacWarnings.push(String(args[0]));
    else original(...args);
  };
  let res;
  try {
    res = await call(makeDb(), '', 'HR');
  } finally {
    console.warn = original;
  }
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.data.map((r) => r.id), ['lv-0001']);
  assert.deepEqual(
    rbacWarnings,
    [],
    'HR must be allowed by role-policy.ts. An [rbac] fallback warning means the ' +
      'permission lookup threw and the request was let through by the fail-open catch.',
  );
});
