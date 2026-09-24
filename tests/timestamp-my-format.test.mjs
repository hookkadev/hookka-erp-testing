// ---------------------------------------------------------------------------
// timestamp-my-format.test.mjs — BUG-2026-09-24-190.
//
// /admin/health rendered every timestamp by slicing the stored string
// (`r.ts.slice(5, 16)`), which prints the UTC clock. A login at 10:40 MYT
// showed as 02:40 — eight hours early, on the one screen whose entire job is
// "when did this happen". The Audit feed, the Security panel, the deploy list
// and the slow-request list were all wrong the same way.
//
// The cases below are the two shapes this database actually stores plus the
// zone-less one, because that is where a naive `new Date()` goes wrong rather
// than where it is convenient to test:
//   - Postgres text with a BARE offset: 2026-09-24 02:05:48.109016+00
//   - ISO from the JS side:             2026-09-24T02:05:48.000Z
//   - no zone at all (CURRENT_TIMESTAMP default), which is UTC
//
// The 17:00 UTC case pins the part a "just add 8" fix would still get wrong:
// the DATE rolls over, so the row belongs to the next day in Malaysia.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

try {
  register('tsx/esm', pathToFileURL('./'));
} catch {
  // Native type-stripping handles it on newer Node.
}
register('./tests/_alias-loader.mjs', pathToFileURL('./'));

const src = (p) => pathToFileURL(resolve(process.cwd(), p)).href;
const { formatTimestampMY, parseDbTimestamp } = await import(src('src/lib/utils.ts'));

test('Postgres text with a bare +00 offset renders in Malaysia time', () => {
  assert.equal(formatTimestampMY('2026-09-24 02:05:48.109016+00'), '24/09 10:05');
});

test('ISO with Z renders identically — same instant, same output', () => {
  assert.equal(formatTimestampMY('2026-09-24T02:05:48.000Z'), '24/09 10:05');
});

test('a zone-less timestamp is read as UTC, matching the column default', () => {
  assert.equal(formatTimestampMY('2026-09-24 02:05:48'), '24/09 10:05');
});

test('the DATE rolls over, not just the clock', () => {
  // 17:00 UTC on the 23rd is 01:00 on the 24th in Malaysia. Slicing the string
  // showed "09-23 17:00"; the row actually belongs to the next day.
  assert.equal(formatTimestampMY('2026-09-23 17:00:00+00'), '24/09 01:00');
});

test('withYear / withSeconds widen the same instant', () => {
  assert.equal(
    formatTimestampMY('2026-09-24 02:05:48.109016+00', { withYear: true, withSeconds: true }),
    '24/09/2026 10:05:48',
  );
});

test('an unparseable value renders raw rather than "Invalid Date"', () => {
  assert.equal(formatTimestampMY('not-a-timestamp'), 'not-a-timestamp');
  assert.equal(parseDbTimestamp('not-a-timestamp'), null);
});

test('null / empty render as a dash, never "NaN"', () => {
  assert.equal(formatTimestampMY(null), '—');
  assert.equal(formatTimestampMY(''), '—');
  assert.equal(formatTimestampMY(undefined), '—');
});

test('the three stored shapes are the SAME instant', () => {
  const a = parseDbTimestamp('2026-09-24 02:05:48+00').getTime();
  const b = parseDbTimestamp('2026-09-24T02:05:48Z').getTime();
  const c = parseDbTimestamp('2026-09-24 02:05:48').getTime();
  assert.equal(a, b);
  assert.equal(b, c);
});
