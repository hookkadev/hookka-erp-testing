// ---------------------------------------------------------------------------
// recorded-salary-net.test.mjs — BUG-2026-10-09-275. The P&L skips the payslip
// (report-layer) labour for any (month, account) the owner already recorded
// through the salary accrual. A Labour-tab post that was then UNposted still
// counted as recorded: the ledger nets to zero and the month showed no direct
// labour at all. Found on the owner's August, posted and unposted within a
// minute. The legs of one document — post, reversal, void, restate — are now
// netted before an account counts as recorded.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { recordedSalaryAccounts, salaryDocKey } from "../src/lib/recorded-salary.ts";

const ACCRUAL = "410-0010";
const leg = (sourceType, sourceId, accountCode, debitSen, creditSen, ym = "2026-08") => ({ sourceType, sourceId, accountCode, debitSen, creditSen, ym });
const post = (sid, ym, wages = 7000000, epf = 34450) => [
  leg("labor_post", sid, "750-0010", wages, 0, ym),
  leg("labor_post", sid, "750-0020", epf, 0, ym),
  leg("labor_post", sid, ACCRUAL, 0, wages + epf, ym),
];
const undo = (sid, ym, wages = 7000000, epf = 34450) => [
  leg("labor_post_reversal", sid, "750-0010", 0, wages, ym),
  leg("labor_post_reversal", sid, "750-0020", 0, epf, ym),
  leg("labor_post_reversal", sid, ACCRUAL, wages + epf, 0, ym),
];
const accts = (m, ym) => [...(m.get(ym) ?? [])].sort();

test("a Labour post records its debit accounts for its month", () => {
  const m = recordedSalaryAccounts(post("labor-2026-07", "2026-07"), ACCRUAL);
  assert.deepEqual(accts(m, "2026-07"), ["750-0020", "750-0010"].sort());
});

test("posted then unposted: nothing is recorded, so the payslip labour shows again", () => {
  const m = recordedSalaryAccounts([...post("labor-2026-08", "2026-08"), ...undo("labor-2026-08", "2026-08")], ACCRUAL);
  assert.deepEqual(accts(m, "2026-08"), []);
});

test("posted, unposted, posted again: recorded once more", () => {
  const legs = [...post("labor-2026-07", "2026-07", 6984745), ...undo("labor-2026-07", "2026-07", 6984745), ...post("labor-2026-07", "2026-07", 6947290)];
  assert.deepEqual(accts(recordedSalaryAccounts(legs, ACCRUAL), "2026-07"), ["750-0010", "750-0020"]);
});

test("a voided manual JV records nothing; a live one records its accounts", () => {
  const jv = (id, type, dr, cr) => [leg(type, id, "900-S002", dr, cr), leg(type, id, ACCRUAL, cr, dr)];
  const voided = [...jv("je-1", "manual", 5500000, 0), ...jv("je-1", "manual_reversal", 0, 5500000)];
  assert.deepEqual(accts(recordedSalaryAccounts(voided, ACCRUAL), "2026-08"), []);
  assert.deepEqual(accts(recordedSalaryAccounts(jv("je-2", "manual", 3823563, 0), ACCRUAL), "2026-08"), ["900-S002"]);
});

test("an edited (restated) entry counts as its new version only", () => {
  const legs = [
    leg("manual", "je-3", "750-0010", 100000, 0), leg("manual", "je-3", "900-S002", 50000, 0), leg("manual", "je-3", ACCRUAL, 0, 150000),
    leg("manual_restate_rev:1790000000000", "je-3", "750-0010", 0, 100000), leg("manual_restate_rev:1790000000000", "je-3", "900-S002", 0, 50000), leg("manual_restate_rev:1790000000000", "je-3", ACCRUAL, 150000, 0),
    leg("manual_restate_post:1790000000000", "je-3", "750-0010", 120000, 0), leg("manual_restate_post:1790000000000", "je-3", ACCRUAL, 0, 120000),
  ];
  assert.deepEqual(accts(recordedSalaryAccounts(legs, ACCRUAL), "2026-08"), ["750-0010"]);
});

test("an entry that accrues and pays at once still records its cost account", () => {
  const legs = [
    leg("payment_voucher", "pv-1", "750-0010", 287000, 0), leg("payment_voucher", "pv-1", ACCRUAL, 0, 287000),
    leg("payment_voucher_settle", "pv-1", ACCRUAL, 287000, 0), leg("payment_voucher_settle", "pv-1", "310-0010", 0, 287000),
  ];
  assert.deepEqual(accts(recordedSalaryAccounts(legs, ACCRUAL), "2026-08"), ["750-0010"]);
});

test("legs left out (pre-opening / opening) never record; other documents never mix in", () => {
  const legs = [
    ...post("labor-2026-05", null),
    leg("supplier_payment", "SP-1", "400-0000", 99900, 0), leg("supplier_payment", "SP-1", "310-0010", 0, 99900),
  ];
  assert.equal(recordedSalaryAccounts(legs, ACCRUAL).size, 0);
  assert.equal(salaryDocKey("labor_post_reversal", "labor-2026-08"), salaryDocKey("labor_post", "labor-2026-08"));
  assert.equal(salaryDocKey("manual_restate_post:17", "je-3:edit-1"), "manual::je-3");
});

test("both P&L readers use the netted rule", () => {
  const src = readFileSync("src/api/routes/accounting.ts", "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /const recordedSalaryAccts = recordedSalaryAccounts\(salaryLegsIn\(legRes\.results \?\? \[\], resolve, docDate, obDate\), LABOUR_ACCRUAL_ACCT\);/);
  assert.match(src, /const recordedSalaryAcctsCec = recordedSalaryAccounts\(salaryLegsIn\(legRes\.results \?\? \[\], resolve, docDate, obDateCec\), LABOUR_ACCRUAL_ACCT\);/);
  assert.doesNotMatch(src, /salaryEntryYm/, "the old first-leg-only rule is gone");
  // Same exclusions as before: pre-opening and opening legs never record.
  assert.match(src, /const skip = legBeforeOpening\(l\.sourceType, dd, obDate\) \|\| isOpeningSource\(l\.sourceType\);/);
});
