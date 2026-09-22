// Staging must not share cache keys with prod (same SESSION_CACHE namespace).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prefixedKv } from '../src/api/lib/kv-prefix.ts';

function fakeKv() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.get(k) ?? null; },
    async getWithMetadata(k) { return { value: m.get(k) ?? null, metadata: null }; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list(o) { return { keys: [...m.keys()].filter((k) => k.startsWith(o?.prefix ?? '')).map((name) => ({ name })) }; },
  };
}

test('staging writes land under stg: and never touch the prod key', async () => {
  const raw = fakeKv();
  await raw.put('dashboard:overview:hookka', 'PROD');
  const stg = prefixedKv(raw, 'stg:');
  assert.equal(await stg.get('dashboard:overview:hookka'), null, 'staging must not read prod cache');
  await stg.put('dashboard:overview:hookka', 'STAGING', { expirationTtl: 60 });
  assert.equal(raw.m.get('dashboard:overview:hookka'), 'PROD', 'prod value untouched');
  assert.equal(raw.m.get('stg:dashboard:overview:hookka'), 'STAGING');
  assert.equal((await stg.getWithMetadata('dashboard:overview:hookka')).value, 'STAGING');
  assert.deepEqual((await stg.list({ prefix: 'dash' })).keys.map((k) => k.name), ['stg:dashboard:overview:hookka']);
  await stg.delete('dashboard:overview:hookka');
  assert.equal(raw.m.has('stg:dashboard:overview:hookka'), false);
  assert.equal(raw.m.get('dashboard:overview:hookka'), 'PROD');
});

test('worker wraps SESSION_CACHE for preview hosts before auth runs', () => {
  const src = readFileSync('src/api/worker.ts', 'utf8');
  const wrap = src.indexOf('prefixedKv(c.env.SESSION_CACHE, "stg:")');
  assert.ok(wrap > 0);
  assert.ok(wrap < src.indexOf('app.use("/api/*", authMiddleware)'));
  assert.match(src, /if \(c\.env\.SESSION_CACHE && isPreviewHostname\(c\.req\.url\)\)/);
});
