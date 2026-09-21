// ---------------------------------------------------------------------------
// email-outbox-attachments.test.mjs — PRD T-012 R14: outbound attachments
// are files in Storage, not base64 text in the outbox row.
//
//   - parseStoredAttachments reads BOTH shapes (Storage ref / legacy inline)
//   - a ref with no path, or an inline entry with no bytes, is dropped
//   - enqueue uploads through storeOutboxAttachments; the drain resolves the
//     refs back to bytes at send time; the Auto-sent download serves both
//   - without Storage credentials, enqueue keeps the inline shape (dev)
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

const mod = await import("../src/api/lib/email-outbox.ts");
const { parseStoredAttachments, isStoredRef, storeOutboxAttachments } = mod;

test("parseStoredAttachments: Storage refs and legacy inline rows both parse", () => {
  const raw = JSON.stringify([
    { filename: "DO-1.pdf", storagePath: "outbox/oe-1/1-DO-1.pdf", contentType: "application/pdf", sizeBytes: 1234 },
    { filename: "old.pdf", contentBase64: "JVBERi0=" },
    { filename: "empty.pdf" },
    { storagePath: "outbox/oe-1/x" },
    null,
  ]);
  const list = parseStoredAttachments(raw);
  assert.equal(list.length, 2);
  assert.ok(isStoredRef(list[0]));
  assert.equal(list[0].storagePath, "outbox/oe-1/1-DO-1.pdf");
  assert.equal(list[0].sizeBytes, 1234);
  assert.ok(!isStoredRef(list[1]));
  assert.equal(list[1].contentBase64, "JVBERi0=");
});

test("parseStoredAttachments degrades to undefined on junk", () => {
  assert.equal(parseStoredAttachments(null), undefined);
  assert.equal(parseStoredAttachments("not json"), undefined);
  assert.equal(parseStoredAttachments("{}"), undefined);
  assert.equal(parseStoredAttachments("[]"), undefined);
});

test("storeOutboxAttachments keeps the inline shape when Storage is not configured", async () => {
  const inline = [{ filename: "a.pdf", contentBase64: "JVBERi0=" }];
  const out = await storeOutboxAttachments({}, "oe-test", inline);
  assert.deepEqual(out, inline);
});

const outbox = readFileSync(
  new URL("../src/api/lib/email-outbox.ts", import.meta.url),
  "utf8",
);
const route = readFileSync(
  new URL("../src/api/routes/mail-center.ts", import.meta.url),
  "utf8",
);

function fn(src, name) {
  const start = src.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `no function ${name}`);
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next === -1 ? src.length : next);
}

test("enqueue uploads to Storage and stores only the index", () => {
  const h = fn(outbox, "enqueueEmail");
  assert.match(h, /storeOutboxAttachments\(/);
  assert.match(h, /attachments \? JSON\.stringify\(attachments\) : null/);
});

test("the drain resolves Storage refs back to bytes at send time", () => {
  const h = fn(outbox, "processOutbox");
  assert.match(h, /await resolveStoredAttachments\(/);
  assert.doesNotMatch(h, /attachments: parseStoredAttachments\(/);
});

test("the Auto-sent download serves a Storage ref or a legacy inline row", () => {
  const start = route.indexOf('app.get("/outbox/:id/attachments/:idx/download"');
  const h = route.slice(start, route.indexOf("\napp.", start + 1));
  assert.match(h, /if \(att\?\.storagePath\) \{/);
  assert.match(h, /loadStoredAttachmentBytes\(/);
  assert.match(h, /att\?\.contentBase64/);
});
