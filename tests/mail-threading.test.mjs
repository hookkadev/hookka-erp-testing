// ---------------------------------------------------------------------------
// mail-threading.test.mjs — PRD T-012 R1-R4: recipients + RFC threading.
//
// Pins the pure rules both the API and the reply box share:
//   - address lists parse from strings / arrays / "Name <addr>" and dedupe
//   - a reply goes to the NEWEST correspondent, not the thread's first
//   - reply-all copies everyone on that message but never ourselves
//   - a follow-up on a thread WE started goes back to the people we wrote to
//   - threading headers carry Message-ID / In-Reply-To / References, and the
//     References chain is the parent's chain plus the parent, capped
// Pure helper — no DB, no network, no React.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on newer Node.
}

const mod = await import("../src/api/lib/mail-threading.ts");
const {
  parseAddressList,
  bareAddress,
  invalidAddresses,
  without,
  newMessageId,
  normalizeMessageId,
  referencesChain,
  buildThreadingHeaders,
  replyBaseMessage,
  replyRecipients,
} = mod;

test("parseAddressList: string, array, display names, dedupe, lowercase", () => {
  assert.deepEqual(parseAddressList("a@x.com"), ["a@x.com"]);
  assert.deepEqual(
    parseAddressList("A@x.com, Bob <b@y.com>; c@z.com\n a@x.com"),
    ["a@x.com", "b@y.com", "c@z.com"],
  );
  assert.deepEqual(parseAddressList(["a@x.com", "b@y.com, c@z.com"]), [
    "a@x.com",
    "b@y.com",
    "c@z.com",
  ]);
  assert.deepEqual(parseAddressList(undefined), []);
  assert.deepEqual(parseAddressList(""), []);
});

test("bareAddress strips a display name", () => {
  assert.equal(bareAddress("Lim <lim@hookka.com>"), "lim@hookka.com");
  assert.equal(bareAddress("  lim@hookka.com "), "lim@hookka.com");
  assert.equal(bareAddress(""), "");
});

test("invalidAddresses flags the garbage only", () => {
  assert.deepEqual(invalidAddresses(["a@x.com", "nope", "b@y"]), ["nope", "b@y"]);
});

test("without is case-insensitive", () => {
  assert.deepEqual(without(["a@x.com", "B@y.com"], ["b@Y.com"]), ["a@x.com"]);
});

test("Message-ID helpers", () => {
  const id = newMessageId();
  assert.match(id, /^<[0-9a-f-]{36}@hookka\.com>$/);
  assert.equal(normalizeMessageId("abc@x"), "<abc@x>");
  assert.equal(normalizeMessageId("<abc@x>"), "<abc@x>");
  assert.equal(normalizeMessageId(""), "");
  assert.equal(normalizeMessageId(null), "");
});

test("referencesChain = parent's chain + parent, deduped, capped at 30", () => {
  assert.deepEqual(referencesChain("<a@x> <b@x>", "<c@x>"), [
    "<a@x>",
    "<b@x>",
    "<c@x>",
  ]);
  assert.deepEqual(referencesChain(["<a@x>", "a@x"], "<a@x>"), ["<a@x>"]);
  assert.deepEqual(referencesChain(null, null), []);
  const long = Array.from({ length: 40 }, (_, i) => `<${i}@x>`);
  const chain = referencesChain(long, "<new@x>");
  assert.equal(chain.length, 30);
  assert.equal(chain[chain.length - 1], "<new@x>");
});

test("buildThreadingHeaders omits In-Reply-To / References on a fresh mail", () => {
  assert.deepEqual(buildThreadingHeaders({ messageId: "<m@x>" }), {
    "Message-ID": "<m@x>",
  });
  assert.deepEqual(
    buildThreadingHeaders({
      messageId: "m@x",
      inReplyTo: "p@x",
      references: ["<a@x>", "p@x"],
    }),
    {
      "Message-ID": "<m@x>",
      "In-Reply-To": "<p@x>",
      References: "<a@x> <p@x>",
    },
  );
});

// A conversation: the customer wrote in, we replied, then a COLLEAGUE of the
// customer took over (R3: "even after the correspondent changes").
const OUR = ["support@hookka.com"];
const HISTORY = [
  {
    direction: "inbound",
    fromAddress: "first@customer.com",
    toAddresses: ["support@hookka.com"],
    ccAddresses: [],
    messageId: "<c1@customer.com>",
    referenceIds: null,
    createdAt: "2026-09-01T00:00:00.000Z",
  },
  {
    direction: "outbound",
    fromAddress: "support@hookka.com",
    toAddresses: ["first@customer.com"],
    ccAddresses: [],
    messageId: "<h1@hookka.com>",
    referenceIds: "<c1@customer.com>",
    createdAt: "2026-09-02T00:00:00.000Z",
  },
  {
    direction: "inbound",
    fromAddress: "second@customer.com",
    toAddresses: ["support@hookka.com", "Boss <boss@customer.com>"],
    ccAddresses: ["first@customer.com", "cc@partner.com"],
    messageId: "<c2@customer.com>",
    referenceIds: "<c1@customer.com> <h1@hookka.com>",
    createdAt: "2026-09-03T00:00:00.000Z",
  },
];

test("reply goes to the newest correspondent, not the first (R3)", () => {
  const r = replyRecipients(HISTORY, "reply", OUR);
  assert.deepEqual(r.to, ["second@customer.com"]);
  assert.deepEqual(r.cc, []);
  assert.equal(r.base.messageId, "<c2@customer.com>");
});

test("reply-all copies everyone on that message except ourselves (R2)", () => {
  const r = replyRecipients(HISTORY, "reply_all", OUR);
  assert.deepEqual(r.to, ["second@customer.com"]);
  assert.deepEqual(r.cc, ["boss@customer.com", "first@customer.com", "cc@partner.com"]);
});

test("the base message is the newest INBOUND regardless of array order", () => {
  const shuffled = [HISTORY[2], HISTORY[0], HISTORY[1]];
  assert.equal(replyBaseMessage(shuffled).messageId, "<c2@customer.com>");
});

test("a follow-up on a thread we started goes back to the people we wrote to", () => {
  const ours = [
    {
      direction: "outbound",
      fromAddress: "lim@hookka.com",
      toAddresses: ["a@customer.com", "b@customer.com"],
      ccAddresses: ["c@customer.com"],
      messageId: "<h9@hookka.com>",
      referenceIds: null,
      createdAt: "2026-09-05T00:00:00.000Z",
    },
  ];
  const reply = replyRecipients(ours, "reply", ["lim@hookka.com"]);
  assert.deepEqual(reply.to, ["a@customer.com", "b@customer.com"]);
  assert.deepEqual(reply.cc, []);
  const all = replyRecipients(ours, "reply_all", ["lim@hookka.com"]);
  assert.deepEqual(all.cc, ["c@customer.com"]);
});

test("an empty thread yields no recipients (caller 400s)", () => {
  assert.deepEqual(replyRecipients([], "reply", OUR), { to: [], cc: [], base: null });
});
