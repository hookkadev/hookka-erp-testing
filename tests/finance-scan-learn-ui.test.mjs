// ---------------------------------------------------------------------------
// finance-scan-learn-ui.test.mjs — finance plan batch 3 (owner 2026-10-01),
// the wiring around src/lib/scan-account-learn.ts:
//   · the finance scan endpoint returns EVERY bill in the file (one PDF can
//     bundle several), the first one still at the top level;
//   · the scan memory reads finance documents only — approved / posted
//     vouchers and active other-creditor bills to learn from, plus the bill
//     numbers already on the books — and writes nothing anywhere;
//   · the Payment Vouchers page has ONE Scan (owner 2026-10-01): every receipt
//     starts as its own voucher, ticked ones Merge into one voucher, Create
//     makes draft vouchers dated today with their receipts — no other-creditor
//     bills here (they are scanned on their own page, paid via AP Payment);
//   · the voucher form takes several receipts into one voucher, SST as its own
//     line; the creditor-bill form never counts the SST twice.
// The shared OCR engine and the party-alias memory are not touched.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const ui = read("src/pages/accounting/index.tsx");
const ep = read("src/api/routes/scan-finance.ts");
const slice = (src, from, to) => { const a = src.indexOf(from); assert.notEqual(a, -1, from); const b = src.indexOf(to, a + 1); assert.notEqual(b, -1, to); return src.slice(a, b); };

