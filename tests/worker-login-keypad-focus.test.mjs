// ---------------------------------------------------------------------------
// worker-login-keypad-focus.test.mjs — the worker login's PIN keypad listens
// to the whole window so a hardware keyboard works. It guarded Backspace while
// the Employee No. box had focus, but not the digits: typing "E001234" put
// 0-0-1-2-3-4 into the PIN as well, and the 6th digit auto-submitted a login
// with that accidental PIN (each one counting toward the 10-per-15-min lock).
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

try {
  register('tsx/esm', pathToFileURL('./'));
} catch {
  // Native type-stripping handles it on newer Node.
}

const { isTypingTarget } = await import(
  pathToFileURL(resolve(process.cwd(), 'src/lib/typing-target.ts')).href
);

test('a text box, textarea, select or editable region is a typing target', () => {
  assert.equal(isTypingTarget({ tagName: 'INPUT' }), true);
  assert.equal(isTypingTarget({ tagName: 'input' }), true);
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTypingTarget({ tagName: 'SELECT' }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
});

test('the page body, a button or nothing focused is NOT — the keypad still takes keys there', () => {
  assert.equal(isTypingTarget({ tagName: 'BODY' }), false);
  assert.equal(isTypingTarget({ tagName: 'BUTTON' }), false);
  assert.equal(isTypingTarget({ tagName: 'DIV' }), false);
  assert.equal(isTypingTarget(null), false);
  assert.equal(isTypingTarget(undefined), false);
});

test('the login keypad stands down BEFORE reading any key, digits included', () => {
  const page = readFileSync(resolve(process.cwd(), 'src/pages/worker/login.tsx'), 'utf8').replace(/\r\n/g, '\n');
  const start = page.indexOf('function onKey(ev: KeyboardEvent)');
  assert.ok(start >= 0);
  const body = page.slice(start, page.indexOf('window.addEventListener("keydown", onKey)', start));
  const guard = body.indexOf('isTypingTarget(document.activeElement');
  const digits = body.indexOf('pressKey(ev.key)');
  assert.ok(guard >= 0, 'the focus guard is gone');
  assert.ok(digits >= 0);
  assert.ok(guard < digits, 'the guard must run before the digit branch, not only before Backspace');
});
