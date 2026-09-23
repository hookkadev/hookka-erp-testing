// ---------------------------------------------------------------------------
// doc-detail-dblclick.test.mjs — owner 2026-09-22 「其他的类似 payment voucher,
// receipt 这些都要双击点开」: every finance document list opens its record on
// double-click; single click keeps doing what it did (select / expand).
// One modal shell (DocDetailModal) for vouchers, receipts, transfers.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const ui = readFileSync("src/pages/accounting/index.tsx", "utf8").replace(/\r\n/g, "\n");
const block = (from, to) => { const a = ui.indexOf(from); assert.notEqual(a, -1, from); const b = ui.indexOf(to, a + 1); return ui.slice(a, b === -1 ? undefined : b); };

test("one shell for every document popup", () => {
  assert.match(ui, /function DocDetailModal\(\{ title, badges, onClose, children, actions, wide \}/);
  assert.match(ui, /function DetailField\(\{ label, children, span \}/);
  assert.ok((ui.match(/<DocDetailModal/g) ?? []).length >= 3, "PV, receipts and fund transfer all use the shell");
});

test("Payment Vouchers: double-click opens the popup, single click still expands", () => {
  const pv = block("function PaymentsTab(", "// =============== TAB: OFFICIAL RECEIPT");
  assert.match(pv, /onClick=\{\(\) => setExpandedPv\(\(m\) => \(\{ \.\.\.m, \[r\.id\]: !m\[r\.id\] \}\)\)\}\s*\n\s*onDoubleClick=\{\(\) => setDetailPvId\(r\.id\)\}/);
  assert.match(pv, /const r = \(rows \?\? \[\]\)\.find\(\(x\) => x\.id === detailPvId\);/, "resolved from rows so it refreshes after actions");
  // The popup carries the ladder trail, the lines / bills and the attachments block.
  assert.match(pv, /Ladder trail — who did what, when\./);
  assert.match(pv, /<PvAttachmentsBlock pv=\{r\} onChanged=\{load\} \/>\s*\n\s*<\/DocDetailModal>/);
  // Actions inside mirror the row: same handlers, same gates.
  for (const rung of ['"prepare"', '"withdraw"', '"reject"', '"check"', '"approve"']) assert.match(pv, new RegExp(`onClick=\\{\\(\\) => void handleLadder\\(r, ${rung}\\)\\}>`));
  assert.match(pv, /onClick=\{\(\) => \{ close\(\); void handleLifecycle\(r\.id, r\.pvNo, "void"\); \}\}/);
});

test("Receipts hub: double-click opens the popup; the inline expand and the popup share one table", () => {
  const hub = block("function ReceiptsHubTab(", "// =============== TAB: FUND TRANSFER");
  assert.match(hub, /onDoubleClick=\{\(\) => setDetailKey\(r\.key\)\}/);
  assert.match(hub, /const detailTable = \(r: ReceiptHubRow\) => \(/);
  assert.equal((hub.match(/\{detailTable\(r\)\}/g) ?? []).length, 2, "inline expand + popup both render detailTable");
  assert.match(hub, /const r = rows\.find\(\(x\) => x\.key === detailKey\);/);
});

test("Fund Transfer, Other Party Bills / Payments, AP Invoices open on double-click too", () => {
  const ft = block("function FundTransferTab(", "// =============== TAB: STOCK SUMMARY");
  assert.match(ft, /onDoubleClick=\{\(\) => setDetailFt\(r\.no\)\}/);
  assert.match(ft, /title=\{`Fund Transfer \$\{r\.no\}`\}/);
  const bills = block("function OtherPartyBillsManager(", "function OtherPartyPaymentForm(");
  assert.match(bills, /onDoubleClick=\{\(\) => setOpenBill\(openBill === b\.id \? null : b\.id\)\}/);
  const pays = block("function OtherPartyPaymentsManager(", "// =============== TAB: GENERAL LEDGER");
  assert.match(pays, /onDoubleClick=\{\(\) => setDetail\(g\)\}/);
  const ap = block("function ApInvoicesTab(", "function DocDetailModal(");
  assert.match(ap, /onDoubleClick=\{\(\) => \{ if \(r\.kind === "PI"\) navigate\("\/procurement\/pi"\); else setManage\(true\); \}\}/);
  // The checkbox cell never lets a double-click on it open the record.
  assert.match(ft, /<td className="px-3 py-1\.5 w-8" onDoubleClick=\{\(e\) => e\.stopPropagation\(\)\}>/);
  assert.match(bills, /<td className="px-3 py-1\.5 w-8" onDoubleClick=\{\(e\) => e\.stopPropagation\(\)\}>/);
});
