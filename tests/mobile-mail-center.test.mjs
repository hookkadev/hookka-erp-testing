// ---------------------------------------------------------------------------
// mobile-mail-center.test.mjs — PRD T-012 R16: the phone Mail Center can
// compose (with Cc), reply and forward, and "Sign receipt" confirms an
// acknowledgement when one was asked of the reader.
//
// Source-shape tests: the mobile screen and the form builders are React /
// fetch code, so what is pinned is that each action reaches the REAL
// endpoint rather than the old stand-in (Reply used to open Compose).
// ---------------------------------------------------------------------------
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const screen = readFileSync(
  new URL("../src/pages/m/screens/MailCenterScreen.tsx", import.meta.url),
  "utf8",
);
const forms = readFileSync(
  new URL("../src/pages/m/config/forms.ts", import.meta.url),
  "utf8",
);

function builder(name) {
  const start = forms.indexOf(`export function ${name}(`);
  assert.notEqual(start, -1, `no builder ${name}`);
  const next = forms.indexOf("\nexport function ", start + 1);
  return forms.slice(start, next === -1 ? forms.length : next);
}

test("reply posts to the thread's reply endpoint with a mode", () => {
  const b = builder("replyMailSpec");
  assert.match(b, /\/api\/mail-center\/threads\/\$\{encodeURIComponent\(threadId\)\}\/reply/);
  assert.match(b, /mode: s\(v\.mode\) === "reply_all" \? "reply_all" : "reply"/);
  // The thread screen's Reply button opens THIS builder, not Compose.
  assert.match(screen, /replyMailSpec\(id, str\(thread, "counterpartyName", "counterpartyEmail"\)\)/);
});

test("forward composes with the conversation quoted and forwardOf set", () => {
  const b = builder("forwardMailSpec");
  assert.match(b, /\/api\/mail-center\/compose/);
  assert.match(b, /forwardOf: args\.threadId/);
  assert.match(b, /Fwd: /);
  assert.match(screen, /forwardMailSpec\(\{/);
  assert.match(screen, /Forwarded message/);
});

test("compose carries a Cc list", () => {
  const b = builder("newMailSpec");
  assert.match(b, /name: "cc"/);
  assert.match(b, /cc: s\(v\.cc\)\.trim\(\)/);
});

test("Sign receipt acknowledges when an acknowledgement is pending for me", () => {
  assert.match(screen, /\/messages\/\$\{encodeURIComponent\(pendingAckMessageId\)\}\/acknowledge/);
  // Without a pending request the old archive behaviour stays.
  assert.match(screen, /body: JSON\.stringify\(\{ status: "closed", unread: false \}\)/);
});
