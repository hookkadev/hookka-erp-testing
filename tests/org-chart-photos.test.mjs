// ---------------------------------------------------------------------------
// org-chart-photos.test.mjs — "can the org chart have a picture as well for
// each acc" (2026-09-28).
//
// The board had initials only — the code even said so: "Initials until there
// is somewhere to store a photo." There is now: one column on EACH of `users`
// and `workers` (not a join — those two tables already have no link between
// them by design), and the actual bytes go through the EXISTING /api/files
// store rather than a new upload path. GET /api/org-chart/photo does not
// exist; the client uploads first, then hands this route only the resulting
// file id.
//
// What is pinned here, against the REAL router with a stub DB:
//   1. GET / returns photoFileId for both a `users` row and a `workers` row,
//      including the dual-key (photo_file_id) read;
//   2. PUT /photo is gated the same as /reporting — users:update, refused
//      otherwise, and the refused write never touches the database;
//   3. a fileId that is not a real, this-org file is refused (400) — an
//      arbitrary string must not become an <img src>;
//   4. the write lands on the RIGHT table — a user:* key updates `users`, a
//      worker:* key updates `workers`, never the other one;
//   5. an empty/omitted fileId CLEARS the photo (NULL), the same way an empty
//      managerKey already clears the reporting line on /reporting;
//   6. an unknown personKey is refused (400) before any UPDATE runs.
//
// Plus source guards for the frontend: the shared upload helper is reused
// (not a bare fetch, which would skip the size cap / timeout / read-back
// verification every other upload surface gets), and the avatar is a
// module-level component — one defined INSIDE the per-card render function
// would remount on every re-render and drop its own upload-in-progress state.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const {
  default: orgChartApp,
  _resetOrgReportingMigForTests,
  _resetOrgPhotoMigForTests,
} = await import(src('src/api/routes/org-chart.ts'));

const USERS = [
  { id: 'u-1', displayName: 'Violet', email: 'violet@hookka.com', department: 'Office', position: 'GM', reportsTo: null, isActive: 1, photoFileId: null },
];
const WORKERS = [
  { id: 'w-1', empNo: 'E001', name: 'Ye Li Soe', position: 'Operator', status: 'ACTIVE', departmentCode: 'WOOD_CUT', photoFileId: 'file-existing' },
];
const photo = (resourceId, orgId = 'hookka') => ({ orgId, resourceType: 'org-photo', resourceId });
const FILE_ASSETS = new Map([
  ['file-existing', photo('worker:w-1')],
  ['file-new', photo('worker:w-1')],
  ['file-new-u1', photo('user:u-1')],
  ['file-other-org', photo('worker:w-1', 'acme')],
  // Real files in the right org that are NOT this person's photo.
  ['file-so-pdf', { orgId: 'hookka', resourceType: 'SO', resourceId: 'so-1' }],
  ['file-photo-of-w2', photo('worker:w-2')],
]);

function makeDb(workers = WORKERS) {
  const seen = [];
  const writes = [];
  const migrations = [];
  const deletes = [];
  function prepare(sql) {
    seen.push(sql);
    let bound = [];
    const stmt = {
      bind(...a) {
        bound = a;
        return stmt;
      },
      async first() {
        if (/FROM file_assets WHERE id = \? AND orgId = \?/i.test(sql)) {
          const row = FILE_ASSETS.get(bound[0]);
          if (!row || row.orgId !== bound[1]) return null;
          if (/resourceType = 'org-photo' AND resourceId = \?/i.test(sql)) {
            if (row.resourceType !== 'org-photo' || row.resourceId !== bound[2]) return null;
          }
          return { id: bound[0], r2Key: `k-${bound[0]}` };
        }
        return null;
      },
      async all() {
        if (/FROM users/i.test(sql)) return { results: USERS, success: true };
        if (/FROM workers/i.test(sql)) return { results: workers, success: true };
        if (/FROM org_reporting/i.test(sql)) return { results: [], success: true };
        return { results: [], success: true };
      },
      async run() {
        if (/^ALTER TABLE/i.test(sql)) migrations.push(sql);
        else if (/^UPDATE (users|workers) SET photoFileId/i.test(sql)) {
          writes.push({ sql, table: sql.match(/^UPDATE (\w+)/i)[1], fileId: bound[0], id: bound[1] });
        } else if (/^DELETE FROM file_assets WHERE id = \? AND orgId = \?/i.test(sql)) {
          deletes.push({ id: bound[0], orgId: bound[1] });
        }
        return { success: true };
      },
    };
    return stmt;
  }
  return {
    seen,
    writes,
    migrations,
    deletes,
    db: { prepare, batch: async () => [{ results: [] }] },
  };
}

