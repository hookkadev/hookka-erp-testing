// ---------------------------------------------------------------------------
// admin-health-audit-ts-cast.test.mjs — BUG-2026-09-24.
//
// /admin/health showed "No audit events in this window." and "Successful
// logins 0 … Healthy" while production held 19,227 audit rows, 122 of them
// inside the window. Nothing was broken about the data: audit_events.ts is a
// TEXT column (0046_audit_events.sql:28) and both health queries compared it
// to a timestamp:
//
//     AND ts > NOW() - INTERVAL '24 hours'
//
// Postgres refuses that outright — 42883, "operator does not exist:
// text > timestamp with time zone" — and BOTH handlers catch their own query
// errors and return an empty payload, which the panel renders as a calm,
// healthy-looking zero. Three layers (audit write, health query, FE fetch)
// each swallow failure, so a hard error surfaced as "Healthy" for weeks.
//
// The stub below behaves like Postgres rather than like a mock: it raises
// 42883 for an UNCAST comparison and returns rows for a cast one. So deleting
// the `::timestamptz` fails this test with the production symptom (empty feed),
// instead of passing against a query that no longer runs.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
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
const { default: adminHealthApp } = await import(src('src/api/routes/admin-health.ts'));

const ROWS = [
  {
    id: 'ae-1', actorUserId: 'u-1', actorUserName: 'Zaim', actorRole: 'SUPER_ADMIN',
    resource: 'auth', resourceId: 'u-1', action: 'login', source: 'ui',
    ipAddress: '10.0.0.1', ts: '2026-09-24 01:57:22.872087+00',
  },
  {
    id: 'ae-2', actorUserId: 'u-2', actorUserName: 'Office', actorRole: 'OFFICE',
    resource: 'sales-orders', resourceId: 'so-9', action: 'create', source: 'ui',
    ipAddress: '10.0.0.2', ts: '2026-09-24 02:05:48.109016+00',
  },
];

// Postgres-shaped stub: `ts` is TEXT, so an uncast comparison against NOW()
// raises 42883 exactly as the live database does.
function makeDb() {
  const seen = [];
  function prepare(sql) {
    seen.push(sql);
    const comparesTs = /\bts\s*(::\s*\w+)?\s*>\s*NOW\(\)/i.test(sql);
    const isCast = /\bts\s*::\s*timestamptz\s*>\s*NOW\(\)/i.test(sql);
    const stmt = {
      bind() { return stmt; },
      async all() {
        if (comparesTs && !isCast) {
          const e = new Error('operator does not exist: text > timestamp with time zone');
          e.code = '42883';
          throw e;
        }
        return { results: ROWS, success: true };
      },
      async first() { return null; },
      async run() { return { success: true }; },
    };
    return stmt;
  }
  return { seen, db: { prepare, batch: async () => [] } };
}

function call(db, path) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('DB', db);
    c.set('orgId', 'hookka');
    c.set('userId', 'u-1');
    c.set('userRole', 'SUPER_ADMIN');
    await next();
  });
  app.route('/', adminHealthApp);
  return app.request(path, undefined, {});
}

test('audit-feed returns the rows instead of an empty "healthy" feed', async () => {
  const { db } = makeDb();
  const res = await call(db, '/audit-feed?range=24h&limit=100');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(
    body.data.length,
    2,
    'empty data here is the production bug: the uncast ts comparison threw 42883 ' +
      'and the handler\'s catch turned it into a healthy-looking empty feed',
  );
  assert.deepEqual(body.data.map((r) => r.action).sort(), ['create', 'login']);
});

test('security-events counts the logins instead of reporting zero', async () => {
  const { db } = makeDb();
  const res = await call(db, '/security-events?range=24h');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(
    body.data.recentEvents.length > 0,
    '"Successful logins 0 … Healthy" was the symptom — an empty list here means the query failed again',
  );
  assert.equal(body.data.summary.totalLogins, 1);
});

test('every audit_events time comparison casts the TEXT ts column', async () => {
  const { db, seen } = makeDb();
  await call(db, '/audit-feed?range=7d&limit=10');
  await call(db, '/security-events?range=7d');
  const audit = seen.filter((s) => /FROM audit_events/i.test(s));
  assert.ok(audit.length >= 2, 'both endpoints must query audit_events');
  for (const sql of audit) {
    assert.doesNotMatch(
      sql,
      /\bts\s*>\s*NOW\(\)/i,
      'audit_events.ts is TEXT (0046_audit_events.sql:28) — compare it as ts::timestamptz, ' +
        'or Postgres raises 42883 and the catch block hides it',
    );
  }
});
