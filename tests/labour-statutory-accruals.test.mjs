// ---------------------------------------------------------------------------
// labour-statutory-accruals.test.mjs — owner 2026-10-09, on the Labour tab's
// GL preview: 「这个 post to GL 我在 journal 看没有，然后 epf, socso 那些也要
// accrual」→「EIS 单独记 0040，journal 也要显示，做」.
//   · the month-end posting credits each fund's share — the employer's plus
//     the employee's — to its own accrual (EPF 410-0020, SOCSO 410-0030, EIS
//     410-0040, editable in the map) and only the rest to 410-0010;
//   · the system's own postings (labour, closing stock, depreciation, the
//     year-end close, the opening balance) are listed on Journal Entries,
//     read-only, one entry per posting.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { labourCreditLines } from "../src/lib/labour-credit.ts";
import { SYSTEM_JOURNAL_FAMILIES, buildSystemJournals } from "../src/lib/system-journals.ts";

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const api = read("src/api/routes/accounting.ts");
const ui = read("src/pages/accounting/index.tsx");
const slice = (src, from, to) => { const a = src.indexOf(from); assert.notEqual(a, -1, from); const b = src.indexOf(to, a + 1); assert.notEqual(b, -1, to); return src.slice(a, b); };

const ACCT = { salary: "410-0010", epf: "410-0020", socso: "410-0030", eis: "410-0040" };
// Two departments' payslip totals (sen). costSen = gross + employer shares.
const dept = (gross, epfEr, socsoEr, eisEr, epfEe, socsoEe, eisEe) => ({
  costSen: gross + epfEr + socsoEr + eisEr,
  epfSen: epfEr, socsoSen: socsoEr, eisSen: eisEr,
  epfEmployeeSen: epfEe, socsoEmployeeSen: socsoEe, eisEmployeeSen: eisEe,
});

test("each fund is owed the employer's share plus the employee's; the salary accrual keeps the rest", () => {
  const lines = labourCreditLines([dept(200000, 26000, 3500, 400, 22000, 1000, 400), dept(100000, 13000, 1750, 200, 11000, 500, 200)], ACCT);
  assert.deepEqual(lines, [
    { account: "410-0010", sen: 300000 - 33000 - 1500 - 600, label: "accrued wages payable" },
    { account: "410-0020", sen: 39000 + 33000, label: "EPF payable" },
    { account: "410-0030", sen: 5250 + 1500, label: "SOCSO payable" },
    { account: "410-0040", sen: 600 + 600, label: "EIS payable" },
  ]);
});

test("the credits sum to the full cost — the entry balances against the debit side", () => {
  const byDept = [dept(345678, 41234, 5678, 912, 38001, 1702, 455), dept(1, 0, 0, 0, 0, 0, 0)];
  const credit = labourCreditLines(byDept, ACCT).reduce((s, l) => s + l.sen, 0);
  assert.equal(credit, byDept.reduce((s, d) => s + d.costSen, 0));
});

test("a fund with nothing owed posts no line; payslips without employee shares still balance", () => {
  const lines = labourCreditLines([{ costSen: 105000, epfSen: 5000, socsoSen: 0, eisSen: 0, epfEmployeeSen: null, socsoEmployeeSen: undefined, eisEmployeeSen: 0 }], ACCT);
  assert.deepEqual(lines.map((l) => [l.account, l.sen]), [["410-0010", 100000], ["410-0020", 5000]]);
});

test("two parts mapped to one account post as one line", () => {
  const lines = labourCreditLines([dept(100000, 13000, 1750, 200, 11000, 500, 200)], { ...ACCT, eis: "410-0030" });
  assert.deepEqual(lines.find((l) => l.account === "410-0030"), { account: "410-0030", sen: 2250 + 400, label: "SOCSO payable + EIS payable" });
  assert.equal(lines.length, 3);
});

test("server: preview and post credit the same lines; the accruals default to 410-0020/30/40 and are kept on save", () => {
  assert.match(api, /epfAccrual: "410-0020", \/\/ ACCRUAL - EPF/);
  assert.match(api, /socsoAccrual: "410-0030", \/\/ ACCRUAL - SOCSO/);
  assert.match(api, /eisAccrual: "410-0040", \/\/ ACCRUAL - EIS/);
  assert.match(api, /eisAccrual: parsed\.eisAccrual \|\| DEFAULT_LABOUR_MAP\.eisAccrual,/);
  // The employee's shares are read from the payslips.
  assert.match(api, /epfEmployeeSen, socsoEmployeeSen, eisEmployeeSen\n\s+FROM payslips WHERE orgId = \? AND period = \? AND status != 'CANCELLED'/);
  const uses = api.match(/labourCreditLines\(byDept, labourMap(Post)?\)/g) ?? [];
  assert.equal(uses.length, 2, "one in the preview, one in the post");
  const post = slice(api, 'app.post("/labor/post"', 'app.post("/labor/unpost"');
  assert.match(post, /description: `Labour \$\{month\} · \$\{label\}`,/);
  // A save that only touched a department never drops the statutory accounts.
  const put = slice(api, 'app.put("/labor/map"', "\n});\n");
  assert.match(put, /typeof body\[k\] === "string" && body\[k\]\.trim\(\) \? String\(body\[k\]\)\.trim\(\) : saved\[k\];/);
  assert.match(put, /Not a postable account on the chart:/);
  assert.match(put, /\.bind\(JSON\.stringify\(\{ fallback, byDept, \.\.\.statutory \}\), new Date\(\)\.toISOString\(\)\)/);
});

