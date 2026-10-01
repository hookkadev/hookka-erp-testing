// ---------------------------------------------------------------------------
// worker-login-signin-text.test.mjs — the worker login showed the FIRST-TIME
// SETUP sentence ("Create a 6-digit PIN for this employee number…") under
// "Sign in" as well, telling a worker who already has a PIN to create one.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const page = readFileSync(resolve(process.cwd(), 'src/pages/worker/login.tsx'), 'utf8').replace(/\r\n/g, '\n');
const dict = readFileSync(resolve(process.cwd(), 'src/lib/worker-i18n.ts'), 'utf8').replace(/\r\n/g, '\n');

test('sign-in mode shows the sign-in sentence, setup mode keeps the setup one', () => {
  assert.match(page, /mode === "login"\s*\n\s*\? t\("login\.signInDesc"\)/);
  assert.match(page, /mode === "setup"\s*\n\s*\? t\("login\.setupDesc"\)/);
});

test('the sign-in sentence exists in all four languages', () => {
  const block = dict.match(/'login\.signInDesc': \{\n([\s\S]*?)\n\s*\},/);
  assert.ok(block, 'login.signInDesc is missing from worker-i18n.ts');
  for (const lang of ['en', 'ms', 'zh', 'my']) {
    assert.match(block[1], new RegExp(`^\\s*${lang}: '.+',$`, 'm'), `${lang} is missing`);
  }
  assert.doesNotMatch(block[1], /Create a 6-digit PIN/);
});
