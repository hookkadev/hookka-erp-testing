// ---------------------------------------------------------------------------
// cashflow-trade-finance.test.mjs — owner 2026-09-28:
//   「用 trade finance 还我要当做 trade finance - Houzs Century」 then
//   「我决定倒反吧 … repay 是 + … 我会看 total spend」→「对，做」.
//
// The Cash Flow statement gets a Trade Finance block inside COST / EXPENSE OUT,
// right after Raw Materials:
//   · a supplier paid from the facility (DR 400 · CR 310-0020, no bank leg) is
//     SPEND in the month of the draw — one positive row per supplier "(via TF)";
//   · the repayment to the lender (DR 310-0020 · CR bank) is the OFFSET — one
//     negative row "Repaid to <lender>";
//   · the block nets to what is still owed and counts in the operating surplus
//     (the owner's "total spend"); the bank surplus stays bank-true.
// Measured on prod that day: Jul draws 95,513.04 / Aug 31,741.29 / Sep
// 97,775.56 (OCEAN SKY 33,466.49 · MEDITEX 33,988.19 · NLY 30,320.88), Sep
// repayment 64,601.03 — which until now sat under Unallocated as (64,601.03)
// while the draws appeared nowhere.
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
  ["900-0001", acct("900-0001", "EXPENSE", null, "Transport expense")],
]);
const TF = { "310-0020": { section: "TRADE_FINANCE", order: 10 } };
const leg = (accountCode, debitSen, creditSen, lineLabel, sourceId = "s", sourceType = "supplier_payment") =>
  ({ accountCode, debitSen, creditSen, ym: "2026-09", sourceType, sourceId, lineLabel });

// The September picture the owner approved, in sen. Draws arrive as debit
// pseudo-legs (the caller turns the CR on the facility into one); the
// repayment arrives flipped to a credit (the real leg is DR 310-0020).
const sep = () => cf.buildStatement({
  classified: [
    leg("310-0020", 3346649, 0, "OCEAN SKY TRADING SDN. BHD. (via TF)", "PV-2609-004"),
    leg("310-0020", 3398819, 0, "MEDITEX INDUSTRIES SDN. BHD. (via TF)", "PV-2609-007"),
    leg("310-0020", 3032088, 0, "NLY SDN BHD (via TF)", "PV-2609-006"),
    leg("310-0020", 0, 6460103, "Repaid to HOUZS CENTURY SDN BHD", "HPV-2609-030"),
    leg("900-0001", 100000, 0, undefined, "pv-9", "payment_voucher"),
  ],
  bankLegs: [
    { accountCode: "310-0010", debitSen: 0, creditSen: 6460103, ym: "2026-09" },
    { accountCode: "310-0010", debitSen: 0, creditSen: 100000, ym: "2026-09" },
  ],
  coa, map: TF, rmSplit: {}, stockGroupOverride: {}, fyeMonth: 8, period: "2026-09",
});

test("the section exists, is spend-signed, operating, and sits right after Raw Materials", () => {
  assert.equal(cf.SECTION_LABELS.TRADE_FINANCE, "Trade Finance");
  assert.ok(cf.OUTFLOW_SECTIONS.has("TRADE_FINANCE"), "draws display positive like every other spend");
  assert.ok(cf.OPERATING_SECTIONS.has("TRADE_FINANCE"), "counted in the operating surplus — the owner's total spend");
  assert.equal(cf.SECTION_ORDER.indexOf("TRADE_FINANCE"), cf.SECTION_ORDER.indexOf("RAW_MATERIALS") + 1);
  assert.ok(cf.tfLineOrder("OCEAN SKY (via TF)") < cf.tfLineOrder("Repaid to HOUZS CENTURY SDN BHD"), "draws first, repayment last");
});

test("draws show positive per supplier, the repayment negative, under the facility account as the group", () => {
  const st = sep();
  const m = st.columns.findIndex((c) => c.key === "2026-09");
  const group = st.rows.find((r) => r.kind === "group" && r.label === "TRADE FINANCE - HOUZS CENTURY SDN BHD");
  assert.ok(group, "facility account group missing");
  assert.equal(group.section, "TRADE_FINANCE");
  assert.equal(group.groupId, "TRADE_FINANCE>310-0020");
  assert.equal(group.values[m], 9777556 - 6460103, "the block nets to what is still owed this month");
  const lines = st.rows.filter((r) => r.kind === "line" && r.section === "TRADE_FINANCE");
  assert.deepEqual(lines.map((r) => r.label), [
    "MEDITEX INDUSTRIES SDN. BHD. (via TF)",
    "NLY SDN BHD (via TF)",
    "OCEAN SKY TRADING SDN. BHD. (via TF)",
    "Repaid to HOUZS CENTURY SDN BHD",
  ]);
  const val = (label) => lines.find((r) => r.label === label).values[m];
  assert.equal(val("OCEAN SKY TRADING SDN. BHD. (via TF)"), 3346649);
  assert.equal(val("Repaid to HOUZS CENTURY SDN BHD"), -6460103);
  for (const l of lines) assert.equal(l.groupId, "TRADE_FINANCE>310-0020");
  // The section head carries the same net, and lives in COST / EXPENSE OUT
  // between Raw Materials and the operating result.
  const head = st.rows.find((r) => r.kind === "group" && r.groupId === "TRADE_FINANCE");
  assert.equal(head.values[m], 9777556 - 6460103);
  const idx = (pred) => st.rows.findIndex(pred);
  assert.ok(idx((r) => r.kind === "section" && r.label === "COST / EXPENSE OUT") < idx((r) => r === head));
  assert.ok(idx((r) => r === head) < idx((r) => r.kind === "result"));
});