function call(db, method, path, role, body) {
  _resetOrgReportingMigForTests();
  _resetOrgPhotoMigForTests();
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('DB', db);
    c.set('orgId', 'hookka');
    c.set('userRole', role);
    await next();
  });
  app.route('/', orgChartApp);
  return app.request(
    path,
    body !== undefined
      ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : { method },
    {},
  );
}

test('GET / returns photoFileId for both a user and a worker, dual-keyed', async () => {
  const { db } = makeDb();
  const res = await call(db, 'GET', '/', 'SUPER_ADMIN');
  assert.equal(res.status, 200);
  const body = await res.json();
  const byKey = Object.fromEntries(body.data.map((p) => [p.key, p]));
  assert.equal(byKey['user:u-1'].photoFileId, null, 'no photo yet — must be null, not undefined');
  assert.equal(byKey['worker:w-1'].photoFileId, 'file-existing');
});

test('the migration runs before the SELECT that names photoFileId', async () => {
  const { db, migrations, seen } = makeDb();
  await call(db, 'GET', '/', 'SUPER_ADMIN');
  assert.ok(migrations.some((m) => /ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_file_id/i.test(m)));
  assert.ok(migrations.some((m) => /ALTER TABLE workers ADD COLUMN IF NOT EXISTS photo_file_id/i.test(m)));
  assert.ok(seen.some((s) => /SELECT .*photoFileId.* FROM users/i.test(s)));
});

test('a role without users:update is refused, and the refusal never reaches the database', async () => {
  const { db, writes } = makeDb();
  const res = await call(db, 'PUT', '/photo', 'HR', { personKey: 'worker:w-1', fileId: 'file-new' });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.missingPermission, 'users:update');
  assert.equal(writes.length, 0);
});

test('a fileId that is not a real file in THIS org is refused', async () => {
  const { db, writes } = makeDb();
  const res = await call(db, 'PUT', '/photo', 'SUPER_ADMIN', { personKey: 'worker:w-1', fileId: 'not-a-real-file-id' });
  assert.equal(res.status, 400);
  assert.equal(writes.length, 0, 'an unverified id must never be written as if it were a real photo');
});

test('a file that belongs to another org is refused, even though the id is real', async () => {
  const { db, writes } = makeDb();
  const res = await call(db, 'PUT', '/photo', 'SUPER_ADMIN', { personKey: 'worker:w-1', fileId: 'file-other-org' });
  assert.equal(res.status, 400);
  assert.equal(writes.length, 0);
});

test('an unknown personKey is refused before any UPDATE runs', async () => {
  const { db, writes } = makeDb();
  const res = await call(db, 'PUT', '/photo', 'SUPER_ADMIN', { personKey: 'worker:does-not-exist', fileId: 'file-new' });
  assert.equal(res.status, 400);
  assert.equal(writes.length, 0);
});

test('SUPER_ADMIN setting a WORKER photo updates the workers table, not users', async () => {
  const { db, writes } = makeDb();
  const res = await call(db, 'PUT', '/photo', 'SUPER_ADMIN', { personKey: 'worker:w-1', fileId: 'file-new' });
  assert.equal(res.status, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].table, 'workers');
  assert.equal(writes[0].id, 'w-1');
  assert.equal(writes[0].fileId, 'file-new');
});

test('SUPER_ADMIN setting a USER photo updates the users table, not workers', async () => {
  const { db, writes } = makeDb();
  const res = await call(db, 'PUT', '/photo', 'SUPER_ADMIN', { personKey: 'user:u-1', fileId: 'file-new-u1' });
  assert.equal(res.status, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].table, 'users');
  assert.equal(writes[0].id, 'u-1');
});

test('an empty fileId CLEARS the photo, same as clearing a reporting line', async () => {
  const { db, writes } = makeDb();
  const res = await call(db, 'PUT', '/photo', 'SUPER_ADMIN', { personKey: 'worker:w-1', fileId: '' });
  assert.equal(res.status, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].fileId, null);
});

