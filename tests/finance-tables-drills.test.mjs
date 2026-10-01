// ---------------------------------------------------------------------------
// finance-tables-drills.test.mjs — finance plan batch 4 (owner 2026-10-01):
//   · finance tables never wrap; a column's header edge drags — only that
//     column changes, the rest move with it; widths remembered; reports
//     resize the description column only and stop stretching;
//   · Monthly P&L and Cash Flow open a row's entries UNDER it, each amount in
//     its month's column (and Accumulated), the last row counting them with
//     each month's subtotal and a link into the General Ledger.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const rt = await import(pathToFileURL(resolve(process.cwd(), "src/lib/use-resizable-tables.ts")).href);

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const ui = read("src/pages/accounting/index.tsx");
const api = read("src/api/routes/accounting.ts");
const lib = read("src/lib/use-resizable-tables.ts");
const slice = (src, from, to) => { const a = src.indexOf(from); assert.notEqual(a, -1, from); const b = src.indexOf(to, a + 1); assert.notEqual(b, -1, to); return src.slice(a, b); };

test("columns: a spanning header cell counts each real column; its edge is the last one it covers", () => {
  assert.equal(rt.columnCount([1, 1, 1]), 3);
  // A Monthly P&L header: Item, then each month over RM + %.
  assert.equal(rt.columnCount([1, 2, 2, 2]), 7);
  assert.deepEqual(rt.edgeColumns([1, 2, 2, 2]), [0, 2, 4, 6]);
  // Fractional measured widths round UP — rounding down cut a column that fitted exactly (prod 2026-10-01).
  assert.equal(rt.sumWidths([82.4, 100, 102.3]), 286);
});

test("widths are kept per page/tab and header; a report by its description column only", () => {
  assert.equal(rt.colWidthKey("accounting:payments", "", ["Date", "No.", "Payee"], false), "accounting:payments||Date|No.|Payee");
  assert.equal(rt.colWidthKey("accounting:plmonthly", "", ["Item", "Accumulated", "Sep 2026"], true), "accounting:plmonthly||first|Item", "new months do not lose the width");
});

test("the enhancer: one column changes, the table is the sum of its columns, a colgroup pins them", () => {
  assert.match(lib, /t\.style\.tableLayout = "fixed";\n  t\.style\.width = `\$\{sumWidths\(widths\)\}px`;\n  t\.style\.minWidth = "0";/);
  assert.match(lib, /widths\[col\] = Math\.max\(MIN_W, startW \+ ev\.clientX - startX\);/);
  assert.match(lib, /style\.width = `\$\{Math\.ceil\(w\)\}px`/, "pinned widths round up");
  assert.doesNotMatch(lib, /requestAnimationFrame\(/, "a background tab still gets its handles");
  assert.match(lib, /cg\.dataset\.finCols = "1";/, "its own colgroup, marked");
  assert.match(lib, /if \(mode === "off" \|\| t\.querySelector\(":scope > colgroup:not\(\[data-fin-cols\]\)"\)\) return;/, "DataGrid (own colgroup) is left alone");
  assert.match(lib, /writeWidths\(keyOf\(scope, t, firstOnly\), firstOnly \? \[widths\[0\]\] : widths\);/, "remembered");
  assert.match(lib, /\[data-fin-tables\] table th, \[data-fin-tables\] table td \{ white-space: nowrap; \}/, "no wrapping");
  assert.match(lib, /h\.addEventListener\("dblclick"/, "double-click goes back to automatic widths");
});

test("the finance pages carry it; reports resize the description only and stop stretching", () => {
  assert.match(ui, /const tablesRef = useResizableTables\(`accounting:\$\{tab\}`\);\n\n  return \(\n    <div ref=\{tablesRef\} data-fin-tables/);
  for (const p of ["src/pages/invoices/supplier-payments.tsx", "src/pages/invoices/payments.tsx", "src/pages/invoices/e-invoice.tsx"]) {
    const src = read(p);
    assert.match(src, /const tablesRef = useResizableTables\("[a-z-]+"\);\n\n  if \(loading\) \{/, `${p}: hooked before the loading screen`);
    assert.match(src, /<div ref=\{tablesRef\} data-fin-tables className=/, `${p}: root marked`);
  }
  assert.equal((ui.match(/<table data-col-resize="first"/g) ?? []).length, 8, "P&L, Monthly P&L, Cost structure, Cost classes, Monthly trend, TB, Balance sheet, Cash Flow");
  assert.doesNotMatch(slice(ui, "function MonthlyPlTab(", "\nfunction "), /min-w-full/, "Monthly P&L no longer stretched to the full width");
  assert.doesNotMatch(slice(ui, "function CashFlowTab(", "\n}\n"), /minWidth: 760/);
});

test("Monthly P&L: a row's ledger lines under it, in their month's column; the last row ties and opens the GL", () => {
  const ep = slice(api, 'app.get("/pl-drill"', 'app.get("/bs-drill"');
  assert.match(ep, /const startYm = ranged \? fromQ : periodStartYm\(period\);/, "a run of months (the financial year)");
  assert.match(ep, /openingMonth,\n\s+lines,/, "months before the opening are from the old books");
  const tab = slice(ui, "function MonthlyPlTab(", "\nfunction ");
  assert.match(tab, /const drillCode = r\.kind === "line" \? \(r\.drillCode \?\? r\.accountCode\) : undefined;/);
  assert.match(tab, /<PlMonthlyDrillRows account=\{drillCode\} cols=\{cols\} line=\{line\} rowValues=\{r\.values\} depth=\{r\.depth\} \/>/);
  const rows = slice(ui, "function PlMonthlyDrillRows(", "\nfunction ");
  assert.match(rows, /fetch\(`\/api\/accounting\/pl-drill\?account=\$\{encodeURIComponent\(account\)\}&from=\$\{from\}&to=\$\{to\}`\)/);
  assert.match(rows, /\$\{l\.description \|\| "—"\}\$\{l\.ref2 \? ` · \$\{l\.ref2\}` : ""\} — \$\{l\.ref1\}/, "date · description · who — document no.");
  assert.match(rows, /const on = c\.accum \|\| c\.key === e\.ym;/, "the amount in its month and in Accumulated");
  assert.match(rows, /const tied = line !== "all" \|\| cols\.every\(/, "each month's lines make the row");
  assert.match(rows, /open in GL<\/Link>/);
  // Computed lines that are one account's figure open too (as on the statement).
  const mx = read("src/lib/pnl-matrix.ts");
  assert.match(mx, /line\("PURCHASE", 3, \(w\) => find\(w\)\?\.purchasesSen \?\? 0, undefined, rg\.group\);/);
  assert.match(mx, /line\("CARRIAGE INWARDS", 1, \(w\) => w\.carriageSen, undefined, "700-1015"\);/);
});

test("the General Ledger opens from a drill's link with the account and dates picked", () => {
  const gl = slice(ui, "function GeneralLedgerTab(", "\nfunction ");
  assert.match(gl, /useState<string\[\]>\(\(\) => \{ const a = new URLSearchParams\(window\.location\.search\)\.get\("account"\); return a \? \[a\] : \[\]; \}\)/);
  assert.match(gl, /useState\(\(\) => new URLSearchParams\(window\.location\.search\)\.get\("from"\) \?\? ""\)/);
  assert.match(ui, /return `\/accounting\?tab=gl&account=\$\{encodeURIComponent\(account\)\}&from=\$\{fromYm\}-01&to=\$\{last\}`;/);
});
