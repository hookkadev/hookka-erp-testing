// ---------------------------------------------------------------------------
// user-detail-drawer-photo.test.mjs — "we can make the add picture in the
// users list table" (2026-09-29), the second half of the same owner feedback
// that produced the org-chart lightbox (see org-chart-photos.test.mjs).
//
// Before this, a photo could ONLY be set from the Org Chart card — someone
// managing accounts from Settings → Users had no way to attach one at all.
// This adds the same photo onto the SAME column (users.photo_file_id) through
// the SAME two routes the chart already uses:
//   1. POST/PUT to the shared /api/files store (uploadFileAsset — size cap,
//      timeout, read-back verification — never a bare fetch of the bytes);
//   2. PUT /api/org-chart/photo with the resulting file id, which is the one
//      route that actually writes photo_file_id, keyed `user:<id>` for
//      everyone reachable from this drawer (it only ever edits `users` rows).
//
// These are source guards, not a rendered-component test — the codebase has
// no React test renderer set up, and every other UI feature in this repo
// (org-chart.tsx included) is pinned the same way: assert the exact call
// shape exists in the file, so a refactor that silently drops a step (e.g.
// swaps the shared helper for a bare fetch, or forgets to key off the right
// person) fails a text match instead of shipping unnoticed.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DRAWER = readFileSync(
  resolve(process.cwd(), 'src/components/user-detail-drawer.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');
const USERS_PAGE = readFileSync(
  resolve(process.cwd(), 'src/pages/settings/Users.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');

test('the drawer accepts photoFileId as a prop, seeded from the caller', () => {
  assert.match(DRAWER, /photoFileId\?: string \| null;/);
  assert.match(DRAWER, /photoFileId: initialPhotoFileId,/);
  assert.match(DRAWER, /const \[photoFileId, setPhotoFileId\] = useState\(initialPhotoFileId \?\? null\);/);
});

test('the upload goes through the shared hardened helper, not a bare fetch of the file bytes', () => {
  // Same guard as org-chart-photos.test.mjs — a second upload surface that
  // skipped uploadFileAsset would skip its size cap / timeout / read-back
  // verification too.
  assert.match(DRAWER, /import \{ uploadFileAsset \} from "@\/lib\/upload-file";/);
  assert.match(DRAWER, /uploadFileAsset\(\{\s*\n\s*file,\s*\n\s*resourceType: "org-photo"/);
});

test('the resulting file id is written through PUT /api/org-chart/photo, keyed to THIS user', () => {
  assert.match(DRAWER, /fetch\("\/api\/org-chart\/photo",\s*\{/);
  assert.match(DRAWER, /personKey: `user:\$\{user\.id\}`, fileId/);
});

test('the Remove button clears the photo the same way the reporting picker clears a manager — an empty string, not omitting the field', () => {
  assert.match(DRAWER, /onClick=\{\(\) => setPhoto\(""\)\}/);
});

test('a successful photo write calls onSaved, so the grid and the org chart both refetch', () => {
  const idx = DRAWER.indexOf('async function setPhoto(');
  assert.ok(idx >= 0);
  assert.match(DRAWER.slice(idx, idx + 900), /onSaved\(\);/);
});

test('Users.tsx reads photoFileId from /api/org-chart, the same source the chart itself reads', () => {
  assert.match(
    USERS_PAGE,
    /managerKey: string \| null;\s*\n\s*photoFileId: string \| null;/,
  );
  assert.match(
    USERS_PAGE,
    /photoFileId=\{\s*\n\s*orgPeople\.find\(\(p\) => p\.key === `user:\$\{drawerUser\.id\}`\)\?\.photoFileId \?\? null\s*\n\s*\}/,
  );
});
