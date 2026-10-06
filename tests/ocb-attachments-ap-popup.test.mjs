// ---------------------------------------------------------------------------
// ocb-attachments-ap-popup.test.mjs — owner 2026-10-01:
//   · 「OCB 附件要做」: other-party bills take attachments — the same file store
//     and the same one upload / one delete path as the payment vouchers; a
//     voided bill takes no new file; once money is paid against a bill its
//     files are locked; the scanned bill (Scan Bill) and any file
//     picked in the form go onto the new bill when it is saved; the bill's
//     views show the files and print the bill with them;
//   · 「new ap payment 的页面还是这样」: New AP Payment is the same popup as the
//     voucher form (HEADER, then the bills to pay), fields and rules unchanged.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const acc = read("src/api/routes/accounting.ts");
const ui = read("src/pages/accounting/index.tsx");
const slice = (src, from, to) => { const a = src.indexOf(from); assert.notEqual(a, -1, from); const b = src.indexOf(to, a + 1); assert.notEqual(b, -1, to); return src.slice(a, b); };
const handler = (route) => { const a = acc.indexOf(route); assert.notEqual(a, -1, route); const b = acc.indexOf("\napp.", a + 1); return acc.slice(a, b === -1 ? undefined : b); };

test("bill attachment routes: the shared store; void takes nothing; paid locks deletes; a delete names a file of THIS bill", () => {
  assert.match(acc, /const OCB_ATTACH_RESOURCE = "other_party_bill";/);
  const get = handler('app.get("/other-party-bills/:billNo/attachments", async (c) => {');
  assert.match(get, /requirePermission\(c, "accounting", "read"\)/);
  assert.match(get, /canAdd: bill\.active,\n\s+canDelete: bill\.active && bill\.paidAmountSen === 0,/);
  const post = handler('app.post("/other-party-bills/:billNo/attachments", async (c) => {');
  assert.match(post, /if \(!bill\.active\) return c\.json\(\{ success: false, error: "A voided bill takes no attachments" \}, 400\);/);
  assert.match(post, /await storeUploadedFile\(c, \{ file, resourceType: OCB_ATTACH_RESOURCE, resourceId: bill\.id \}\)/);
  const del = handler('app.delete("/other-party-bills/:billNo/attachments/:fileId", async (c) => {');
  assert.match(del, /if \(bill\.paidAmountSen !== 0\) \{/);
  assert.match(del, /WHERE id = \? AND orgId = \? AND resourceType = \? AND resourceId = \?/);
  assert.match(del, /await removeStoredFile\(c, fileId\)/);
  // The bills list carries the paperclip count.
  const list = handler('app.get("/other-party-bills", async (c) => {');
  assert.match(list, /attachmentCount: attachCountById\.get\(b\.id\) \?\? 0,/);
});

test("the bill's views show its files and print the bill with them", () => {
  assert.match(ui, /function BillAttachmentsBlock\(\{ bill, onChanged \}/);
  assert.match(ui, /function DocAttachmentsBlock\(\{ base, docNo, voided, lockedNote, onChanged \}/);
  assert.match(ui, /<DocAttachmentsBlock\n\s+base=\{pvAttachBase\(pv\.id\)\}/, "the voucher's block is the same component");
  const ap = slice(ui, "function ApInvoicesTab(", "function DocDetailModal(");
  assert.match(ap, /<BillAttachmentsBlock bill=\{b\} onChanged=\{\(\) => setVer\(\(v\) => v \+ 1\)\} \/>/);
  assert.match(ap, /Print \+ files<\/Button>/);
  const mgr = slice(ui, "function OtherPartyBillsManager(", "\ntype OpenBill = ");
  assert.match(mgr, /<BillAttachmentsBlock bill=\{b\} onChanged=\{load\} \/>/);
  // (2026-10-02: the list row's actions moved to its right-click menu.)
  assert.match(mgr, /\{ label: "Print \+ files", action: \(\) => void printBillWithFiles\(b, accounts\)/);
  assert.match(ui, /printVoucher\(\{ \.\.\.buildOtherPartyBillVoucher\(b, accounts\), appendix \}\);/);
});

test("a new bill takes its files: the scan and files picked in the form", () => {
  const mgr = slice(ui, "function OtherPartyBillsManager(", "\ntype OpenBill = ");
  assert.match(mgr, /const applyScan = async \(d: ScanFinanceResult, file: File\) => \{/);
  assert.match(mgr, /setPendingBillFiles\(\[file\]\);/);
  assert.match(mgr, /const newBillNo = !editingBillNo \? rawRes\?\.data\?\.billNo : undefined;/, "only a NEW bill — an edit keeps its own files");
  assert.match(mgr, /await uploadBillAttachment\(newBillNo, f\);/);
  assert.match(mgr, /📎 Attach files/);
});

test("New AP Payment is a popup like the voucher form; fields and rules unchanged", () => {
  const ap = slice(ui, '{showForm && formKind === "AP" && (() => {', '{showForm && formKind === "EXPENSE" && (() => {');
  assert.match(ap, /<div className="fixed inset-0 z-40 bg-black\/40 overflow-y-auto p-4" role="dialog" aria-modal="true">/);
  assert.match(ap, /: "New AP payment"\}/);
  assert.match(ap, /<div className=\{sectionHead\}><span>Header<\/span><\/div>/);
  assert.match(ap, /<span>Bills to pay\{apBills\?\.partyName \?/);
  for (const label of ["PV #", "Payment date *", "Paid from (credit) *", "Reference / remarks"]) assert.ok(ap.includes(`>${label}</label>`), `field ${label}`);
  assert.match(ap, /const cannot = saving \|\| apTotalSen <= 0 \|\| !!apMoneyError \|\| !!apOverAlloc \|\| !apForm\.partyId/, "the same save rule");
  assert.match(ap, /onClick=\{\(\) => void handleSaveAp\("draft"\)\}/);
  assert.doesNotMatch(ap, /<Card>/, "no longer an inline card");
});
