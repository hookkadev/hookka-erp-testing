// ---------------------------------------------------------------------------
// jv-detail-view.test.mjs — owner 2026-09-22 batch:
//   4. 「JV 无法 view detail … 双击点开」— the journal list opens a detail modal on
//      double-click (single click keeps selecting) and from ⋮ › View detail;
//      every line + DR/CR totals; the actions mirror the ⋮ menu.
//   1. AP Invoices defaults to ALL.
//   2. A voided voucher no longer shows its old reject reason.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const ui = readFileSync("src/pages/accounting/index.tsx", "utf8").replace(/\r\n/g, "\n");
const jv = ui.slice(ui.indexOf("function JournalsTab("), ui.indexOf("function JournalEntryForm("));

test("journal detail opens on double-click and from the menu, never on single click", () => {
  assert.match(jv, /onDoubleClick=\{\(row\) => setDetailJv\(row\)\}/);
  assert.doesNotMatch(jv, /onRowClick=/, "single click stays 'select' for the batch bar");
  assert.match(jv, /\{ label: "View detail", action: \(r\) => setDetailJv\(r\) \}/);
  // BUG-2026-08-13-090 stays honoured: no no-op menu items.
  assert.doesNotMatch(jv, /label: "View", action: \(\) => \{\}/);
});

test("the detail shows every line with DR / CR totals and flags an unbalanced entry", () => {
  assert.match(jv, /\{je\.lines\.map\(\(l, i\) => \(/);
  assert.match(jv, /const dr = je\.lines\.reduce\(\(s, l\) => s \+ l\.debitSen, 0\);/);
  assert.match(jv, /const cr = je\.lines\.reduce\(\(s, l\) => s \+ l\.creditSen, 0\);/);
  assert.match(jv, /not balanced — DR \{formatCurrency\(dr\)\} vs CR \{formatCurrency\(cr\)\}/);
  // Actions mirror the ⋮ menu, gated the same way.
  assert.match(jv, /je\.status === "DRAFT" && \(/);
  assert.match(jv, /je\.status !== "DRAFT" && state === "ACTIVE" && \(/);
  assert.match(jv, /je\.status !== "DRAFT" && state === "VOID" && \(/);
});

test("AP Invoices opens on ALL; a voided voucher hides its stale reject reason", () => {
  const ap = ui.slice(ui.indexOf("function ApInvoicesTab("), ui.indexOf("function FoldSection("));
  assert.match(ap, /useState<"OPEN" \| "PAID" \| "CANCELLED" \| "ALL">\("ALL"\)/);
  assert.match(ui, /\(r\.rejectReason \?\? r\.reject_reason\) && apState\(r\) === "DRAFT" && r\.status !== "VOID" && \(/);
});