test("page: the GL preview shows every credit line; a month posted the old way says so", () => {
  const tab = slice(ui, "function LaborTab(", "\nfunction ");
  assert.match(tab, /\(data\.credits \?\? \[\{ code: data\.accrualAccount, name: "ACCRUAL - SALARY", sen: data\.totalSen \}\]\)\.map\(\(cr\) => \(/);
  assert.match(tab, /Posted before EPF \/ SOCSO \/ EIS had their own accruals — Unpost, then Post again to split it\./);
  assert.match(tab, /\[\["epfAccrual", "EPF owed"\], \["socsoAccrual", "SOCSO owed"\], \["eisAccrual", "EIS owed"\]\]/);
});

const leg = (sourceType, sourceId, postedAt, accountCode, debitSen, creditSen, description) =>
  ({ sourceType, sourceId, postedAt, accountCode, debitSen, creditSen, description });
const monthEnd = (st, sid, at) => (sid.startsWith("labor-") ? `${sid.slice(6)}-31` : at.slice(0, 10));

test("system postings: one entry per posting; a re-post and its undo are their own entries", () => {
  const legs = [
    leg("labor_post", "labor-2026-07", "2026-08-05T10:00:00Z", "750-0010", 1000, 0, "Labour 2026-07 · PRODUCTION"),
    leg("labor_post", "labor-2026-07", "2026-08-05T10:00:00Z", "410-0010", 0, 1000, "Labour 2026-07 · accrued wages payable"),
    leg("labor_post_reversal", "labor-2026-07", "2026-10-09T09:00:00Z", "750-0010", 0, 1000, "Labour 2026-07 · unposted"),
    leg("labor_post_reversal", "labor-2026-07", "2026-10-09T09:00:00Z", "410-0010", 1000, 0, "Labour 2026-07 · unposted"),
    leg("labor_post", "labor-2026-07", "2026-10-09T09:01:00Z", "750-0010", 1000, 0, "Labour 2026-07 · PRODUCTION"),
    leg("labor_post", "labor-2026-07", "2026-10-09T09:01:00Z", "410-0010", 0, 900, "Labour 2026-07 · accrued wages payable"),
    leg("labor_post", "labor-2026-07", "2026-10-09T09:01:00Z", "410-0020", 0, 100, "Labour 2026-07 · EPF payable"),
    leg("manual", "je-1", "2026-10-09T09:02:00Z", "100-0000", 5, 0, "not a system posting"),
  ];
  const out = buildSystemJournals(legs, (c) => ({ "410-0020": "ACCRUAL - EPF" })[c] ?? "", monthEnd);
  assert.equal(out.length, 3);
  for (const e of out) {
    assert.equal(e.date, "2026-07-31", "on the date the GL reports it under");
    assert.equal(e.status, "POSTED");
    assert.equal(e.system.tab, "labor");
    assert.equal(e.lines.reduce((s, l) => s + l.debitSen, 0), e.lines.reduce((s, l) => s + l.creditSen, 0));
  }
  assert.deepEqual(out.map((e) => [e.system.label, e.lines.length]), [["Labour posting", 3], ["Labour posting undone", 2], ["Labour posting", 2]], "newest posting first");
  assert.equal(out[1].system.undo, true);
  assert.equal(out[0].description, "Labour posting · Labour 2026-07 · PRODUCTION");
  assert.equal(out[0].lines[2].accountName, "ACCRUAL - EPF");
  assert.notEqual(out[0].id, out[2].id, "a re-post is not the first posting");
});

test("system postings: the families and the tab that made each", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(SYSTEM_JOURNAL_FAMILIES).map(([k, v]) => [k, v.tab])), {
    labor_post: "labor", labor_post_reversal: "labor",
    closing_stock: "stock", closing_stock_reversal: "stock",
    depreciation: "assets", year_close: "bs",
    opening_balance: "opening", opening_balance_reversal: "opening",
  });
  // Each tab exists on the page.
  for (const tab of new Set(Object.values(SYSTEM_JOURNAL_FAMILIES).map((f) => f.tab))) {
    assert.match(ui, new RegExp(`\\{ key: "${tab}", label: "`), tab);
  }
  const r = slice(api, 'app.get("/system-journals", async (c) => {', "\n});\n");
  assert.match(r, /requirePermission\(c, "accounting", "read"\)/);
  assert.match(r, /WHERE orgId = \? AND hidden = 0 AND sourceType IN/);
  assert.match(r, /buildSystemJournals\(legRes\.results \?\? \[\], \(code\) => names\.get\(code\) \?\? "", dc\.docDate\)/);
});

test("Journal Entries lists them beside the manual journals, read-only", () => {
  const tab = slice(ui, "function JournalsTab(", "\nfunction JournalEntryForm(");
  assert.match(tab, /useCachedJson<\{ success\?: boolean; data\?: JournalRow\[\] \}>\("\/api\/accounting\/system-journals"\)/);
  assert.match(tab, /data=\{rows\}/);
  assert.match(tab, /const je = rows\.find\(\(j\) => j\.id === detailJv\.id\) \?\? detailJv;/);
  // The menu for a system row: view, print, open its tab — nothing that edits.
  const menu = slice(tab, "if (row.system) {", "    }\n");
  assert.doesNotMatch(menu, /Edit|Post"|Void|Delete|Duplicate/);
  assert.match(menu, /label: `Open \$\{systemTabLabel\(sys\)\}`, action: \(\) => openSystemTab\(sys\)/);
  // The detail popup hides every manual-journal action for them.
  assert.match(tab, /\{!sys && je\.status === "DRAFT" && \(/);
  assert.match(tab, /\{!sys && je\.status !== "DRAFT" && state === "ACTIVE" && \(/);
  assert.match(tab, /\{!sys && \(\n\s+<Button variant="outline" size="sm" onClick=\{\(\) => \{ close\(\); void handleDuplicate\(je\); \}\}>Duplicate as draft<\/Button>/);
});