// ---------------------------------------------------------------------------
// Old-photo cleanup — "if i want to change the picture did the old picture
// get deleted and replace with the new one?" (owner, 2026-09-29). Before this,
// no: the pointer moved but the previous file_assets row (and its Supabase
// Storage object) was never touched, so every change orphaned one file.
// ---------------------------------------------------------------------------
test('changing an existing photo deletes the PREVIOUS file_assets row, not just the pointer', async () => {
  const { db, writes, deletes } = makeDb();
  const res = await call(db, 'PUT', '/photo', 'SUPER_ADMIN', { personKey: 'worker:w-1', fileId: 'file-new' });
  assert.equal(res.status, 200);
  assert.equal(writes.length, 1, 'the pointer still moves');
  assert.equal(deletes.length, 1, 'the OLD file (file-existing) must be removed');
  assert.equal(deletes[0].id, 'file-existing');
  assert.equal(deletes[0].orgId, 'hookka', 'the delete stays scoped to the caller\'s own org');
});

test('clearing a photo also deletes the previous file, not only the pointer', async () => {
  const { db, deletes } = makeDb();
  const res = await call(db, 'PUT', '/photo', 'SUPER_ADMIN', { personKey: 'worker:w-1', fileId: '' });
  assert.equal(res.status, 200);
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].id, 'file-existing');
});

test('setting a photo for someone who had NONE attempts no delete at all', async () => {
  const { db, deletes } = makeDb();
  const res = await call(db, 'PUT', '/photo', 'SUPER_ADMIN', { personKey: 'user:u-1', fileId: 'file-new-u1' });
  assert.equal(res.status, 200);
  assert.equal(deletes.length, 0, 'there was no previous file to clean up');
});

test('re-saving the SAME fileId is a no-op, not a delete-then-restore of the same file', async () => {
  const { db, deletes, writes } = makeDb();
  const res = await call(db, 'PUT', '/photo', 'SUPER_ADMIN', { personKey: 'worker:w-1', fileId: 'file-existing' });
  assert.equal(res.status, 200);
  assert.equal(writes.length, 1);
  assert.equal(deletes.length, 0, 'the old and new id are identical — nothing to clean up');
});

test('the request still SUCCEEDS even though this stub org has no storage credentials configured', async () => {
  // removeStoredFile degrades a missing-storage-config error to "drop the DB
  // row only" (see files.ts) rather than failing the whole request — the
  // pointer write already committed, so a storage hiccup on the OLD file
  // must not be reported back as a failure to change the photo.
  const { db } = makeDb();
  const res = await call(db, 'PUT', '/photo', 'SUPER_ADMIN', { personKey: 'worker:w-1', fileId: 'file-new' });
  const body = await res.json();
  assert.equal(body.success, true);
});

// ---------------------------------------------------------------------------
// Scope — only THIS person's uploaded photo (2026-09-30 review). Because the
// previous photo is deleted on change, accepting any org file would let a
// users:update holder delete an unrelated document: point a photo at a
// sales-order PDF, change the photo, and the PDF is removed.
// ---------------------------------------------------------------------------
test('a real org file that is NOT a photo (a sales-order PDF) is refused', async () => {
  const { db, writes } = makeDb();
  const res = await call(db, 'PUT', '/photo', 'SUPER_ADMIN', { personKey: 'worker:w-1', fileId: 'file-so-pdf' });
  assert.equal(res.status, 400);
  assert.equal(writes.length, 0);
});

test("another person's photo is refused — a photo belongs to the person it was uploaded for", async () => {
  const { db, writes } = makeDb();
  const res = await call(db, 'PUT', '/photo', 'SUPER_ADMIN', { personKey: 'worker:w-1', fileId: 'file-photo-of-w2' });
  assert.equal(res.status, 400);
  assert.equal(writes.length, 0);
});

test('an old pointer to a NON-photo file is never deleted on change', async () => {
  // A pointer written before the scope check existed could name any file.
  const { db, writes, deletes } = makeDb([{ ...WORKERS[0], photoFileId: 'file-so-pdf' }]);
  const res = await call(db, 'PUT', '/photo', 'SUPER_ADMIN', { personKey: 'worker:w-1', fileId: 'file-new' });
  assert.equal(res.status, 200);
  assert.equal(writes.length, 1, 'the new photo is still set');
  assert.equal(deletes.length, 0, 'the sales-order PDF must survive');
});

