// ---------------------------------------------------------------------------
// whe-summary-worker-names.test.mjs — BUG-2026-09-25-193.
//
// The mobile Home "Worker Efficiency" card showed raw ids ("worker-45109bfc")
// to a PRODUCTION account while an admin saw names. The card resolved each id
// by fetching /api/workers — `SELECT *` over a table that carries payment and
// payroll-tax columns, so it is gated on workers:read, which PRODUCTION does
// not hold. The 403 left the lookup empty and the code fell back to the id.
//
// The fix moves the lookup to the endpoint that already decides which workers
// the card shows. What is pinned here is BEHAVIOUR against the real handler:
//   1. every summary entry carries workerName + workerDepartmentCode, joined
//      from `workers` by id — including when workers.department_code arrives
//      snake_case rather than camelCase;
//   2. a worker with no workers row gets nulls, not a crash and not "undefined";
//   3. the names are attached AFTER the snapshot layer: the cached payload
//      never contains them (so no cacheKey bump was needed and a rename shows
//      up on the next request), and a cache HIT still returns them;
//   4. a failed name lookup degrades to nulls — the summary itself must not 500
//      on a cosmetic join;
//   5. the card no longer fetches /api/workers at all, so a role without
//      workers:read stops firing a 403 on every load.
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
const { default: wheApp } = await import(src('src/api/routes/working-hour-entries.ts'));

const HOURS = [
  { workerId: 'w-1', departmentCode: 'WOOD_CUT', hours: 8, dayCount: 1 },
  { workerId: 'w-2', departmentCode: 'UPHOLSTERY', hours: '6', dayCount: 1 },
  { workerId: 'w-9', departmentCode: 'FRAMING', hours: 2, dayCount: 1 },
];
const DAYS = [
  { workerId: 'w-1', dayCount: 1 },
  { workerId: 'w-2', dayCount: 1 },
  { workerId: 'w-9', dayCount: 1 },
];
// w-9 has no workers row (deleted / never synced). w-2 arrives snake_case.
const WORKERS = [
  { id: 'w-1', name: 'YE LI SOE', departmentCode: 'WOOD_CUT' },
  { id: 'w-2', name: 'KYAR TUN HLA', department_code: 'UPHOLSTERY' },
];

// A Postgres-shaped stub that answers by what the SQL asks for. `snapshot`
// decides the snapshot layer ('miss' computes fresh, 'hit' serves a cached
// payload) and `nameLookup` decides whether the worker join fails.
function makeDb({ snapshot = 'miss', nameLookup = 'ok' } = {}) {
  const seen = [];
  const writes = [];
  function prepare(sql) {
    seen.push(sql);
    let bound = [];
    const stmt = {
      bind(...a) {
        bound = a;
        return stmt;
      },
      async first() {
        if (/FROM whe_summary_snapshot/i.test(sql)) {
          if (snapshot === 'miss') return null;
          // A payload cached BEFORE this fix: no names in it.
          return {
            data: JSON.stringify({
              data: [
                { workerId: 'w-1', totalHours: 8, byDept: { WOOD_CUT: 8 }, daysWithEntries: 1 },
                { workerId: 'w-9', totalHours: 2, byDept: { FRAMING: 2 }, daysWithEntries: 1 },
              ],
              total: 2,
            }),
            built_from: '2026-09-25T00:00:00.000Z',
            built_at: '2026-09-25T00:00:00.000Z',
            refresh_count: 1,
            source_rows: null,
          };
        }
        return null;
      },
      async all() {
        if (/FROM workers WHERE id IN/i.test(sql)) {
          if (nameLookup === 'fail') throw new Error('workers table unreachable');
          const wanted = new Set(bound.map(String));
          return { results: WORKERS.filter((w) => wanted.has(w.id)), success: true };
        }
        if (/SUM\(hours\)/i.test(sql)) return { results: HOURS, success: true };
        if (/COUNT\(DISTINCT date\)/i.test(sql)) return { results: DAYS, success: true };
        // information_schema probes etc. — an empty answer means "no freshness
        // columns", which the signature reads as null/null (trivially fresh).
        return { results: [], success: true };
      },
      async run() {
        writes.push({ sql, bound });
        return { success: true };
      },
    };
    return stmt;
  }
  return { seen, writes, db: { prepare, batch: async () => [] } };
}

function call(db, path = '/summary?from=2026-09-01&to=2026-09-25') {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('DB', db);
    c.set('orgId', 'hookka');
    c.set('userRole', 'PRODUCTION');
    await next();
  });
  app.route('/', wheApp);
  return app.request(path, undefined, {});
}

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

