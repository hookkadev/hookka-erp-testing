// ---------------------------------------------------------------------------
// cashflow-stock-accounts.test.mjs — owner 2026-09-29: the Cash Flow's
// "Unallocated" held "STOCK - FABRIC M 442.00" (Gallery Dominance bill
// OCB-2609-004 booked straight to the fabric stock account) →「442.00 - 可以」.
//
// Raw-material stock accounts (special type SBS) default to Raw Materials and
// nest under the purchase parent their name belongs to (FABRIC → PURCHASE -
// FABRIC). WIP / finished-goods stock is not raw material and is left alone.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const cf = await import(pathToFileURL(resolve(process.cwd(), "src/lib/cashflow-engine.ts")).href);

const acct = (code, type, name, parentCode = null, sat = null) => ({ code, name, type, sat, parentCode });
const coa = new Map([
  ["310-0010", acct("310-0010", "ASSET", "CASH AT BANK", null, "SBK")],
  ["330-0000", acct("330-0000", "ASSET", "STOCK")],
  ["330-0001", acct("330-0001", "ASSET", "STOCK - FABRIC M", "330-0000", "SBS")],
  ["330-2001", acct("330-2001", "ASSET", "STOCK - B.FILLER", "330-0000", "SBS")],
  ["701-0000", acct("701-0000", "COST", "PURCHASE - FABRIC")],
  ["703-0000", acct("703-0000", "COST", "PURCHASE - FILLER")],
]);
const leg = (accountCode, debitSen) => ({ accountCode, debitSen, creditSen: 0, ym: "2026-09", sourceType: "other_party_payment", sourceId: "HPV-1" });

test("a stock account paid from the bank lands under the purchase parent its name belongs to", () => {
  const st = cf.buildStatement({
    classified: [leg("330-0001", 44200), leg("330-2001", 10000)],
    bankLegs: [{ accountCode: "310-0010", debitSen: 0, creditSen: 54200, ym: "2026-09" }],
    coa, map: { "330-0001": { section: "RAW_MATERIALS", order: 10 }, "330-2001": { section: "RAW_MATERIALS", order: 10 } },
    rmSplit: {}, stockGroupOverride: {}, fyeMonth: 8, period: "2026-09",
  });
  const m = st.columns.findIndex((c) => c.key === "2026-09");
  const fab = st.rows.find((r) => r.kind === "line" && r.label === "STOCK - FABRIC M");
  assert.equal(fab.section, "RAW_MATERIALS");
  assert.equal(fab.groupId, "RAW_MATERIALS>701-0000", "under PURCHASE - FABRIC, not the balance-sheet STOCK parent");
  assert.equal(fab.values[m], 44200);
  const fil = st.rows.find((r) => r.kind === "line" && r.label === "STOCK - B.FILLER");
  assert.equal(fil.groupId, "RAW_MATERIALS>703-0000");
  assert.ok(!st.rows.some((r) => r.kind === "group" && r.label === "STOCK"), "no STOCK cluster inside Raw Materials");
});

test("the statement defaults raw-material stock accounts to Raw Materials; WIP / FG stock and the owner's drag are left alone", () => {
  const api = readFileSync("src/api/routes/accounting.ts", "utf8").replace(/\r\n/g, "\n");
  const body = api.slice(api.indexOf("async function computeCashflowStatement("), api.indexOf('app.get("/cashflow-statement"'));
  assert.match(body, /if \(a\.sat !== "SBS" \|\| map\[a\.code\] \|\| \/WORK-IN-PROGRESS\|FINISHED GOODS\|\\bWIP\\b\/i\.test\(a\.name\)\) continue;/);
  assert.match(body, /map\[a\.code\] = \{ section: "RAW_MATERIALS", order: 10 \};/);
});
