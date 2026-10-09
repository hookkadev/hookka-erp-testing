// ---------------------------------------------------------------------------
// worker-pages-translated.test.mjs (BUG-2026-10-09-272) — the worker portal is used in four
// languages (en / ms / zh / my), but ~45 visible strings were hardcoded in
// English, including the two pop-ups that STOP a scan ("Wrong department",
// "Not this step yet"). A worker who does not read English got the most
// important instruction on the page in a language they cannot read.
//
// Three guards, so the gap cannot quietly reopen:
//   1. every t("key") a worker page uses exists in worker-i18n.ts;
//   2. every entry there has all four languages, non-empty;
//   3. the specific English literals that were hardcoded are gone.
// Plus the date default on the non-production request form, which used the
// UTC date and so pre-filled YESTERDAY before 08:00 Malaysia time.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p) => readFileSync(resolve(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');
const dict = read('src/lib/worker-i18n.ts');
const pages = readdirSync(resolve(process.cwd(), 'src/pages/worker'))
  .filter((n) => /\.tsx$/.test(n))
  .map((n) => `src/pages/worker/${n}`)
  .concat(['src/layouts/WorkerLayout.tsx']);

// key → { en, ms, zh, my }
const entries = new Map();
for (const m of dict.matchAll(/^\s*'([a-zA-Z0-9_.]+)':\s*\{([\s\S]*?)\},?\s*$/gm)) {
  const vals = {};
  for (const v of m[2].matchAll(/\b(en|ms|zh|my):\s*(['"`])((?:\\.|(?!\2).)*)\2/g)) vals[v[1]] = v[3];
  entries.set(m[1], vals);
}

test('the dictionary parsed (sanity)', () => {
  assert.ok(entries.size > 200, `only ${entries.size} entries parsed`);
  assert.ok(entries.has('scan.wrongDeptTitle'));
});

test('every t("key") used on a worker page exists in worker-i18n.ts', () => {
  const missing = [];
  for (const f of pages) {
    for (const m of read(f).matchAll(/\bt\(\s*['"]([a-zA-Z0-9_.]+)['"]\s*\)/g)) {
      if (!entries.has(m[1])) missing.push(`${m[1]} (${f})`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('every entry has all four languages, non-empty', () => {
  const incomplete = [];
  for (const [key, vals] of entries) {
    for (const lang of ['en', 'ms', 'zh', 'my']) {
      if (!vals[lang] || !vals[lang].trim()) incomplete.push(`${key}.${lang}`);
    }
  }
  assert.deepEqual(incomplete, []);
});

test('a translation keeps the placeholders its English has', () => {
  const broken = [];
  for (const [key, vals] of entries) {
    const want = [...(vals.en ?? '').matchAll(/\{[a-zA-Z]+\}/g)].map((m) => m[0]).sort().join();
    for (const lang of ['ms', 'zh', 'my']) {
      const got = [...(vals[lang] ?? '').matchAll(/\{[a-zA-Z]+\}/g)].map((m) => m[0]).sort().join();
      if (got !== want) broken.push(`${key}.${lang}: has [${got}] wants [${want}]`);
    }
  }
  assert.deepEqual(broken, []);
});

test('the scan pop-ups that stop a worker are no longer hardcoded English', () => {
  const scan = read('src/pages/worker/scan.tsx');
  for (const gone of [
    '>Wrong department<',
    '>Not this step yet<',
    '>Finish first:<',
    'Unlock and complete this step anyway?',
    'Later this will need a supervisor.',
    'You are in <strong>',
    'Scan the <strong>',
    '`Not found: ${',
    'Scan a rack QR first to stock it in.`',
  ]) {
    assert.ok(!scan.includes(gone), `still hardcoded: ${gone}`);
  }
  // The sequence-lock pop-up ("Not this step yet") is not on every branch;
  // where the scan page has it, it must be translated too.
  const keys = ['scan.wrongDeptTitle', 'scan.wrongDeptBody', 'scan.wrongDeptHowTo'];
  if (scan.includes('result.kind === "blocked"')) keys.push('scan.blockedTitle', 'scan.unlockConfirm');
  for (const key of keys) {
    assert.ok(scan.includes(`t("${key}")`), `scan.tsx does not use ${key}`);
  }
});

test('the other worker pages lost their hardcoded English too', () => {
  // A string = it must not appear anywhere. A RegExp = a bare JSX text line
  // (the phrase alone on its line), so a code comment naming it is fine.
  const bare = (s) => new RegExp(`^\\s*${s}\\s*$`, 'm');
  const checks = {
    'src/pages/worker/me.tsx': ['>Annual</option>', '>Medical</option>', bare('Standard Times'), 'placeholder="Search product', '>No match.<'],
    'src/pages/worker/pay.tsx': ['alert("Please allow pop-ups', 'alert("Could not reach the server', '>Net pay<'],
    'src/pages/worker/issue.tsx': ['>Tap to capture<', bare('Take photo')],
    'src/pages/worker/announcement-media.tsx': ['>This image could not be displayed.<', bare('Open original'), bare('Image unavailable'), '>Video<'],
  };
  for (const [file, literals] of Object.entries(checks)) {
    const text = read(file);
    for (const l of literals) {
      const found = typeof l === 'string' ? text.includes(l) : l.test(text);
      assert.ok(!found, `${file} still hardcodes: ${String(l)}`);
    }
  }
});

test('the non-production request date defaults to the MALAYSIA date, not the UTC one', () => {
  const me = read('src/pages/worker/me.tsx');
  assert.match(me, /const \[npDate, setNpDate\] = useState\(\(\) => todayYmdMY\(\)\);/);
  assert.doesNotMatch(me, /toISOString\(\)\.slice\(0, ?10\)/, 'a UTC "today" is yesterday before 08:00 MYT');
});
