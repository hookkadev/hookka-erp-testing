// ---------------------------------------------------------------------------
// cashflow-finance-cost-and-name-match.test.mjs — owner 2026-09-29:
//   「这个应该是 finance cost 那边吧 … 不应该出现 unallocated，就是 meditex 那个」
//   →「做，两样都做」.
//
// 1. Interest (and every other account under the chart's FINANCE COSTS
//    parent) defaults to the Finance Cost block below the operating result,
//    instead of General Expense. The owner's own drag (cashflow map) wins.
// 2. A PI line whose code is not in the RM master resolves its stock group
//    the way GRN receiving already does — the supplier SKU in the price list,
//    then the EXACT product name of one master item — instead of falling to
//    "Unallocated — <supplier>". Measured: MEDITEX keyed
//    `MED-PSF15.064HCS(A1)` on 44 lines; the master item is
//    `MED-PSF15.064HCS(14)(L)`, same name, same price. No code guessing: a
//    line matching neither still shows as Unallocated.
//    (The price list itself was NOT touched: an extra same-price `(A1)` row
//    would make the PO screen's SKU recovery ambiguous for MEDITEX fibre.)
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const cf = await import(pathToFileURL(resolve(process.cwd(), "src/lib/cashflow-engine.ts")).href);

const api = readFileSync("src/api/routes/accounting.ts", "utf8").replace(/\r\n/g, "\n");
const body = api.slice(api.indexOf("async function computeCashflowStatement("), api.indexOf('app.get("/cashflow-statement"'));

test("finance-cost accounts default to the Finance Cost block (found by the parent's NAME), owner's drag wins", () => {
  assert.match(body, /const financeParents = new Set\(\[\.\.\.coa\.values\(\)\]\.filter\(\(a\) => \/\^FINANCE COSTS\?\$\/i\.test\(a\.name\.trim\(\)\)\)\.map\(\(a\) => a\.code\)\);/);
  assert.match(body, /if \(a\.parentCode && financeParents\.has\(a\.parentCode\) && !map\[a\.code\]\) map\[a\.code\] = \{ section: "FINANCE_COST", order: 10 \};/);
  assert.doesNotMatch(body, /902-0000"/, "no hard-coded finance-cost code");
});

test("the Finance Cost block sits below the operating result, so interest no longer counts as operating spend", () => {
  const acct = (code, type, name, parentCode = null, sat = null) => ({ code, name, type, sat, parentCode });
  const coa = new Map([
    ["310-0010", acct("310-0010", "ASSET", "CASH AT BANK", null, "SBK")],
    ["902-0000", acct("902-0000", "EXPENSE", "FINANCE COSTS")],
    ["900-I004", acct("900-I004", "EXPENSE", "INTEREST ON TRADE FINANCE", "902-0000")],
    ["900-L002", acct("900-L002", "EXPENSE", "LOAN INTEREST", "902-0000")],
  ]);
  const leg = (accountCode, debitSen) => ({ accountCode, debitSen, creditSen: 0, ym: "2026-09", sourceType: "x", sourceId: "s" });
  const st = cf.buildStatement({
    classified: [leg("900-I004", 163708), leg("900-L002", 500)],
    bankLegs: [{ accountCode: "310-0010", debitSen: 0, creditSen: 164208, ym: "2026-09" }],
    coa, map: { "900-I004": { section: "FINANCE_COST", order: 10 }, "900-L002": { section: "FINANCE_COST", order: 10 } },
    rmSplit: {}, stockGroupOverride: {}, fyeMonth: 8, period: "2026-09",
  });
  const m = st.columns.findIndex((c) => c.key === "2026-09");
  const head = st.rows.find((r) => r.kind === "group" && r.groupId === "FINANCE_COST");
  assert.equal(head.values[m], -164208); // money out reads negative (cash view)
  const idx = (pred) => st.rows.findIndex(pred);
  assert.ok(idx((r) => r.kind === "result") < idx((r) => r === head), "below Net operation surplus");
  assert.equal(st.rows.find((r) => r.kind === "result").values[m], 0, "not operating");
  assert.equal(st.rows.find((r) => r.kind === "total").values[m], -164208, "bank surplus unchanged");
});

test("an unknown PI code resolves through the price-list SKU, then the exact product name — never a guess", () => {
  assert.match(body, /const grpByDesc = new Map<string, string \| null>\(\);/);
  assert.match(body, /grpByDesc\.set\(desc, grpByDesc\.has\(desc\) && grpByDesc\.get\(desc\) !== grp \? null : grp\);/, "an ambiguous description resolves nothing");
  assert.match(body, /SELECT supplierSku, materialCode FROM supplier_material_bindings/);
  assert.match(body, /codeBySku\.set\(sku, codeBySku\.has\(sku\) && codeBySku\.get\(sku\) !== code \? null : code\);/, "an ambiguous SKU resolves nothing");
  const fn = body.slice(body.indexOf("const groupForLine = "), body.indexOf("};", body.indexOf("const groupForLine = ")));
  // Order: exact code, then SKU, then exact name.
  assert.ok(fn.indexOf("grpByCode.get(code)") < fn.indexOf("codeBySku.get(") && fn.indexOf("codeBySku.get(") < fn.indexOf("grpByDesc.get("));
  assert.match(body, /const grp = groupForLine\(mc, String\(\(it\.material_name \?\? it\.materialName\) \?\? ""\)\);/);
  // A line matching nothing still falls to the per-supplier Unallocated row.
  assert.match(body, /const line = lt === "TAX" \? "SST \/ TAX" : grp \? \(sgOverride\[grp\] \?\? grp\) : `Unallocated — \$\{supplier\}`;/);
  // The price list is only READ here.
  assert.doesNotMatch(body, /INSERT INTO supplier_material_bindings|UPDATE supplier_material_bindings/);
});
