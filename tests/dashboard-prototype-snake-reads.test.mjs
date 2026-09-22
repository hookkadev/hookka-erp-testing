// BUG-2026-09-21-181: dashboard-prototype.ts reads every row by its SQL name
// (`r.created_at`) but db-pg.ts hands rows back camelCased (`createdAt`), so
// every field was undefined and the DO loop threw — /api/dashboard/prototype 500.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withSnakeKeys } from '../src/api/lib/db-pg.ts';

test('withSnakeKeys restores SQL names, keeps camelCase, honours the rename map', () => {
  const r = withSnakeKeys({ createdAt: '2026-09-01', driverName: 'JIVA', fabricUsage: 4, id: 'x' });
  assert.equal(r.created_at, '2026-09-01');
  assert.equal(r.driver_name, 'JIVA');
  assert.equal(r.fabric_usage, 4, 'rename-map entry (fabricUsage → fabric_usage)');
  assert.equal(r.createdAt, '2026-09-01', 'camelCase kept so dual-keyed reads still work');
  assert.equal(r.id, 'x');
});

test('every prototype query goes through section(), and no row is read by its snake_case SQL name', () => {
  const src = readFileSync('src/api/routes/dashboard-prototype.ts', 'utf8');
  // A DB.prepare outside section() would skip its error isolation; a section may
  // instead delegate to a lib builder (buildServiceSlice), so counts need not match.
  const chunks = src.split('await section(');
  assert.ok(chunks.length > 1, 'section() helper gone?');
  assert.doesNotMatch(chunks[0], /c\.var\.DB\.prepare/, 'a query before the first section()');
  for (const ch of chunks.slice(1)) {
    assert.ok((ch.match(/c\.var\.DB\.prepare/g) ?? []).length <= 1, 'two queries in one section()');
  }
  // db-pg.ts hands rows back camelCased (`createdAt`); a read by SQL name
  // (`r.created_at`) is undefined and takes the whole feed down with a 500.
  const snakeReads = src.match(/(?:r|row)\.[a-z]+_[a-z_]+/g) ?? [];
  assert.deepEqual(snakeReads, [], 'row fields read by snake_case SQL name');
});