test('the route reuses the ONE shared delete path (files.ts removeStoredFile), not a bespoke storage call', () => {
  const route = readFileSync(resolve(process.cwd(), 'src/api/routes/org-chart.ts'), 'utf8');
  assert.match(route, /import \{ removeStoredFile \} from "\.\/files";/);
  assert.match(route, /await removeStoredFile\(c, oldFileId\)/);
});

// ---------------------------------------------------------------------------
// Frontend source guards
// ---------------------------------------------------------------------------
const UI = readFileSync(resolve(process.cwd(), 'src/components/org-chart.tsx'), 'utf8').replace(
  /\r\n/g,
  '\n',
);

test('the upload goes through the shared hardened helper, not a bare fetch of the file bytes', () => {
  assert.match(UI, /import \{ uploadFileAsset \} from "@\/lib\/upload-file";/);
  assert.match(UI, /uploadFileAsset\(\{\s*\n\s*file,\s*\n\s*resourceType: "org-photo"/);
});

test('PersonAvatar is a module-level component, not one defined inside the per-card render', () => {
  // A component recreated inside TreeCard / the board's .map() remounts every
  // time ANYTHING on the chart re-renders, dropping its own mid-upload state.
  // Module-level in this file's style means no leading indentation on the
  // declaration line.
  assert.match(UI, /^function PersonAvatar\(\{/m);
});

test('both render sites use PersonAvatar — neither still draws a bare initials circle', () => {
  const uses = (UI.match(/<PersonAvatar\b/g) ?? []).length;
  assert.equal(uses, 2, 'the tree card and the board card must both use it');
  assert.doesNotMatch(
    UI,
    /rounded-full text-\[10px\] font-bold[\s\S]{0,120}initials\(/,
    'a raw initials-only circle must not still exist alongside PersonAvatar',
  );
});

test('the photo is fetched via /stream, not /download — BUG-2026-09-29-214', () => {
  // /download 302s to a Supabase presigned URL. Reproduced against staging's
  // Supabase project: the presigned URL Supabase itself issued came back
  // "InvalidSignature" when fetched — measured against the real service, not
  // assumed. /stream proxies the bytes straight through this Worker with the
  // service_role key on every request, so there is no signature to fail.
  assert.match(UI, /src=\{`\/api\/files\/\$\{person\.photoFileId\}\/stream`\}/);
  assert.doesNotMatch(
    UI,
    /\/api\/files\/\$\{person\.photoFileId\}\/download/,
    'a regression back to the presigned-URL path would resurrect BUG-2026-09-29-214',
  );
});

test('clicking an EXISTING photo views it, and only a missing photo starts an upload — owner feedback 2026-09-29', () => {
  // Owner, testing it live: "when i click the picture it send me to change to
  // a new picture, can i have it like when i click it just shows the picture
  // bigger." Before this, the circle's onClick always opened the file picker.
  assert.match(UI, /const hasPhoto = !!person\.photoFileId;/);
  assert.match(
    UI,
    /const primaryAction = hasPhoto \? onView : \(\) => inputRef\.current\?\.click\(\);/,
  );
  assert.match(UI, /onClick=\{primaryAction\}/);
});

test('a dedicated pencil badge starts the upload regardless of whether a photo already exists', () => {
  // The one remaining always-on way to CHANGE a photo, now that the circle
  // itself is view-only once a photo is set.
  assert.match(UI, /title=\{`Change \$\{person\.name\}'s photo`\}/);
  const badgeIdx = UI.indexOf("title={`Change ${person.name}'s photo`}");
  assert.match(
    UI.slice(Math.max(0, badgeIdx - 200), badgeIdx),
    /onClick=\{\(\) => inputRef\.current\?\.click\(\)\}/,
  );
});

test('the lightbox renders the SAME /stream URL, keyed off viewingPhoto rather than person', () => {
  assert.match(UI, /const \[viewingPhoto, setViewingPhoto\] = useState<Pick<\s*\n\s*OrgPerson,\s*\n\s*"name" \| "photoFileId"\s*\n\s*> \| null>\(null\);/);
  assert.match(UI, /\{viewingPhoto\?\.photoFileId && \(/);
  assert.match(UI, /src=\{`\/api\/files\/\$\{viewingPhoto\.photoFileId\}\/stream`\}/);
});

test('both render sites open the SAME lightbox via onView, not a second modal each', () => {
  const uses = (UI.match(/onView=\{\(\) => setViewingPhoto\(/g) ?? []).length;
  assert.equal(uses, 2, 'the tree card and the board card must both wire onView to the one lightbox state');
});
