// Staging-only: never PR this into main.
// /staging-mail reads MailSlurp sent mail through the worker. Stubbed fetch
// only: no network, no MailSlurp, no DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getSentAttachment, getSentMail, htmlFromRawMime, listSentMail } from "../src/api/lib/staging-mail.ts";
import { isStagingRequest } from "../src/api/lib/staging-gate.ts";

const INBOX = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SENT = "33333333-3333-4333-8333-333333333333";
const ATT = "44444444-4444-4444-8444-444444444444";

function stub(routes) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: String(url), key: init?.headers?.["x-api-key"] });
    const path = String(url).replace("https://api.mailslurp.com", "");
    const hit = Object.entries(routes).find(([p]) => path === p || path.startsWith(p + "?"));
    if (!hit) return new Response("nope", { status: 404 });
    const v = hit[1];
    return v instanceof Uint8Array || typeof v === "string"
      ? new Response(v, { status: 200 })
      : new Response(JSON.stringify(v), { status: 200 });
  };
  return { f, calls };
}

const sentDto = (inboxId) => ({
  id: SENT,
  inboxId,
  userId: "u",
  to: ["a@example.com"],
  subject: "[Hookka] Overdue Report",
  body: "<p>hi</p>",
  isHTML: true,
  attachments: [ATT],
  createdAt: "2026-10-01T01:02:03.000Z",
});

test("list asks for the inbox newest first and maps only the safe fields", async () => {
  const { f, calls } = stub({
    "/sent": {
      totalPages: 3,
      content: [{ id: SENT, inboxId: INBOX, userId: "u", to: ["a@example.com"], subject: "S", attachments: [ATT], createdAt: "2026-10-01T00:00:00Z" }],
    },
  });
  const out = await listSentMail(f, "KEY", INBOX, 1, 500);
  const q = new URL(calls[0].url).searchParams;
  assert.equal(q.get("inboxId"), INBOX);
  assert.equal(q.get("sort"), "DESC");
  assert.equal(q.get("page"), "1");
  assert.equal(q.get("size"), "100"); // clamped
  assert.equal(calls[0].key, "KEY");
  assert.deepEqual(out, {
    totalPages: 3,
    rows: [{ id: SENT, at: "2026-10-01T00:00:00Z", to: ["a@example.com"], subject: "S", attachmentCount: 1 }],
  });
});

test("detail returns body and attachment names for our inbox", async () => {
  const { f } = stub({
    [`/sent/${SENT}`]: sentDto(INBOX),
    [`/attachments/${ATT}/metadata`]: { id: ATT, name: "overdue.pdf", contentType: "application/pdf", contentLength: 2048 },
  });
  const d = await getSentMail(f, "KEY", INBOX, SENT);
  assert.equal(d.body, "<p>hi</p>");
  assert.equal(d.isHtml, true);
  assert.deepEqual(d.attachments, [{ id: ATT, name: "overdue.pdf", contentType: "application/pdf", size: 2048 }]);
  assert.equal("inboxId" in d, false);
});

// BUG-2026-10-01-234: the sent record's body stops at the first line break
// (121 chars of the Production Morning Brief) while the delivered email is
// whole. The page takes the longest of body, /html and the raw message.
const BRIEF =
  '<!doctype html><html><head><meta charset="utf-8" />\n<style>p{color:red}</style></head><body><p>Today’s plan</p></body></html>';
const FIRST_LINE = BRIEF.split("\n")[0];

test("detail uses the raw message when the sent record's body is cut at the first line", async () => {
  // Quoted-printable: "=" escaped, the curly quote as utf-8 bytes, one soft line break.
  const qp = BRIEF.replace(/=/g, "=3D").replace("’", "=E2=80=99").replace("<style>", "=\r\n<style>");
  const raw = [
    "Subject: brief",
    "Content-Type: multipart/alternative;",
    ' boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "plain version",
    "--b1",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    qp,
    "--b1--",
    "",
  ].join("\r\n");
  const { f } = stub({
    [`/sent/${SENT}`]: { ...sentDto(INBOX), body: FIRST_LINE, attachments: [] },
    [`/sent/${SENT}/raw`]: raw,
  });
  const d = await getSentMail(f, "KEY", INBOX, SENT);
  assert.equal(d.body, BRIEF);
  assert.equal(d.isHtml, true);
});

