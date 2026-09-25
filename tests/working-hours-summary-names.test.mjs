// GET /api/working-hour-entries/summary carries each worker's name and home
// department. The Worker Efficiency cards (/m Home, /dashboard) used to look
// names up in /api/workers, which needs workers:read, so a role that can read
// hours but not the worker directory (PRODUCTION) saw raw worker ids.
//
// Behavioural: the real Hono handler against a stub DB that answers by SQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

import whe from '../src/api/routes/working-hour-entries.ts';

function makeDb() {
  const answer = (sql) => {
    if (/GROUP BY workerId, departmentCode/.test(sql)) {
      return [
        { workerId: 'w1', departmentCode: 'FAB_SEW', hours: 40, dayCount: 5 },
        { workerId: 'w1', departmentCode: 'PACKING', hours: '4', dayCount: 1 },
        { workerId: 'w2', departmentCode: 'WEBBING', hours: 30, dayCount: 4 },
      ];
    }
    if (/COUNT\(DISTINCT date\) AS day_count\s+FROM working_hour_entries/.test(sql)) {
      return [{ workerId: 'w1', dayCount: 5 }, { workerId: 'w2', dayCount: 4 }];
    }
    if (/FROM workers w/.test(sql)) {
      // w2 has no workers row (deleted); the Postgres driver may hand the
      // department back snake_cased, so the handler must read both keys.
      return [{ id: 'w1', name: 'YE LI SOE', department_code: 'WOOD_CUT' }];
    }
    return []; // snapshot bookkeeping: no fresh snapshot, nothing to write
  };
  return {
    prepare(sql) {
      const rows = answer(sql);
      const stmt = {
        bind: () => stmt,
        all: async () => ({ results: rows, success: true }),
        first: async () => rows[0] ?? null,
        run: async () => ({ success: true, meta: { changes: 0 } }),
      };
      return stmt;
    },
  };
}

async function call() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('orgId', 'hookka');
    c.set('DB', makeDb());
    c.set('userRole', 'PRODUCTION');
    await next();
  });
  app.route('/api/working-hour-entries', whe);
  const res = await app.request('/api/working-hour-entries/summary?from=2026-09-01&to=2026-09-30', undefined, {});
  return { status: res.status, body: await res.json() };
}

test('summary entries carry the worker name and home department', async () => {
  const { status, body } = await call();
  assert.equal(status, 200);
  const w1 = body.data.find((d) => d.workerId === 'w1');
  assert.equal(w1.name, 'YE LI SOE');
  assert.equal(w1.departmentCode, 'WOOD_CUT');
  assert.equal(w1.totalHours, 44);
  assert.deepEqual(w1.byDept, { FAB_SEW: 40, PACKING: 4 });
});

test('a worker with no workers row gets null name, not a crash', async () => {
  const { body } = await call();
  const w2 = body.data.find((d) => d.workerId === 'w2');
  assert.equal(w2.name, null);
  assert.equal(w2.departmentCode, null);
  assert.equal(w2.totalHours, 30);
});
