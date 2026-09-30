// ---------------------------------------------------------------------------
// cashflow-stock-accounts.test.mjs — owner 2026-09-30: the pre-opening fabric
// repaid to Houzs Century stays on STOCK - FABRIC M (「不要动到 P&L」), and the
// cash flow should still read it as buying fabric; the loan repayment that
// shared that account was re-booked by the owner first (OCB-2606-017 →
// 440-0030), so the stock account now holds only material.
//
// Raw-material stock accounts (SBS) default to Raw Materials and nest under
// the purchase parent their name belongs to; WIP / finished goods are not raw
// material. Only the cash flow classification changes — the ledger and the
// P&L do not.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const cf = await import(pathToFileURL(resolve(process.cwd(), "src/lib/cashflow-engine.ts")).href);
const api = readFileSync("src/api/routes/accounting.ts", "utf8").replace(/\r\n/g, "\n");

const acct = (code, type, name, parentCode = null, sat = null) => ({ code, name, type, sat, parentCode });
const coa = new Map([
  ["310-0010", acct("310-0010", "ASSET", "CASH AT BANK - HLBB", null, "SBK")],
  ["330-0000", acct("330-0000", "ASSET", "STOCK")],
  ["330-0001", acct("330-0001", "ASSET", "STOCK - FABRIC M", "330-0000", "SBS")],
  ["330-2001", acct("330-2001", "ASSET", "STOCK - B.FILLER", "330-0000", "SBS")],
  ["330-8000", acct("330-8000", "ASSET", "STOCK - WORK-IN-PROGRESS", "330-0000", "SBS")],
  ["330-9000", acct("330-9000", "ASSET", "STOCK - FINISHED GOODS", "330-0000", "SBS")],
  ["701-0000", acct("701-0000", "COST", "PURCHASE - FABRIC")],
  ["703-0000", acct("703-0000", "COST", "PURCHASE - FILLER")],
  ["900-W001", acct("900-W001", "EXPENSE", "WATER & ELECTRICITY")],
]);

test("which stock accounts count as raw material", () => {
  const s = cf.rawStockAccountSections(coa);
  assert.deepEqual(Object.fromEntries(s), { "330-0001": "RAW_MATERIALS", "330-2001": "RAW_MATERIALS" });
  assert.equal(s.has("330-8000"), false, "work in progress is not raw material");
  assert.equal(s.has("330-9000"), false, "finished goods are not raw material");
  assert.equal(s.has("900-W001"), false, "only stock accounts");
});

test("a payment booked to a stock account reads as buying that material; the cash surplus does not move", () => {
  const leg = (accountCode, debitSen, ym, sourceId) => ({ accountCode, debitSen, creditSen: 0, ym, sourceType: "other_party_payment", sourceId });
  const input = (map) => ({
    classified: [leg("330-0001", 10789890, "2026-08", "HPV-2608-021"), leg("330-2001", 10000, "2026-08", "HPV-2608-022")],
    bankLegs: [
      { accountCode: "310-0010", debitSen: 0, creditSen: 10789890, ym: "2026-08" },
      { accountCode: "310-0010", debitSen: 0, creditSen: 10000, ym: "2026-08" },
    ],
    coa, map, rmSplit: {}, stockGroupOverride: {}, fyeMonth: 8, period: "2026-08", trace: true,
  });
  const toMap = (m) => Object.fromEntries([...m].map(([code, section]) => [code, { section, order: 10 }]));
  const now = cf.buildStatement(input(toMap(cf.rawStockAccountSections(coa))));
  const before = cf.buildStatement(input({}));
  const m = now.columns.findIndex((c) => c.key === "2026-08");
  const row = (st, pred) => st.rows.find(pred);
  // Before: nobody knew the stock account → Unallocated.
  assert.equal(row(before, (r) => r.kind === "group" && r.groupId === "UNALLOCATED").values[m], -(10789890 + 10000));
  // Now: Raw Materials, nested under the purchase parent the name belongs to.
  assert.equal(row(now, (r) => r.kind === "group" && r.groupId === "RAW_MATERIALS").values[m], -(10789890 + 10000));
  assert.equal(row(now, (r) => r.kind === "line" && r.label === "STOCK - FABRIC M").groupId, "RAW_MATERIALS>701-0000");
  assert.equal(row(now, (r) => r.kind === "line" && r.label === "STOCK - B.FILLER").groupId, "RAW_MATERIALS>703-0000");
  assert.equal(row(now, (r) => r.kind === "group" && r.groupId === "UNALLOCATED"), undefined, "nothing left unallocated");
  // Cash surplus and bank rows are the same; the operating result now carries the purchase.
  for (const kind of ["total", "bf", "cf"]) assert.deepEqual(row(now, (r) => r.kind === kind).values, row(before, (r) => r.kind === kind).values);
  assert.equal(row(now, (r) => r.kind === "result").values[m], row(before, (r) => r.kind === "result").values[m] - (10789890 + 10000));
  // The drill still ties: the line's sources are the payment.
  assert.deepEqual(now.sources["RAW_MATERIALS|STOCK - FABRIC M"].map((s) => [s.sourceId, s.sen]), [["HPV-2608-021", -10789890]]);
});

test("the caller fills the default only where the owner has not dragged", () => {
  assert.match(api, /for \(const \[code, section\] of rawStockAccountSections\(coa\)\) if \(!map\[code\]\) map\[code\] = \{ section, order: 10 \};/);
});
