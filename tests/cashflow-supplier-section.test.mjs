// ---------------------------------------------------------------------------
// cashflow-supplier-section.test.mjs — owner 2026-09-29 「我无法选其他的
// categories, 类似 capex 等等」→「做」.
//
// The Supplier categories card offered only the four raw-material lines. A
// supplier can now be filed under a SECTION (Capex, Factory Overhead, General
// Expense, Direct Labour): its uncoded / opening-creditor money — the
// "Unallocated — X" / "Opening creditors — X" rows, payments with no material
// line behind them — moves there whole, as a row named after the supplier.
// A payment that settled a PI with real material lines still splits by
// material (the promise made to the owner).
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const cf = await import(pathToFileURL(resolve(process.cwd(), "src/lib/cashflow-engine.ts")).href);

const acct = (code, type, sat = null, name = code) => ({ code, name, type, sat });
const coa = new Map([
  ["400-0000", acct("400-0000", "LIABILITY", "SCC", "TRADE CREDITORS")],
  ["310-0010", acct("310-0010", "ASSET", "SBK", "CASH AT BANK - HLBB")],
  ["703-0000", acct("703-0000", "COST", null, "PURCHASE - FILLER")],
]);
const L = (accountCode, creditSen, debitSen, ym, sourceType = "supplier_payment", sourceId = "s") =>
  ({ accountCode, creditSen, debitSen, ym, sourceType, sourceId });

test("supplierSectionFor — only per-supplier uncoded / opening rows, only the allowed sections", () => {
  const cat = { "AMAZON RENOVATION SERVICES": "CAPEX", "SUNMAT": "Purchase of Filler", "ODD": "LOAN" };
  assert.deepEqual(cf.supplierSectionFor("Unallocated — AMAZON RENOVATION SERVICES", cat), { section: "CAPEX", supplier: "AMAZON RENOVATION SERVICES" });
  assert.deepEqual(cf.supplierSectionFor("Opening creditors — AMAZON RENOVATION SERVICES", cat), { section: "CAPEX", supplier: "AMAZON RENOVATION SERVICES" });
  assert.equal(cf.supplierSectionFor("Unallocated — SUNMAT", cat), null, "a raw-material category still nests, never moves");
  assert.equal(cf.supplierSectionFor("Unallocated — ODD", cat), null, "LOAN is not a target");
  assert.equal(cf.supplierSectionFor("B.M-FABR", cat), null, "a stock-group line never moves");
  assert.deepEqual([...cf.SUPPLIER_SECTION_TARGETS], ["CAPEX", "FACTORY_OVERHEAD", "GENERAL_EXPENSE", "DIRECT_LABOUR"]);
});

test("a supplier filed under Capex takes its uncoded money there whole, named after itself", () => {
  const classified = [
    L("400-0000", 0, 250000, "2026-09", "supplier_payment", "PAY-AMZ"),
    L("400-0000", 0, 70000, "2026-09", "supplier_payment", "PAY-SUN"),
    L("400-0000", 0, 9000, "2026-09", "supplier_payment", "PAY-FAB"),
  ];
  const bankLegs = [{ accountCode: "310-0010", debitSen: 0, creditSen: 329000, ym: "2026-09" }];
  const st = cf.buildStatement({
    classified, bankLegs, coa, map: {},
    rmSplit: {
      "PAY-AMZ": [{ line: "Unallocated — AMAZON RENOVATION SERVICES", weight: 1 }],
      "PAY-SUN": [{ line: "Opening creditors — SUNMAT INDUSTRIES SDN. BHD", weight: 1 }],
      "PAY-FAB": [{ line: "B.M-FABR", weight: 1 }],
    },
    stockGroupOverride: {},
    supplierCategory: { "AMAZON RENOVATION SERVICES": "CAPEX", "SUNMAT INDUSTRIES SDN. BHD": "Purchase of Filler" },
    fyeMonth: 8, period: "2026-09",
  });
  const m = st.columns.findIndex((c) => c.key === "2026-09");
  const amz = st.rows.find((r) => r.kind === "line" && r.label === "AMAZON RENOVATION SERVICES");
  assert.ok(amz, "the supplier row under Capex is missing");
  assert.equal(amz.section, "CAPEX");
  assert.equal(amz.values[m], -250000, "money out reads negative (cash view)");
  assert.ok(!st.rows.some((r) => r.label === "Unallocated — AMAZON RENOVATION SERVICES"), "nothing left behind in Raw Materials");
  // Raw Materials keeps the rest: the filler supplier still nests, the stock line still splits.
  const rm = st.rows.find((r) => r.kind === "group" && r.groupId === "RAW_MATERIALS");
  assert.equal(rm.values[m], -79000);
  const sun = st.rows.find((r) => r.kind === "line" && r.label.includes("SUNMAT"));
  assert.equal(sun.groupId, "RAW_MATERIALS>703-0000");
  // Capex sits below the operating result, so the surplus no longer carries the 250,000.
  const result = st.rows.find((r) => r.kind === "result");
  assert.equal(result.values[m], -79000);
  const total = st.rows.find((r) => r.kind === "total");
  assert.equal(total.values[m], -329000, "the bank surplus is untouched");
});

const api = readFileSync("src/api/routes/accounting.ts", "utf8").replace(/\r\n/g, "\n");
const ui = readFileSync("src/pages/accounting/index.tsx", "utf8").replace(/\r\n/g, "\n");

test("the map endpoint accepts a section target; the card offers the four sections", () => {
  assert.match(api, /if \(cat === "" \|\| \(RM_LINES as readonly string\[\]\)\.includes\(cat\) \|\| \(SUPPLIER_SECTION_TARGETS as readonly string\[\]\)\.includes\(cat\)\) supCat\[s\] = cat;/);
  assert.match(ui, /const SECTION_CATEGORIES: \{ value: string; label: string \}\[\] = \[/);
  for (const v of ['"CAPEX"', '"FACTORY_OVERHEAD"', '"GENERAL_EXPENSE"', '"DIRECT_LABOUR"']) assert.match(ui, new RegExp(`\\{ value: ${v}, label: "`));
  assert.match(ui, /\{SECTION_CATEGORIES\.map\(\(c2\) => <option key=\{c2\.value\} value=\{c2\.value\}>\{c2\.label\}<\/option>\)\}/);
});
