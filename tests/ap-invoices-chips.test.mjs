// ---------------------------------------------------------------------------
// ap-invoices-chips.test.mjs — owner 2026-09-29 「AP invoice 那边的 purchase
// invoice 和 other creditor invoice 我希望是这样选，而不是往下滑」→「做」.
//
// The AP Invoices mirror used two dropdowns (kind, status) that had to be
// opened and scrolled. Now: kind and status are chip rows with a count on
// each, a searchable supplier picker narrows the list, and everything is one
// load filtered client-side (so the counts are real).
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const ui = readFileSync("src/pages/accounting/index.tsx", "utf8").replace(/\r\n/g, "\n");
const ap = ui.slice(ui.indexOf("function ApInvoicesTab("), ui.indexOf("function DocDetailModal("));

test("kind and status are chips, not dropdowns", () => {
  assert.match(ui, /const AP_KIND_CHIPS: \{ key: "ALL" \| "AP" \| "PI"; label: string \}\[\] = \[/);
  assert.match(ui, /\{ key: "AP", label: "AP invoices" \}, \{ key: "PI", label: "Purchase invoices" \}/);
  assert.match(ui, /const AP_STATUS_CHIPS: \{ key: "ALL" \| "OPEN" \| "PAID" \| "CANCELLED"; label: string \}\[\] = \[/);
  assert.doesNotMatch(ap, /<select value=\{kind\}/, "the kind dropdown is back");
  assert.doesNotMatch(ap, /<select value=\{status\}/, "the status dropdown is back");
  assert.match(ap, /AP_KIND_CHIPS\.map\(\(ch, i\) => \{/);
  assert.match(ap, /AP_STATUS_CHIPS\.map\(\(ch, i\) => \{/);
  // The default stays ALL (owner 2026-09-22) and the row type is untouched.
  assert.match(ap, /useState<"OPEN" \| "PAID" \| "CANCELLED" \| "ALL">\("ALL"\)/);
});

test("one load, client-side filters, real counts per chip, supplier picker", () => {
  assert.match(ap, /fetch\("\/api\/accounting\/ap-invoices"\)/, "no per-status round-trip any more");
  assert.match(ap, /\}, \[ver\]\);/);
  assert.match(ap, /const passes = \(r: ApInvRow, skip\?: "kind" \| "status"\) => \{/);
  assert.match(ap, /if \(supplier && r\.supplier !== supplier\) return false;/);
  // A chip's count reflects the OTHER filters (skip its own dimension).
  assert.match(ap, /const kindCount = \(k: typeof kind\) => all\.filter\(\(r\) => passes\(r, "kind"\) && \(k === "ALL" \|\| r\.kind === k\)\)\.length;/);
  assert.match(ap, /const statusCount = \(s: typeof status\) => all\.filter\(\(r\) => passes\(r, "status"\) && \(s === "ALL" \|\| r\.status === s\)\)\.length;/);
  assert.match(ap, /<SearchableSelect value=\{supplier\} onChange=\{setSupplier\} options=\{supplierOpts\} placeholder="All suppliers" allowClear \/>/);
  // Double-click: a PI opens its own page; an AP bill opens its detail popup (2026-09-29).
  assert.match(ap, /onDoubleClick=\{\(\) => \{ if \(r\.kind === "PI"\) navigate\(`\/procurement\/pi\/\$\{r\.id\}`\); else setDetailBillNo\(r\.no\); \}\}/);
  assert.match(ap, /<Link to=\{`\/procurement\/pi\/\$\{r\.id\}`\}/, "the No. link opens the invoice itself too");
  assert.doesNotMatch(ap, /navigate\("\/procurement\/pi"\)/, "the jump to the LIST is back");
});
