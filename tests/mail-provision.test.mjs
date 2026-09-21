// ---------------------------------------------------------------------------
// mail-provision.test.mjs — PRD T-012 R5: personal mailbox at registration.
//
//   - derivePersonalAddress: company login email wins; else first.last from
//     the display name (accents folded); else the login's local part
//   - nthAddress: first.last2@ for the second person of the same name
//   - the three account entry points (create / invite / accept-invite) all
//     call into provisioning, best-effort, AFTER the account write
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

const mod = await import("../src/api/lib/mail-provision.ts");
const { derivePersonalAddress, nthAddress, inviteMarker } = mod;

test("a login already on the company domain is the mailbox", () => {
  assert.equal(
    derivePersonalAddress("Anything", "Lim@Hookka.com"),
    "lim@hookka.com",
  );
});

test("first.last from the display name, folded and lowercased", () => {
  assert.equal(
    derivePersonalAddress("Wei Siang", "ws@gmail.com"),
    "wei.siang@hookka.com",
  );
  assert.equal(
    derivePersonalAddress("Lim Wei Siang", "x@gmail.com"),
    "lim.wei.siang@hookka.com",
  );
  assert.equal(derivePersonalAddress("Violet", "v@gmail.com"), "violet@hookka.com");
  assert.equal(
    derivePersonalAddress("Zoë O'Brien", "z@gmail.com"),
    "zoe.obrien@hookka.com",
  );
});

test("falls back to the login's local part, then to nothing", () => {
  assert.equal(derivePersonalAddress("", "samuel.tan@gmail.com"), "samueltan@hookka.com");
  assert.equal(derivePersonalAddress("   ", ""), "");
  assert.equal(derivePersonalAddress(null, null), "");
});

test("nthAddress suffixes the local part", () => {
  assert.equal(nthAddress("wei.siang@hookka.com", 1), "wei.siang@hookka.com");
  assert.equal(nthAddress("wei.siang@hookka.com", 2), "wei.siang2@hookka.com");
});

test("inviteMarker is a stable lowercase tag", () => {
  assert.equal(inviteMarker(" Bob@Example.com "), "invite:bob@example.com");
});

const users = readFileSync(
  new URL("../src/api/routes/users.ts", import.meta.url),
  "utf8",
);
const auth = readFileSync(
  new URL("../src/api/routes/auth.ts", import.meta.url),
  "utf8",
);

function handler(src, verb, path) {
  const start = src.indexOf(`app.${verb}("${path}"`);
  assert.notEqual(start, -1, `no handler for ${verb.toUpperCase()} ${path}`);
  const next = src.indexOf("\napp.", start + 1);
  return src.slice(start, next === -1 ? src.length : next);
}

test("POST /api/users provisions the mailbox after the account exists", () => {
  const h = handler(users, "post", "/");
  const insertAt = h.indexOf("INSERT INTO users");
  const provisionAt = h.indexOf("provisionPersonalMailbox(");
  assert.ok(insertAt !== -1 && provisionAt > insertAt);
  // Best-effort: wrapped so a mailbox hiccup never fails account creation.
  assert.match(h.slice(provisionAt - 200, provisionAt), /try \{/);
});

test("POST /api/users/invite reserves the address at invite time", () => {
  const h = handler(users, "post", "/invite");
  assert.match(h, /preProvisionInviteMailbox\(/);
  assert.ok(h.indexOf("INSERT INTO user_invites") < h.indexOf("preProvisionInviteMailbox("));
});

test("accept-invite links the reserved mailbox to the new account", () => {
  const h = handler(auth, "post", "/accept-invite");
  const batchAt = h.indexOf("c.var.DB.batch(");
  const provisionAt = h.indexOf("provisionPersonalMailbox(");
  assert.ok(batchAt !== -1 && provisionAt > batchAt);
});
