// ---------------------------------------------------------------------------
// cashflow-drill-tidy.test.mjs — owner 2026-09-29, on the Cash Flow drill
// (#587): 「有一点点乱，有没有优化的建议」→ five changes →「好像可以，月份一起修」.
//
// 1. Description = the voucher's own purpose, not its number + payee again.
// 2. A split payment's whole amount and this line's share in their own columns.
// 3. The bank by its short name (HLBB, CIMB), the full name on hover.
// 4. One Amount column, money out in brackets like the statement.
// 5. "All months" in month blocks, each with its total.
// + The payroll month a salary voucher names now reads "MAY'26", "JULY'26",
//   "LATE SALARY JUNE" too — they used to fall back to the payment month's
//   payslip mix, so the department split used the wrong month.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const cf = await import(pathToFileURL(resolve(process.cwd(), "src/lib/cashflow-engine.ts")).href);
const ld = await import(pathToFileURL(resolve(process.cwd(), "src/lib/ledger-drill.ts")).href);

const api = readFileSync("src/api/routes/accounting.ts", "utf8").replace(/\r\n/g, "\n");
const ui = readFileSync("src/pages/accounting/index.tsx", "utf8").replace(/\r\n/g, "\n");
const slice = (src, from, to) => { const a = src.indexOf(from); assert.notEqual(a, -1, from); const b = src.indexOf(to, a + 1); return src.slice(a, b === -1 ? undefined : b); };

test("payroll month: any case, short or full names; no year = the latest such month; nothing named = fallback", () => {
  const p = cf.payrollMonthFrom;
  assert.equal(p("Foreigner Salaries - May'26", "2026-06"), "2026-05", "the form that already worked");
  assert.equal(p("PAYMENT FOR SALARIES - MAY'26", "2026-06"), "2026-05", "upper case used to fall back to June");
  assert.equal(p("PAYMENT FOR SALARIES - JULY'26", "2026-08"), "2026-07", "full name used to fall back to August");
  assert.equal(p("Salary Sept'26", "2026-10"), "2026-09");
  assert.equal(p("SALARY DECEMBER ' 25", "2026-01"), "2025-12");
  assert.equal(p("LATE SALARY JUNE", "2026-07"), "2026-06", "no year → the latest June not after July 2026");
  assert.equal(p("SALARY DECEMBER", "2026-01"), "2025-12", "no year across the year end");
  assert.equal(p("SALARY JULY", "2026-07"), "2026-07", "the payment month itself counts");
  assert.equal(p("KPI@ADVANCE", "2026-07"), "2026-07", "nothing named → the payment month");
  assert.equal(p("MAYBANK transfer", "2026-07"), "2026-07", "a month inside a word is not a month");
  assert.equal(p("", "2026-07"), "2026-07");
  assert.equal(p(null, "2026-07"), "2026-07");
});

test("description without its own number; short bank names", () => {
  assert.equal(ld.withoutDocNo("HPV-2608-030 · to ECMS", "HPV-2608-030"), "to ECMS");
  assert.equal(ld.withoutDocNo("Receipt HOR-2606-008 · Houzs Century", "HOR-2606-008"), "Receipt · Houzs Century");
  assert.equal(ld.withoutDocNo("Other creditor payment · HPV-2606-070 · Houzs Venture", "HPV-2606-070"), "Other creditor payment · Houzs Venture");
  assert.equal(ld.withoutDocNo("HPV-2608-030", "HPV-2608-030"), "HPV-2608-030", "nothing left → keep the original");
  assert.equal(ld.withoutDocNo("Bank charges", null), "Bank charges");
  assert.equal(ld.shortBankName("CASH AT BANK - HLBB"), "HLBB");
  assert.equal(ld.shortBankName("CASH AT BANK - CIMB"), "CIMB");
  assert.equal(ld.shortBankName("CASH IN HAND"), "Cash");
  assert.equal(ld.shortBankName("TRADE FINANCE - HOUZS CENTURY SDN BHD"), "TF · HOUZS CENTURY");
  assert.equal(ld.shortBankName("SOMETHING ELSE"), "SOMETHING ELSE");
});

test("the department split reads the named month, and keeps the old mix when that month has no payslips", () => {
  const fn = slice(api, "async function computeCashflowStatement(", 'app.get("/cashflow-statement"');
  assert.doesNotMatch(fn, /const payrollYm = /, "the old parser is gone");
  assert.match(fn, /const ym = payrollMonthFrom\(leg\.description, leg\.ym\);\n      let mix = await mixFor\(ym\);\n      if \(!mix\.length && ym !== leg\.ym\) mix = await mixFor\(leg\.ym\);/);
});

test("the drill's description is the voucher's purpose, else the line text without its number", () => {
  const fn = slice(api, "async function computeCashflowStatement(", 'app.get("/cashflow-statement"');
  assert.match(fn, /SELECT id, payee, description FROM payment_vouchers WHERE id IN/);
  assert.match(fn, /const description = purpose \? \(variant \? `\$\{purpose\} · \$\{variant\}` : purpose\) : tidyDescription\(legText, ref1, who\);/);
});

test("the panel: whole payment + share only when split, short bank, one Amount in brackets, month blocks with totals", () => {
  const panel = slice(ui, "function CfDrillPanel(", "\nfunction ");
  assert.match(panel, /const anySplit = shown\.some\(\(it\) => it\.ofSen\);/);
  assert.match(panel, /\{anySplit && <th className=\{thR\} title="The whole payment — this line got a share of it">Whole payment<\/th>\}/);
  assert.match(panel, /\{anySplit && <th className=\{thR\} title="This line's share of the whole payment">Share<\/th>\}/);
  assert.match(panel, /`\$\{\(\(Math\.abs\(it\.sen\) \/ it\.ofSen\) \* 100\)\.toFixed\(1\)\}%`/);
  assert.match(panel, /shortBankName\(o\.name\) \|\| o\.code/);
  assert.match(panel, /title=\{it\.otherSide\.map\(\(o\) => `\$\{o\.code\} \$\{o\.name\}`\)\.join\(", "\)\}/, "full name on hover");
  assert.match(panel, /const amt = \(sen: number\) => \(sen < 0 \? `\(\$\{plDrillAmt\(-sen\)\}\)` : plDrillAmt\(sen\)\);/);
  assert.doesNotMatch(panel, /Money in|Money out|part of/, "the old two columns / inline note are back");
  assert.match(panel, /\[\.\.\.new Set\(shown\.map\(\(it\) => it\.ym\)\)\]\.sort\(\)/, "month blocks oldest first");
  assert.match(panel, /<td className="py-1" colSpan=\{colCount - 1\}>\{b\.label\} total<\/td>/);
});
