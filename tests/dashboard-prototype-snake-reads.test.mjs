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

test('every prototype query goes through section(), and section() snake-keys its rows', () => {
  const src = readFileSync('src/api/routes/dashboard-prototype.ts', 'utf8');
  const prepares = (src.match(/c\.var\.DB\.prepare/g) ?? []).length;
  const sections = (src.match(/await section\(/g) ?? []).length;
  assert.equal(prepares, sections, 'a query outside section() would read undefined fields again');
  assert.match(src, /\.map\(\(r\) => withSnakeKeys\(r as object\) as T\)/);
});
