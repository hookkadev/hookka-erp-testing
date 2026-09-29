// ---------------------------------------------------------------------------
// tf-interest-account.test.mjs — BUG-2026-09-29-196.
//
// The trade-finance interest was posted to 900-I001, a code that already
// existed in the owner's AutoCount-style chart as "INCORPORATION EXPENSE
// WRITTEN OFF" (I002 / I003 are INTERNET CHARGES / INSURANCE EXPENSES). The
// `ON CONFLICT DO NOTHING` create never looked at the name, so the Sep'26
// P&L line "INCORPORATION EXPENSE WRITTEN OFF RM 1,637.08" was the
// trade-finance interest. Measured on prod 2026-09-29: 20 legs on 900-I001,
// every one of them tf_interest (DR 2,458.96 / CR 821.88).
//
// Pinned here: a free code under FINANCE COSTS, a name-checked create that
// refuses a foreign account, and the one-shot repoint (dry-run-able,
// idempotent) that moves the old legs.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const api = readFileSync("src/api/routes/accounting.ts", "utf8").replace(/\r\n/g, "\n");
const block = (from, to) => { const a = api.indexOf(from); assert.notEqual(a, -1, from); const b = api.indexOf(to, a + 1); return api.slice(a, b === -1 ? undefined : b); };

test("the interest account is a free code under FINANCE COSTS, never the collided 900-I001", () => {
  assert.match(api, /const TF_INTEREST_ACCT = \{ code: "900-I004", name: "INTEREST ON TRADE FINANCE", parentCode: "902-0000" \};/);
  assert.match(api, /const TF_INTEREST_LEGACY_ACCT = "900-I001";/);
  // 900-I001 survives only as the legacy constant and in the bug's own story.
  const mentions = api.match(/900-I001/g) ?? [];
  assert.ok(mentions.length <= 6, `900-I001 is referenced ${mentions.length} times — a live posting path is back?`);
});

test("the create is name-checked: a foreign account under our code refuses the post", () => {
  const ensure = block("async function ensureTfInterestAccount(", "// POST /trade-finance/interest-account-repoint");
  assert.match(ensure, /ON CONFLICT \(code\) DO NOTHING/);
  assert.match(ensure, /\.bind\(TF_INTEREST_ACCT\.code, TF_INTEREST_ACCT\.name, TF_INTEREST_ACCT\.parentCode\)/, "created under FINANCE COSTS");
  assert.match(ensure, /if \(name && name !== TF_INTEREST_ACCT\.name\) \{/);
  assert.match(ensure, /the interest cannot be posted there/);
  const put = block('app.put("/trade-finance/draw-interest"', "\napp.");
  assert.match(put, /const acctErr = await ensureTfInterestAccount\(c\.var\.DB\);\s*\n\s*if \(acctErr\) return c\.json\(\{ success: false, error: acctErr \}, 409\);/);
  assert.doesNotMatch(put, /INSERT INTO chart_of_accounts/, "the PUT no longer creates the account blindly");
});

test("the repoint moves ONLY tf_interest legs off the legacy code, dry-runs, and is idempotent", () => {
  const rp = block('app.post("/trade-finance/interest-account-repoint"', 'app.put("/trade-finance/draw-interest"');
  assert.match(rp, /const dry = c\.req\.query\("dry"\) === "1" \|\| c\.req\.query\("dry"\) === "true";/);
  assert.match(rp, /WHERE orgId = \? AND accountCode = \? AND sourceType LIKE 'tf_interest%'/);
  assert.match(rp, /UPDATE ledger_journal_entries SET accountCode = \?\s*\n\s*WHERE orgId = \? AND accountCode = \? AND sourceType LIKE 'tf_interest%'/);
  assert.match(rp, /\.bind\(TF_INTEREST_ACCT\.code, orgId, TF_INTEREST_LEGACY_ACCT\)\.run\(\);/);
  assert.match(rp, /if \(!dry && legs\.length\) \{/, "dry counts only; nothing to move is a no-op");
  assert.match(rp, /action: "interest-account-repoint"/, "audited");
  // The account must be proven ours BEFORE anything moves onto it.
  assert.ok(rp.indexOf("ensureTfInterestAccount(") < rp.indexOf("UPDATE ledger_journal_entries"));
});

test("the UI no longer names the collided code", () => {
  const ui = readFileSync("src/pages/accounting/tabs/TradeFinanceBlock.tsx", "utf8");
  assert.doesNotMatch(ui, /900-I001/);
});
