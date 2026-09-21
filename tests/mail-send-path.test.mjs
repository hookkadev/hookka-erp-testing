// Mail Center send path — PRD T-012 R1-R4 shape tests over the source.
//
// Pins the parts a future edit could quietly drop:
//   * both providers forward cc / bcc / reply-to / custom headers;
//   * compose and reply stamp Message-ID, and reply adds In-Reply-To +
//     References, so the customer's client threads our mail;
//   * the inbound resolver matches BOTH our Message-ID and the provider's
//     (Brevo rewrites the header), or every reply to a mail we sent would
//     open a new thread;
//   * a reply is addressed by replyRecipients (newest correspondent), never
//     by the thread's counterparty column;
//   * send / reply / forward write an audit row.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync(
  new URL("../src/api/routes/mail-center.ts", import.meta.url),
  "utf8",
);
const email = readFileSync(
  new URL("../src/api/lib/email.ts", import.meta.url),
  "utf8",
);

function handler(verb, path) {
  const start = route.indexOf(`app.${verb}("${path}"`);
  assert.notEqual(start, -1, `no handler for ${verb.toUpperCase()} ${path}`);
  const next = route.indexOf("\napp.", start + 1);
  return route.slice(start, next === -1 ? route.length : next);
}

function fn(src, name) {
  const start = src.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `no function ${name}`);
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next === -1 ? src.length : next);
}

test("SendEmailArgs carries several recipients plus cc / bcc / replyTo / headers", () => {
  assert.match(email, /to: string \| string\[\];/);
  for (const field of ["cc?: string[];", "bcc?: string[];", "replyTo?: string;", "headers?: Record<string, string>;"]) {
    assert.ok(email.includes(field), `SendEmailArgs missing ${field}`);
  }
});

test("Resend and Brevo both forward cc / bcc / reply-to / headers", () => {
  const resend = fn(email, "sendEmail");
  assert.match(resend, /\{ cc: args\.cc \}/);
  assert.match(resend, /\{ bcc: args\.bcc \}/);
  assert.match(resend, /reply_to: args\.replyTo/);
  assert.match(resend, /headers: args\.headers/);

  const brevo = fn(email, "sendEmailViaBrevo");
  assert.match(brevo, /cc: args\.cc\.map\(\(email\) => \(\{ email \}\)\)/);
  assert.match(brevo, /bcc: args\.bcc\.map\(\(email\) => \(\{ email \}\)\)/);
  assert.match(brevo, /replyTo: \{ email: args\.replyTo \}/);
  assert.match(brevo, /headers: args\.headers/);
});

test("compose stamps a Message-ID and stores it on the message row", () => {
  const h = handler("post", "/compose");
  assert.match(h, /const messageId = newMessageId\(\)/);
  assert.match(h, /buildThreadingHeaders\(\{ messageId \}\)/);
  assert.match(h, /headers,/);
  assert.match(h, /message_id, from_address/);
});

test("reply threads off the newest message: In-Reply-To + References", () => {
  const h = handler("post", "/threads/:id/reply");
  assert.match(h, /replyRecipients\(history, mode, ours\)/);
  assert.match(h, /referencesChain\(base\?\.referenceIds, base\?\.messageId\)/);
  assert.match(h, /buildThreadingHeaders\(\{ messageId, inReplyTo, references \}\)/);
  // The old rule — reply to the address the thread started with — is gone.
  assert.doesNotMatch(h, /const to = \(thread\.counterpartyEmail/);
});

test("compose and reply accept cc / bcc and persist all three lists", () => {
  for (const [verb, path] of [
    ["post", "/compose"],
    ["post", "/threads/:id/reply"],
  ]) {
    const h = handler(verb, path);
    assert.match(h, /parseAddressList\(body\.bcc\)/, `${path} bcc`);
    assert.match(h, /recipientsError\(to, cc, bcc\)/, `${path} validation`);
    assert.match(h, /bcc_addresses/, `${path} stores bcc`);
    assert.match(h, /JSON\.stringify\(cc\)/, `${path} stores cc`);
  }
});

test("the inbound resolver matches our Message-ID OR the provider's id", () => {
  const start = route.indexOf("export async function ingestInboundEmail(");
  const body = route.slice(start, route.indexOf("\n// ----", start + 1));
  assert.match(body, /message_id IN \(\$\{placeholders\}\)/);
  assert.match(body, /provider_message_id IN \(\$\{placeholders\}\)/);
});

test("an inbound reply moves the counterparty to whoever wrote last (R3)", () => {
  const start = route.indexOf("export async function ingestInboundEmail(");
  const body = route.slice(start, route.indexOf("\n// ----", start + 1));
  assert.match(body, /counterparty_email = \?,\s*counterparty_name = \?,/);
});

test("send, reply and forward are audited (R15)", () => {
  assert.match(handler("post", "/threads/:id/reply"), /action: "reply"/);
  assert.match(handler("post", "/compose"), /action: forwardOf \? "forward" : "send"/);
});