test("the endpoint returns every bill in the file; the first stays at the top level", () => {
  assert.match(ep, /const shaped = docs\.map\(shapeDoc\);/);
  assert.match(ep, /\.\.\.\(shaped\[0\] \?\? shapeDoc\(\{\}\)\),\n\s+extraDocs: docs\.length > 1 \? docs\.length - 1 : 0,\n\s+docs: shaped,/);
  assert.match(ep, /runExtract\(c\.var\.DB, c\.env, \{\n\s+kind: "supplier",/, "same shared engine call, unchanged");
});

test("scan memory: finance documents only, read-only, dropped after a save", () => {
  const mem = slice(ui, "function loadScanMemory(): Promise<ScanMemory> {", "function knownRefLabel(");
  assert.match(mem, /get<PvRow>\("\/api\/accounting\/payment-vouchers"\)/);
  assert.match(mem, /get<OtherPartyBill>\("\/api\/accounting\/other-party-bills\?type=CREDITOR"\)/);
  assert.match(mem, /"\/api\/purchase-invoices"\)/, "a PI keyed from the same supplier bill counts as recorded");
  // Learn only from what was approved: posted + APPROVED vouchers (not AP / transfer), active bills.
  assert.match(mem, /const approved = r\.status === "POSTED" && \(\(r\.approvalState \?\? r\.approval_state\) \?\? "APPROVED"\) === "APPROVED";/);
  assert.match(mem, /if \(approved && r\.pvKind !== "AP" && r\.pvKind !== "TRANSFER"\)/);
  assert.match(mem, /if \(\(b\.lifecycleState \?\? "ACTIVE"\) !== "ACTIVE" \|\| b\.status === "CANCELLED"\) continue;/);
  assert.doesNotMatch(mem, /method: "(POST|PUT|DELETE)"|teachPartyAlias/, "reads only — no shared memory written");
  assert.equal((ui.match(/forgetScanMemory\(\);/g) ?? []).length, 3, "dropped after a voucher save, a bill save and a batch");
});

test("one Scan: every receipt its own voucher, merge several into one, create drafts — vouchers only", () => {
  const b = slice(ui, "function ScanVouchers({ accounts, bankCash, onDone, onOpenInForm }", "// Party match for scan prefill.");
  assert.match(b, /const docs: ScanFinanceDoc\[\] = j\.data\.docs\?\.length \? j\.data\.docs : \[j\.data\];/, "every receipt in the PDF");
  assert.match(b, /found\.push\(\{ key: `v\$\{run\}:\$\{i\}:\$\{k\}`, docs: \[doc\], ticked: !dup,/, "each receipt starts as its own voucher; a recorded one starts unticked");
  assert.match(b, /\?\? findDuplicate\(\[\.\.\.already, \.\.\.found\.flatMap\(\(v\) => v\.docs\)\]\.map/, "the same receipt twice in one scan is caught too");
  assert.match(b, /const mergeTicked = \(\) => \{/);
  assert.match(b, /docs: picked\.flatMap\(\(v\) => v\.docs\), ticked: true,/, "merged = one voucher holding every ticked receipt");
  assert.match(b, /const split = \(v: ScanVoucher\)/, "a merged voucher splits back");
  assert.match(b, /lines: v\.docs\.flatMap\(\(d\) => d\.lines\.map/, "one voucher, every receipt's lines");
  assert.match(b, /billNo: v\.docs\.map\(\(d\) => d\.billNo\)\.filter\(Boolean\)\.join\(", "\)/);
  assert.match(b, /for \(const f of \[\.\.\.new Set\(v\.docs\.map\(\(d\) => d\.file\)\)\]\) \{\n\s+try \{ await uploadPvAttachment\(j\.data\.id, f\); \}/, "every receipt attached, a shared PDF once");
  assert.match(b, /saveAs: "draft",/, "vouchers go onto the approval ladder");
  assert.match(b, /voucherDate: new Date\(\)\.toISOString\(\)\.slice\(0, 10\), state: "ready" \}\);/, "dated today");
  assert.match(b, /if \(l\.isTax\) return \{ description: l\.description, amountSen: l\.amountSen, accountCode: "706-0000", guess: null, isTax: true \};/);
  assert.doesNotMatch(b, /other-party-bills|"OCB"|other-parties/, "no other-creditor bills from this page");
  assert.match(b, /onOpenInForm\(\{ payee: v\.payee, date: v\.voucherDate, docs: v\.docs \}\)/, "the last voucher can go into the full form");
});

test("guesses say where they came from; a new payee's are marked suggested", () => {
  const h = slice(ui, "function scanGuessHint(", "// Scan — the Payment Vouchers page's ONE OCR");
  assert.match(h, /if \(g\.source === "suggested"\) return \{ kind: "suggested", text: `Suggested — like \$\{g\.basis\}` \};/);
  assert.match(ui, /\{l\.hint && <div className=\{`text-\[10px\] mt-0\.5 \$\{l\.hint\.kind === "suggested" \? "text-\[#7A5B12\] font-semibold" : "text-\[#9CA3AF\]"\}`\}>\{l\.hint\.text\}<\/div>\}/);
});

test("voucher form: several receipts, one voucher; SST its own line; a known bill no. is said", () => {
  const tab = slice(ui, "function PaymentsTab(", "// =============== TAB: OFFICIAL RECEIPT");
  const scan = slice(tab, "const applyScan = async (d: ScanFinanceResult, file: File) => {", "return (\n");
  assert.match(scan, /const adding = showForm && formKind === "EXPENSE" && !editingId && form\.mode === "PAYMENT" && filled\.length > 0;/);
  assert.match(scan, /setLines\(\[\.\.\.filled, \.\.\.scanned\]\);/);
  assert.match(scan, /billNo: \[f\.billNo\.trim\(\), \.\.\.docNos\]\.filter\(Boolean\)\.join\(", "\)/);
  assert.match(scan, /is already on this voucher — not added again\./);
  assert.match(scan, /if \(l\.isTax\) return \{ accountCode: "706-0000",/);
  assert.match(tab, /<ScanVouchers accounts=\{accounts\} bankCash=\{bankCash\} onDone=\{load\} onOpenInForm=\{openScanInForm\} \/>/, "ONE Scan on the page");
  assert.doesNotMatch(tab, /label="Scan Receipt"|<ScanBillsBatch/, "the two old buttons are gone");
  assert.match(tab, /setPendingScanFiles\(\[\.\.\.new Set\(v\.docs\.map\(\(d\) => d\.file\)\)\]\);/, "open in form keeps the receipts to attach");
  assert.match(tab, /const billDups = !isTransfer && scanMemory\n\s+\? form\.billNo\.split\(\/\[,;\]\/\)/);
  assert.match(ui, /if \(!allDocs && j\.data\.extraDocs > 0\) \{/, "the 'only the first was used' warning stays for single-bill forms");
});

test("creditor-bill form: accounts learned per line; the SST is never counted twice", () => {
  const mgr = slice(ui, "function OtherPartyBillsManager(", "\n  return (\n");
  assert.match(mgr, /const memory = side === "CREDITOR" \? await loadScanMemory\(\) : null;/, "a debtor bill keeps the party's last account");
  assert.match(mgr, /const withTax = linesWithTax\(d\.lines, d\.taxSen, d\.totalSen\);/);
  assert.match(mgr, /taxStr: taxSen \? \(taxSen \/ 100\)\.toFixed\(2\) : "",/);
  assert.match(mgr, /scanNameMatch\(allSideParties, d\.partyName, partyAliases\)/, "party match unchanged (taught aliases first)");
});