test('every entry carries the worker name and department, joined by id', async () => {
  const { db } = makeDb();
  const res = await call(db);
  assert.equal(res.status, 200);
  const body = await res.json();
  const byId = Object.fromEntries(body.data.map((e) => [e.workerId, e]));
  assert.equal(byId['w-1'].workerName, 'YE LI SOE');
  assert.equal(byId['w-1'].workerDepartmentCode, 'WOOD_CUT');
  // The unmapped-column read: department_code arrived snake_case.
  assert.equal(byId['w-2'].workerName, 'KYAR TUN HLA');
  assert.equal(byId['w-2'].workerDepartmentCode, 'UPHOLSTERY');
  // The numbers the card actually computes from are untouched.
  assert.equal(byId['w-1'].totalHours, 8);
  assert.equal(byId['w-2'].totalHours, 6);
  assert.equal(body.total, 3);
});

test('the names come from ONE query over exactly the workers in the payload', async () => {
  const { db, seen } = makeDb();
  await call(db);
  const lookups = seen.filter((s) => /FROM workers WHERE id IN/i.test(s));
  assert.equal(lookups.length, 1, 'one round trip, not one per worker');
  assert.match(lookups[0], /SELECT id, name, departmentCode FROM workers/i);
  // Names + department only. This is the whole reason workers:read stays shut:
  // /api/workers is SELECT * and carries payment and payroll-tax columns.
  assert.doesNotMatch(lookups[0], /SELECT \*/i);
});

test('a worker with no workers row gets nulls — never "undefined", never a crash', async () => {
  const { db } = makeDb();
  const body = await (await call(db)).json();
  const orphan = body.data.find((e) => e.workerId === 'w-9');
  assert.equal(orphan.workerName, null);
  assert.equal(orphan.workerDepartmentCode, null);
});

test('names are attached after the snapshot layer, so the cached payload never holds them', async () => {
  const { db, writes } = makeDb();
  await call(db);
  const snapshotWrite = writes.find((w) => /whe_summary_snapshot/i.test(w.sql));
  assert.ok(snapshotWrite, 'the compute path must still write the snapshot');
  const stored = snapshotWrite.bound.find((b) => typeof b === 'string' && b.includes('"workerId"'));
  assert.ok(stored, 'the snapshot payload is bound as JSON');
  assert.doesNotMatch(
    stored,
    /workerName/,
    'a name cached into the snapshot would go stale on a rename until working_hour_entries changed',
  );
});

test('a cache HIT still returns names, even from a payload cached before this fix', async () => {
  const { db, seen } = makeDb({ snapshot: 'hit' });
  const body = await (await call(db)).json();
  assert.equal(
    seen.filter((s) => /SUM\(hours\)/i.test(s)).length,
    0,
    'served from the snapshot — the aggregate query must not have run',
  );
  const byId = Object.fromEntries(body.data.map((e) => [e.workerId, e]));
  assert.equal(byId['w-1'].workerName, 'YE LI SOE');
  assert.equal(byId['w-9'].workerName, null);
});

test(
  'a failed name lookup degrades to nulls and the summary still answers 200',
  quietly(async () => {
    const { db } = makeDb({ nameLookup: 'fail' });
    const res = await call(db);
    assert.equal(res.status, 200, 'a cosmetic join must not take the summary down');
    const body = await res.json();
    assert.equal(body.data.length, 3);
    assert.ok(body.data.every((e) => e.workerName === null));
    assert.equal(body.data.find((e) => e.workerId === 'w-1').totalHours, 8);
  }),
);

// The card side. Source guards, on purpose: the memo lives inside a 2,400-line
// screen component, and what matters is that the dependency on a permissioned
// endpoint is gone.
const HOME = readFileSync(resolve(process.cwd(), 'src/pages/m/screens/Home.tsx'), 'utf8').replace(/\r\n/g, '\n');

test('the Home screen no longer fetches /api/workers', () => {
  assert.doesNotMatch(
    HOME,
    /["'`]\/api\/workers["'`]/,
    '/api/workers is gated on workers:read; a PRODUCTION account 403s on it and the card falls back to ids',
  );
});

test('the Worker Efficiency rows are named from the summary entry, with the id as last resort', () => {
  assert.match(HOME, /name:\s*e\.workerName\s*\|\|\s*e\.workerId/);
  assert.match(HOME, /e\.workerDepartmentCode/);
});
