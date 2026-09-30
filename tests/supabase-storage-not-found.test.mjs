// ---------------------------------------------------------------------------
// supabase-storage-not-found.test.mjs — BUG-2026-09-29-222.
//
// Supabase Storage reports a missing object as HTTP 400 with a body of
// {"statusCode":"404","error":"not_found",...}, not as an HTTP 404. The helper
// only recognised 404, so:
//   * deleteFile of an already-gone object THREW → removeStoredFile kept the
//     file_assets row forever (measured on staging 2026-09-29 17:47:58: the
//     org-chart old-photo delete got 400 and its row survived);
//   * getFile of a missing object THREW → /api/files/:id/stream answered a
//     generic 500 "stream failed" instead of 404.
// A 400 that is NOT the not-found shape (e.g. InvalidSignature) must still fail.
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

const { deleteFile, getFile, isObjectNotFound } = await import(
  pathToFileURL(resolve(process.cwd(), 'src/api/lib/supabase-storage.ts')).href
);

const ENV = { SUPABASE_PROJECT_REF: 'testref', SUPABASE_SERVICE_KEY: 'k' };
const NOT_FOUND_400 = JSON.stringify({ statusCode: '404', error: 'not_found', message: 'Object not found' });
const BAD_SIG_400 = JSON.stringify({ statusCode: '400', error: 'InvalidSignature', message: 'Invalid signature' });

function withFetch(status, body, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, { status });
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = real;
  });
}

test("deleteFile: Supabase's 400 not-found counts as already deleted", async () => {
  await withFetch(400, NOT_FOUND_400, () => deleteFile(ENV, 'hookka/org-photo/x.jpg'));
});

test('deleteFile: a plain HTTP 404 still counts as already deleted', async () => {
  await withFetch(404, '', () => deleteFile(ENV, 'hookka/org-photo/x.jpg'));
});

test('deleteFile: any OTHER 400 is a real failure and still throws', async () => {
  await assert.rejects(withFetch(400, BAD_SIG_400, () => deleteFile(ENV, 'k.jpg')), /400/);
});

test('deleteFile: a 500 still throws', async () => {
  await assert.rejects(withFetch(500, 'boom', () => deleteFile(ENV, 'k.jpg')), /500/);
});

test("getFile: Supabase's 400 not-found returns null (→ 404), not a throw (→ 500)", async () => {
  const r = await withFetch(400, NOT_FOUND_400, () => getFile(ENV, 'hookka/org-photo/x.jpg'));
  assert.equal(r, null);
});

test('getFile: any OTHER 400 still throws', async () => {
  await assert.rejects(withFetch(400, BAD_SIG_400, () => getFile(ENV, 'k.jpg')), /400/);
});

test('isObjectNotFound: only the not-found shapes', () => {
  assert.equal(isObjectNotFound(404, ''), true);
  assert.equal(isObjectNotFound(400, NOT_FOUND_400), true);
  assert.equal(isObjectNotFound(400, JSON.stringify({ error: 'NoSuchKey' })), true);
  assert.equal(isObjectNotFound(400, BAD_SIG_400), false);
  assert.equal(isObjectNotFound(400, 'not json'), false);
  assert.equal(isObjectNotFound(403, NOT_FOUND_400), false);
});
