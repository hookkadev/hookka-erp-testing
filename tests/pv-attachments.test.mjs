// ---------------------------------------------------------------------------
// pv-attachments.test.mjs — Payment Voucher attachments + print bundle
// (owner 2026-09-22, Houzs adoption: 「附件：Cancelled 的不收；Checked 之后不能
// 删（证据锁）」「Print：凭证 + 附件合成一份」「扫描页自动附在单据上」).
//
// Pins, source-scan style:
//   · the file store has ONE upload path and ONE delete path (storeUploadedFile
//     / removeStoredFile in files.ts) — the voucher routes reuse them, so the
//     MIME allowlist + magic-byte sniff can never be bypassed;
//   · a cancelled voucher takes no new file; delete is refused from CHECK on;
//     a delete must name a file that belongs to THAT voucher;
//   · Scan Bills attaches the scanned file to the draft it created; Scan
//     Receipt holds the file and attaches it on save;
//   · the print bundle refuses when any attachment cannot be rendered (no
//     silent holes), and the print window waits for the images to decode.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const acc = read("src/api/routes/accounting.ts");
const files = read("src/api/routes/files.ts");
const ui = read("src/pages/accounting/index.tsx");
const pv = read("src/lib/print-voucher.ts");

function handler(src, route) {
  const start = src.indexOf(route);
  assert.notEqual(start, -1, `route ${route} not found`);
  const end = src.indexOf("\napp.", start + 1);
  return src.slice(start, end === -1 ? undefined : end);
}

test("files.ts: one upload path, one delete path; the generic routes are thin wrappers", () => {
  assert.match(files, /export async function storeUploadedFile\(/);
  assert.match(files, /export async function removeStoredFile\(/);
  const post = handler(files, 'app.post("/", async (c) => {');
  assert.match(post, /await storeUploadedFile\(c, \{ file, resourceType, resourceId \}\)/);
  assert.doesNotMatch(post, /INSERT INTO file_assets/);
  const del = handler(files, 'app.delete("/:id", async (c) => {');
  assert.match(del, /await removeStoredFile\(c, c\.req\.param\("id"\)\)/);
  assert.doesNotMatch(del, /DELETE FROM file_assets/);
  // The validation lives in the shared path, not the wrapper.
  const store = files.slice(files.indexOf("export async function storeUploadedFile("), files.indexOf("export async function removeStoredFile("));
  assert.match(store, /ALLOWED_MIME\.has\(declaredType\)/);
  assert.match(store, /sniffMime\(head\)/);
  assert.match(store, /INSERT INTO file_assets/);
  // Exactly two INSERTs into file_assets in the whole API: none besides the shared path.
  const inserts = (files.match(/INSERT INTO file_assets/g) ?? []).length + (acc.match(/INSERT INTO file_assets/g) ?? []).length;
  assert.equal(inserts, 1, `expected the shared path to be the only file_assets INSERT, saw ${inserts}`);
});

test("voucher attachment routes: cancelled takes nothing, evidence locked from CHECK, delete scoped to the voucher", () => {
  const post = handler(acc, 'app.post("/payment-vouchers/:id/attachments", async (c) => {');
  assert.match(post, /if \(pv\.status === "VOID"\) return c\.json\(\{ success: false, error: "A cancelled voucher takes no attachments" \}, 400\);/);
  assert.match(post, /await storeUploadedFile\(c, \{ file, resourceType: PV_ATTACH_RESOURCE, resourceId: id \}\)/);
  const del = handler(acc, 'app.delete("/payment-vouchers/:id/attachments/:fileId", async (c) => {');
  assert.match(del, /if \(state !== "DRAFT" && state !== "PREPARED"\) \{/);
  assert.match(del, /Evidence is locked once a voucher is checked/);
  assert.match(del, /WHERE id = \? AND orgId = \? AND resourceType = \? AND resourceId = \?/, "delete must verify the file belongs to this voucher");
  assert.match(del, /await removeStoredFile\(c, fileId\)/);
  const get = handler(acc, 'app.get("/payment-vouchers/:id/attachments", async (c) => {');
  assert.match(get, /canAdd: pv\.status !== "VOID"/);
  assert.match(get, /canDelete: pv\.status !== "VOID" && \(state === "DRAFT" \|\| state === "PREPARED"\)/);
  assert.equal(acc.match(/PV_ATTACH_RESOURCE = "payment_voucher"/g)?.length, 1);
  // The list carries the count for the paperclip.
  const list = handler(acc, 'app.get("/payment-vouchers", async (c) => {');
  assert.match(list, /attachmentCount: attachCountById\.get\(id\) \?\? 0/);
});

test("scans become evidence: Scan Bills attaches to the draft it made, Scan Receipt attaches on save", () => {
  const batch = ui.slice(ui.indexOf("function ScanBillsBatch("), ui.indexOf("function PvAttachmentsBlock("));
  assert.match(batch, /await uploadPvAttachment\(j2\.data\.id, files\[i\]\)/);
  assert.match(batch, /attachment failed:/, "a failed upload is said, the voucher is kept");
  assert.match(ui, /onResult: \(d: ScanFinanceResult, file: File\) => void \| Promise<void>/);
  assert.match(ui, /setPendingScanFile\(file\);/);
  const save = ui.slice(ui.indexOf("const handleSave = async (mode"), ui.indexOf("const handleLadder = async"));
  assert.match(save, /if \(newId && pendingScanFile\) \{/);
  assert.match(save, /await uploadPvAttachment\(newId, pendingScanFile\)/);
  const reset = ui.slice(ui.indexOf("const resetForm = () => {"), ui.indexOf("const openNew = "));
  assert.match(reset, /setPendingScanFile\(null\);/, "Cancel drops the held scan");
});

test("print bundle: every attachment or nothing; the window waits for images", () => {
  const conv = ui.slice(ui.indexOf("async function attachmentToPages("), ui.indexOf("function PvAttachmentsBlock("));
  assert.match(conv, /throw new Error\(`\$\{a\.filename\}: could not be fetched/);
  assert.match(conv, /this image format cannot be printed here/);
  assert.match(conv, /cannot be printed`\);/);
  const bundle = ui.slice(ui.indexOf("const printPvBundle = async"), ui.indexOf("const handleSettle = async"));
  assert.match(bundle, /for \(const a of list\.rows\) appendix\.push\(\{ title: a\.filename, pages: await attachmentToPages\(a\) \}\);/);
  assert.match(bundle, /toast\.error\(`Bundle not printed — /);
  assert.match(pv, /appendix\?: \{ title: string; pages: string\[\] \}\[\];/);
  assert.match(pv, /function buildAppendixSheets\(/);
  assert.match(pv, /<\/div>\$\{buildAppendixSheets\(spec\)\}`;/, "appendix pages follow the voucher sheet");
  assert.match(pv, /const pending = imgs\.filter\(\(im\) => !im\.complete\);/);
  assert.match(pv, /w\.setTimeout\(go, 8000\);/);
});
