// ---------------------------------------------------------------------------
// cashflow-trade-finance.test.mjs — owner 2026-09-28/29, final ruling
// 2026-09-29: 「raw material 加, drawdown 减, 一加一减 … trade finance - houzs
// century 我想要放在 after operation surplus」→「做」.
//
// A supplier paid from the trade-finance facility is GROSSED UP:
//   · the purchase splits by material under Raw Materials (spend, in the
//     month of the draw) exactly like a bank-paid supplier payment;
//   · the facility side sits in the Trade Finance block BELOW the operating
//     result, outflow-signed: a drawdown reads negative (the lender lent),
//     the lender's interest negative, a repayment positive (real cash out);
//   · the block nets to the change in what is owed; the operating result does
//     not include it; the bank surplus is bank legs only.
// Measured on prod 2026-09-29: Sep draws 97,159.68 (OCEAN SKY 33,352.38 ·
// MEDITEX 33,807.30 · NLY 30,000.00), interest 1,637.08, repaid 98,067.52.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const cf = await import(pathToFileURL(resolve(process.cwd(), "src/lib/cashflow-engine.ts")).href);

const acct = (code, type, sat = null, name = code) => ({ code, name, type, sat });
const coa = new Map([
  ["400-0000", acct("400-0000", "LIABILITY", "SCC", "TRADE CREDITORS")],
  ["310-0010", acct("310-0010", "ASSET", "SBK", "CASH AT BANK - HLBB")],
  ["310-0020", acct("310-0020", "LIABILITY", null, "TRADE FINANCE - HOUZS CENTURY SDN BHD")],
  ["900-I004", acct("900-I004", "EXPENSE", null, "INTEREST ON TRADE FINANCE")],
  ["900-0001", acct("900-0001", "EXPENSE", null, "Transport expense")],
]);
const TF = { "310-0020": { section: "TRADE_FINANCE", order: 10 } };
const leg = (accountCode, debitSen, creditSen, lineLabel, sourceId = "s", sourceType = "supplier_payment") =>
  ({ accountCode, debitSen, creditSen, ym: "2026-09", sourceType, sourceId, lineLabel });

// September as the caller now hands it over: a draw is the AP leg (split by
// material through rmSplit) + the facility leg AS POSTED (credit); interest
// is its expense leg + the facility credit; a repayment is the facility
// debit + the bank leg.
const sep = () => cf.buildStatement({
  classified: [
    leg("400-0000", 3335238, 0, undefined, "PV-2609-004"),
    leg("310-0020", 0, 3335238, "Drawdown — OCEAN SKY TRADING SDN. BHD.", "PV-2609-004"),
    leg("900-I004", 163708, 0, undefined, "tfint-1", "tf_interest"),
    leg("310-0020", 0, 163708, "Interest charged by HOUZS CENTURY SDN BHD", "tfint-1", "tf_interest"),
    leg("310-0020", 9806752, 0, "Repaid to HOUZS CENTURY SDN BHD", "HPV-2609-030"),
    leg("900-0001", 100000, 0, undefined, "pv-9", "payment_voucher"),
  ],
  bankLegs: [
    { accountCode: "310-0010", debitSen: 0, creditSen: 9806752, ym: "2026-09" },
    { accountCode: "310-0010", debitSen: 0, creditSen: 100000, ym: "2026-09" },
  ],
  coa, map: TF, rmSplit: { "PV-2609-004": [{ line: "B.M-FABR", weight: 1 }] },
  stockGroupOverride: {}, fyeMonth: 8, period: "2026-09",
});

test("the block reads the bank's way (cash view), is NOT operating, and is the first block after the operating result", () => {
  assert.equal(cf.SECTION_LABELS.TRADE_FINANCE, "Trade Finance");
  assert.equal(cf.displaySign("TRADE_FINANCE"), 1, "cash view: the lender lent = money in (+), a repayment = money out (−)");
  assert.ok(!cf.OPERATING_SECTIONS.has("TRADE_FINANCE"), "sits below Net operation surplus");
  assert.equal(cf.SECTION_ORDER.indexOf("TRADE_FINANCE"), cf.SECTION_ORDER.indexOf("TAXATION") + 1);
  const st = sep();
  const idx = (pred) => st.rows.findIndex(pred);
  const head = idx((r) => r.kind === "group" && r.groupId === "TRADE_FINANCE");
  assert.ok(idx((r) => r.kind === "result") < head, "after the operating result");
  assert.ok(head < idx((r) => r.kind === "total"), "before the cash surplus");
  assert.ok(!st.rows.some((r) => r.kind === "group" && ["FINANCE_COST", "CAPEX"].includes(r.groupId) && st.rows.indexOf(r) < head), "first of the lower blocks");
});