test("raw base64 html is decoded as utf-8; no html part gives empty", () => {
  const b64 = Buffer.from(BRIEF, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  const raw = `Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}\r\n`;
  assert.equal(htmlFromRawMime(raw), BRIEF);
  assert.equal(htmlFromRawMime("Content-Type: text/plain\r\n\r\nhello"), "");
  assert.equal(htmlFromRawMime(""), "");
});

test("detail falls back to /html when that is longest, and failing fallbacks keep the body", async () => {
  const viaHtml = stub({
    [`/sent/${SENT}`]: { ...sentDto(INBOX), body: null, isHTML: null, attachments: [] },
    [`/sent/${SENT}/html`]: "<p>from html</p>",
  });
  const d = await getSentMail(viaHtml.f, "KEY", INBOX, SENT);
  assert.equal(d.body, "<p>from html</p>");
  assert.equal(d.isHtml, true);

  // /html and both raw forms 500: the record's own body still shows.
  const ok = stub({ [`/sent/${SENT}`]: { ...sentDto(INBOX), attachments: [] } });
  const f = async (url, init) =>
    /\/(html|raw|raw\/json)$/.test(String(url)) ? new Response("boom", { status: 500 }) : ok.f(url, init);
  const d500 = await getSentMail(f, "KEY", INBOX, SENT);
  assert.equal(d500.body, "<p>hi</p>");
  assert.deepEqual(d500.sources.map((s) => s.status), [200, 500, 500, 500]);
});

test("detail hides mail from another inbox, unknown ids and non-uuids", async () => {
  const { f, calls } = stub({ [`/sent/${SENT}`]: sentDto(OTHER) });
  assert.equal(await getSentMail(f, "KEY", INBOX, SENT), null);
  assert.equal(await getSentMail(f, "KEY", INBOX, "55555555-5555-4555-8555-555555555555"), null);
  const before = calls.length;
  assert.equal(await getSentMail(f, "KEY", INBOX, "../inboxes"), null);
  assert.equal(calls.length, before); // never sent upstream
});

test("attachment proxy only serves an attachment of that sent email", async () => {
  const bytes = new Uint8Array([37, 80, 68, 70]);
  const routes = {
    [`/sent/${SENT}`]: sentDto(INBOX),
    [`/attachments/${ATT}/metadata`]: { name: "overdue.pdf", contentType: "application/pdf", contentLength: 4 },
    [`/attachments/${ATT}/bytes`]: bytes,
  };
  const ok = await getSentAttachment(stub(routes).f, "KEY", INBOX, SENT, ATT);
  assert.equal(ok.meta.name, "overdue.pdf");
  assert.deepEqual(new Uint8Array(ok.body), bytes);

  const stranger = "66666666-6666-4666-8666-666666666666";
  assert.equal(await getSentAttachment(stub(routes).f, "KEY", INBOX, SENT, stranger), null);
  const foreign = { ...routes, [`/sent/${SENT}`]: sentDto(OTHER) };
  assert.equal(await getSentAttachment(stub(foreign).f, "KEY", INBOX, SENT, ATT), null);
});

test("upstream errors other than 404 throw instead of looking empty", async () => {
  const f = async () => new Response("boom", { status: 500 });
  await assert.rejects(() => listSentMail(f, "KEY", INBOX));
  await assert.rejects(() => getSentMail(f, "KEY", INBOX, SENT));
});

test("the gate refuses prod and non-staging hosts", () => {
  const env = { HYPERDRIVE_STAGING: { connectionString: "x" } };
  assert.equal(isStagingRequest({ env, req: { url: "https://staging.hookka-erp-testing.pages.dev/api/staging-mail" } }), true);
  assert.equal(isStagingRequest({ env, req: { url: "https://hookka-erp-testing.pages.dev/api/staging-mail" } }), false);
  assert.equal(isStagingRequest({ env: {}, req: { url: "https://staging.hookka-erp-testing.pages.dev/" } }), false);
});

test("every route sits behind the staging gate and an admin role check", () => {
  const src = readFileSync("src/api/routes/staging-mail.ts", "utf8");
  const mw = src.slice(src.indexOf('app.use("*"'), src.indexOf("await next()"));
  assert.match(mw, /if \(!isStagingRequest\(c\)\) return c\.json\(\{ error: "Not found" \}, 404\)/);
  assert.match(mw, /role !== "SUPER_ADMIN" && role !== "ADMIN"/);
  assert.ok(src.indexOf('app.use("*"') < src.indexOf("app.get("));
  assert.doesNotMatch(readFileSync("src/pages/staging-mail.tsx", "utf8"), /MAILSLURP|x-api-key/);
});

test("an opened email can be shown as source or raw text, so a body that renders blank is still readable", () => {
  const page = readFileSync("src/pages/staging-mail.tsx", "utf8");
  assert.match(page, /\["rendered", "source", "raw"\]/);
  assert.match(page, /Show \{v\}/);
  assert.match(page, /characters/); // the length is shown, so "empty" and "renders blank" can be told apart
  assert.match(page, /Sources: \{detail\.sources\.map\(describeSource\)/);
  // Source and raw are printed as a React text child (escaped), never as HTML.
  assert.match(page, /<pre[^>]*>\s*\{view === "raw" \? detail\.raw : detail\.body\}\s*<\/pre>/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
});

test("detail reports each body source, and raw/json is decoded and used when it is longest", async () => {
  const raw = `Content-Type: text/html; charset=utf-8\r\n\r\n${BRIEF}\r\n`;
  const { f } = stub({
    [`/sent/${SENT}`]: { ...sentDto(INBOX), body: FIRST_LINE, attachments: [] },
    [`/sent/${SENT}/html`]: FIRST_LINE,
    [`/sent/${SENT}/raw/json`]: { content: raw },
  });
  const d = await getSentMail(f, "KEY", INBOX, SENT);
  assert.equal(d.body, BRIEF);
  assert.equal(d.raw, raw);
  assert.deepEqual(d.sources, [
    { name: "record", status: 200, length: FIRST_LINE.length },
    { name: "html", status: 200, length: FIRST_LINE.length },
    { name: "raw", status: 404, length: 0, decoded: 0 },
    { name: "raw/json", status: 200, length: raw.length, decoded: BRIEF.length },
  ]);

  // A network failure is reported, not swallowed.
  const down = async (url, init) =>
    String(url).endsWith("/html") ? Promise.reject(new Error("socket hang up")) : f(url, init);
  const e = await getSentMail(down, "KEY", INBOX, SENT);
  assert.deepEqual(e.sources[1], { name: "html", status: 0, length: 0, error: "socket hang up" });
});