test("total spend counts the draws and not the repayment; the bank surplus stays bank-true", () => {
  const st = sep();
  const m = st.columns.findIndex((c) => c.key === "2026-09");
  const result = st.rows.find((r) => r.kind === "result");
  // Operating: draws −9,777,556 + repayment offset +6,460,103 + transport −100,000.
  assert.equal(result.values[m], -(9777556 - 6460103) - 100000);
  const total = st.rows.find((r) => r.kind === "total");
  assert.equal(total.values[m], -(6460103 + 100000), "Cash Surplus is the bank movement only — a draw never touched a bank");
});

test("a voided draw cancels its own supplier row; a lineLabel never changes an account's section", () => {
  const st = cf.buildStatement({
    classified: [
      leg("310-0020", 3032088, 0, "NLY SDN BHD (via TF)", "PV-2609-006"),
      leg("310-0020", 0, 3032088, "NLY SDN BHD (via TF)", "PV-2609-006", "supplier_payment_void"),
      leg("900-0001", 5000, 0, "Named by the caller", "pv-1", "payment_voucher"),
    ],
    bankLegs: [{ accountCode: "310-0010", debitSen: 0, creditSen: 5000, ym: "2026-09" }],
    coa, map: TF, rmSplit: {}, stockGroupOverride: {}, fyeMonth: 8, period: "2026-09",
  });
  const m = st.columns.findIndex((c) => c.key === "2026-09");
  const nly = st.rows.find((r) => r.kind === "line" && r.label === "NLY SDN BHD (via TF)");
  assert.equal(nly.values[m] || 0, 0); // display sign leaves a -0 behind; strict equal cares
  const named = st.rows.find((r) => r.kind === "line" && r.label === "Named by the caller");
  assert.equal(named.section, "GENERAL_EXPENSE");
  assert.equal(named.accountCode, "900-0001");
});

// The caller (computeCashflowStatement) — source-scan, house style.
const api = readFileSync("src/api/routes/accounting.ts", "utf8").replace(/\r\n/g, "\n");
const body = api.slice(api.indexOf("async function computeCashflowStatement("), api.indexOf('app.get("/cashflow-statement"'));

test("the statement learns the facility accounts from the trade-finance config, never a hard-coded code", () => {
  assert.match(body, /const tfSources = await getTfSources\(c\.var\.DB\)\.catch\(\(\) => \[\] as TfSource\[\]\);/);
  assert.match(body, /for \(const s of tfSources\) tfAccounts\.set\(resolveAcct\(s\.accountCode\), s\);/);
  assert.doesNotMatch(body, /310-0020/);
  // The facility account lands in the block unless the owner dragged it elsewhere.
  assert.match(body, /if \(!map\[code\]\) map\[code\] = \{ section: "TRADE_FINANCE", order: 10 \};/);
});

test("a draw (no bank leg) becomes a positive supplier row; a repayment (bank leg) is flipped to the offset", () => {
  // From the no-bank gate to the main per-leg loop (the draw road has its own
  // inner `for (const l of legs)`, so take the SECOND occurrence).
  const a = body.indexOf("if (!hasBank) {");
  const inner = body.indexOf("for (const l of legs) {", a);
  const draw = body.slice(a, body.indexOf("for (const l of legs) {", inner + 10));
  assert.match(draw, /const net = l\.creditSen - l\.debitSen;/, "CR on the facility = drawn; a void's DR reversal nets it out");
  assert.match(draw, /debitSen: net > 0 \? net : 0, creditSen: net < 0 \? -net : 0,/);
  assert.match(draw, /\(via TF\)`/);
  assert.match(draw, /if \(tfAccounts\.size && !opening\)/, "an opening balance on the facility is not a draw");
  const repay = body.slice(body.indexOf("if (tfAccounts.has(l.code)) {"), body.indexOf('if (l.sourceType.startsWith("other_party_payment"))'));
  assert.match(repay, /accountCode: l\.code, debitSen: l\.creditSen, creditSen: l\.debitSen,/, "flipped: the real leg is DR facility");
  assert.match(repay, /lineLabel: `Repaid to \$\{tfAccounts\.get\(l\.code\)!\.lenderName \|\| "lender"\}`/);
  assert.match(repay, /continue;\s*\n\s*\}\s*$/, "a repayment never reaches paymentNos / the raw-material split");
  // Supplier names for the draw rows come from the payment itself.
  assert.match(body, /SELECT payment_no, MAX\(supplier_name\) AS supplier_name FROM supplier_payments WHERE org_id = \? GROUP BY payment_no/);
});