test("the purchase shows under Raw Materials (money out, −) and the drawdown below (money in, +): one cancels the other", () => {
  const st = sep();
  const m = st.columns.findIndex((c) => c.key === "2026-09");
  const fabr = st.rows.find((r) => r.kind === "line" && r.label === "B.M-FABR");
  assert.equal(fabr.section, "RAW_MATERIALS");
  assert.equal(fabr.values[m], -3335238, "the TF-paid purchase is spend (money out, −), by material, in the month of the draw");
  const lines = st.rows.filter((r) => r.kind === "line" && r.section === "TRADE_FINANCE");
  assert.deepEqual(lines.map((r) => r.label), [
    "Drawdown — OCEAN SKY TRADING SDN. BHD.",
    "Interest charged by HOUZS CENTURY SDN BHD",
    "Repaid to HOUZS CENTURY SDN BHD",
  ]);
  const val = (label) => lines.find((r) => r.label === label).values[m];
  assert.equal(val("Drawdown — OCEAN SKY TRADING SDN. BHD."), 3335238, "the lender lent → money in, positive");
  assert.equal(val("Interest charged by HOUZS CENTURY SDN BHD"), 163708);
  assert.equal(val("Repaid to HOUZS CENTURY SDN BHD"), -9806752, "real cash out → negative");
  const group = st.rows.find((r) => r.kind === "group" && r.label === "TRADE FINANCE - HOUZS CENTURY SDN BHD");
  assert.equal(group.groupId, "TRADE_FINANCE>310-0020");
  assert.equal(group.values[m], -(9806752 - 3335238 - 163708), "nets to the change in what is owed (repaid more than drawn → negative)");
  for (const l of lines) assert.equal(l.groupId, "TRADE_FINANCE>310-0020");
  // The interest expense lands on its own account line (General Expense).
  const intExp = st.rows.find((r) => r.kind === "line" && r.label === "INTEREST ON TRADE FINANCE");
  assert.equal(intExp.section, "GENERAL_EXPENSE");
  assert.equal(intExp.values[m], -163708);
});

test("the operating result counts the purchase and the interest, not the facility; the bank surplus is bank legs only", () => {
  const st = sep();
  const m = st.columns.findIndex((c) => c.key === "2026-09");
  const result = st.rows.find((r) => r.kind === "result");
  assert.equal(result.values[m], -(3335238 + 163708 + 100000));
  const total = st.rows.find((r) => r.kind === "total");
  assert.equal(total.values[m], -(9806752 + 100000), "Cash Surplus is the bank movement only");
});

test("a voided draw nets both sides to nothing", () => {
  const st = cf.buildStatement({
    classified: [
      leg("400-0000", 3032088, 0, undefined, "PV-2609-006"),
      leg("310-0020", 0, 3032088, "Drawdown — NLY SDN BHD", "PV-2609-006"),
      leg("400-0000", 0, 3032088, undefined, "PV-2609-006", "supplier_payment_void"),
      leg("310-0020", 3032088, 0, "Drawdown — NLY SDN BHD", "PV-2609-006", "supplier_payment_void"),
    ],
    bankLegs: [],
    coa, map: TF, rmSplit: { "PV-2609-006": [{ line: "PLYWOOD", weight: 1 }] },
    stockGroupOverride: {}, fyeMonth: 8, period: "2026-09",
  });
  const m = st.columns.findIndex((c) => c.key === "2026-09");
  const nly = st.rows.find((r) => r.kind === "line" && r.label === "Drawdown — NLY SDN BHD");
  assert.equal(nly.values[m] || 0, 0);
  const ply = st.rows.find((r) => r.kind === "line" && r.label === "PLYWOOD");
  assert.equal(ply.values[m] || 0, 0);
});

// The caller (computeCashflowStatement) — source-scan, house style.
const api = readFileSync("src/api/routes/accounting.ts", "utf8").replace(/\r\n/g, "\n");
const body = api.slice(api.indexOf("async function computeCashflowStatement("), api.indexOf('app.get("/cashflow-statement"'));

test("the statement learns the facility accounts from the trade-finance config, never a hard-coded code", () => {
  assert.match(body, /const tfSources = await getTfSources\(c\.var\.DB\)\.catch\(\(\) => \[\] as TfSource\[\]\);/);
  assert.match(body, /for \(const s of tfSources\) tfAccounts\.set\(resolveAcct\(s\.accountCode\), s\);/);
  assert.doesNotMatch(body, /310-0020/);
  assert.match(body, /if \(!map\[code\]\) map\[code\] = \{ section: "TRADE_FINANCE", order: 10 \};/);
});

test("a no-bank entry that moves the facility is grossed up: contra legs classify as if a bank paid, the facility leg as posted", () => {
  assert.match(body, /const viaTf = !hasBank && tfAccounts\.size > 0 && !opening && legs\.some\(\(l\) => tfAccounts\.has\(l\.code\)\);/);
  assert.match(body, /if \(!hasBank && !viaTf\) continue;/);
  const tf = body.slice(body.indexOf("if (tfAccounts.has(l.code)) {"), body.indexOf('if (l.sourceType.startsWith("other_party_payment"))'));
  assert.match(tf, /accountCode: l\.code, debitSen: l\.debitSen, creditSen: l\.creditSen,/, "as posted — no flip, no netting");
  assert.doesNotMatch(tf, /debitSen: l\.creditSen/, "the old flip is back");
  assert.match(tf, /\? `Interest charged by \$\{lender\}`/);
  assert.match(tf, /\? `Repaid to \$\{lender\}`/);
  assert.match(tf, /: `Drawdown — \$\{tfPayee\(l\.sourceType, l\.sourceId, l\.description\) \|\| "trade finance"\}`/);
  assert.match(tf, /continue;\s*\n\s*\}\s*$/, "a facility leg never reaches paymentNos / the raw-material split");
  // The draw's AP leg falls through to the normal road → paymentNos → material split.
  assert.match(body, /if \(l\.sourceType\.startsWith\("supplier_payment"\)\) paymentNos\.add\(l\.sourceId\);/);
  assert.match(body, /SELECT payment_no, MAX\(supplier_name\) AS supplier_name FROM supplier_payments WHERE org_id = \? GROUP BY payment_no/);
});
