// ---------------------------------------------------------------------------
// mail-reads-acks.test.mjs — PRD T-012 R7 / R8: per-person read state and
// acknowledgement.
//
//   - ackDueAt clamps to [1h, 14d] and defaults to 48h
//   - laterOf pushes read_at to at least last_message_at
//   - the unread SQL falls back to the legacy shared flag when a person has
//     no row (so nothing lights up unread for everyone on deploy)
//   - the list joins the caller's read row; opening a thread writes the
//     caller's row and no longer clears the shared flag; PATCH unread is
//     per person
//   - the acknowledge endpoint is scoped like every other read
//   - compose / reply open acknowledgement rows for staff recipients only
//   - the outbox cron chases overdue rows
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on newer Node.
}

const acks = await import("../src/api/lib/mail-acks.ts");
const { ackDueAt, laterOf, myUnreadSql, ACK_DEFAULT_HOURS } = acks;

test("ackDueAt: default 48h, clamped to [1h, 14d]", () => {
  const now = "2026-09-21T00:00:00.000Z";
  assert.equal(ackDueAt(now, undefined), "2026-09-23T00:00:00.000Z");
  assert.equal(ACK_DEFAULT_HOURS, 48);
  assert.equal(ackDueAt(now, 24), "2026-09-22T00:00:00.000Z");
  assert.equal(ackDueAt(now, 0), "2026-09-21T01:00:00.000Z");
  assert.equal(ackDueAt(now, 24 * 365), "2026-10-05T00:00:00.000Z");
  assert.equal(ackDueAt(now, Number.NaN), "2026-09-23T00:00:00.000Z");
});

test("laterOf is a plain ISO string compare", () => {
  assert.equal(laterOf("2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"), "2026-02-01T00:00:00.000Z");
  assert.equal(laterOf("2026-03-01T00:00:00.000Z", null), "2026-03-01T00:00:00.000Z");
  assert.equal(laterOf(null, "2026-03-01T00:00:00.000Z"), "2026-03-01T00:00:00.000Z");
});

test("the unread rule: no row → legacy flag; NULL read_at → unread; stale read → unread", () => {
  const sql = myUnreadSql();
  assert.match(sql, /WHEN r\.thread_id IS NULL THEN t\.unread/);
  assert.match(sql, /WHEN r\.read_at IS NULL THEN 1/);
  assert.match(sql, /WHEN r\.read_at < COALESCE\(t\.last_message_at, ''\) THEN 1/);
  assert.match(sql, /ELSE 0/);
});

const route = readFileSync(
  new URL("../src/api/routes/mail-center.ts", import.meta.url),
  "utf8",
);
const worker = readFileSync(
  new URL("../src/api/worker.ts", import.meta.url),
  "utf8",
);

function handler(verb, path) {
  const start = route.indexOf(`app.${verb}("${path}"`);
  assert.notEqual(start, -1, `no handler for ${verb.toUpperCase()} ${path}`);
  const next = route.indexOf("\napp.", start + 1);
  return route.slice(start, next === -1 ? route.length : next);
}

test("GET /threads computes unread per caller", () => {
  const h = handler("get", "/threads");
  assert.match(h, /\$\{myUnreadSql\(\)\} AS my_unread/);
  assert.match(h, /\$\{myReadJoinSql\(\)\}/);
  assert.match(h, /\.bind\(scope\.userId, \.\.\.binds\)/);
});

test("opening a thread writes the caller's read row, not the shared flag", () => {
  const h = handler("get", "/threads/:id");
  assert.match(h, /markThreadRead\(c\.var\.DB, \{/);
  assert.doesNotMatch(h, /UPDATE email_threads SET unread = 0/);
  assert.match(h, /readBy, audience/);
  assert.match(h, /acks: acks\.get\(m\.id\)/);
});

test("PATCH unread is per person and assign / archive / delete are audited", () => {
  const h = handler("patch", "/threads/:id");
  assert.doesNotMatch(h, /sets\.push\("unread = \?"\)/);
  assert.match(h, /markThreadUnread\(c\.var\.DB/);
  assert.match(h, /markThreadRead\(c\.var\.DB/);
  for (const action of ['"delete"', '"restore"', '"archive"', '"reopen"', '"assign"']) {
    assert.ok(h.includes(action), `audit action ${action}`);
  }
});

test("acknowledge is permission-checked AND scoped, and audited", () => {
  const h = handler("post", "/threads/:id/messages/:mid/acknowledge");
  assert.match(h, /requirePermission\(c, "mail-center", "read"\)/);
  assert.match(h, /getMailScope\(c, orgId\)/);
  assert.match(h, /acknowledgeMessage\(c\.var\.DB/);
  assert.match(h, /action: "acknowledge"/);
});

test("compose and reply open acknowledgement rows for staff recipients only", () => {
  for (const [verb, path] of [
    ["post", "/compose"],
    ["post", "/threads/:id/reply"],
  ]) {
    const h = handler(verb, path);
    assert.match(h, /staffRecipients\(c\.var\.DB, orgId, \[\.\.\.to, \.\.\.cc\]\)/, path);
    assert.match(h, /createAckRequests\(c\.var\.DB, \{/, path);
    // The sender has obviously read what they just sent.
    assert.match(h, /markThreadRead\(c\.var\.DB, \{/, path);
    // A request nobody can meet is refused BEFORE the mail goes out.
    assert.ok(h.indexOf("acknowledgement needs at least one staff recipient") < h.indexOf("await sendMail("), path);
  }
});

test("the reply no longer clears the shared unread flag for everyone", () => {
  const h = handler("post", "/threads/:id/reply");
  assert.doesNotMatch(h, /message_count = message_count \+ 1, unread = 0/);
});

test("the outbox cron chases overdue acknowledgements", () => {
  assert.match(worker, /chaseOverdueAcknowledgements\(c\)/);
});
