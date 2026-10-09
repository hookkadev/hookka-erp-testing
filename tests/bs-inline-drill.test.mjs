// ---------------------------------------------------------------------------
// bs-inline-drill.test.mjs — owner 2026-09-30: 「Balance sheet 也要这样点开看」
// (after the P&L and Cash Flow drills).
//
// Click a balance-sheet account's name → its balance at the end of the
// previous month, the month's ledger lines (the same columns as the P&L /
// Cash Flow drills: Date · Description · Other side · Ref. 1 · Ref. 2 ·
// Amount) and the balance at the end of the month, which is the sheet's
// figure. The endpoint picks legs exactly as the /pl balance sheet does.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const api = readFileSync("src/api/routes/accounting.ts", "utf8").replace(/\r\n/g, "\n");
const ui = readFileSync("src/pages/accounting/index.tsx", "utf8").replace(/\r\n/g, "\n");
const slice = (src, from, to) => { const a = src.indexOf(from); assert.notEqual(a, -1, from); const b = src.indexOf(to, a + 1); return src.slice(a, b === -1 ? undefined : b); };

test("GET /bs-drill picks legs the way the /pl balance sheet does", () => {
  const ep = slice(api, 'app.get("/bs-drill"', 'app.get("/pl-monthly"');
  const pl = slice(api, 'app.get("/pl", async', "// --- P&L by account");
  assert.match(ep, /requirePermission\(c, "accounting", "read"\)/);
  assert.match(ep, /period must be YYYY-MM/);
  // Same leg set: hidden out, same optional company filter as the sheet.
  assert.match(pl, /FROM ledger_journal_entries WHERE hidden = 0\$\{legWhere\}/);
  assert.match(ep, /FROM ledger_journal_entries WHERE hidden = 0\$\{legWhere\}/);
  assert.match(ep, /const coFilter = companyFilter\(c, "orgId"\);/);
  // Same dating and cut-off: by document date, pre-opening legs out, old codes resolved.
  assert.match(ep, /const dd = docDate\(l\.sourceType, l\.sourceId, l\.postedAt\); \/\/ by document date/);
  assert.match(ep, /if \(legBeforeOpening\(l\.sourceType, dd, openingDate\)\) continue;/);
  assert.match(ep, /if \(resolve\(l\.accountCode\) !== account\) continue;/);
  // Same side: the account's balance-sheet section decides the sign.
  assert.match(ep, /const section = bsSectionFor\(account, acct\.type, await getBsSectionMap\(db\)\);/);
  assert.match(ep, /const assetSide = bsSectionClass\(section\) === "asset";/);
  const sheet = slice(api, "// --- Balance sheet from the ledger", "// Un-closed P&L result");
  assert.match(sheet, /const bal = bsSectionClass\(section\) === "asset" \? dr - cr : cr - dr;/, "the sheet's own sign rule");
  // b/f = everything before the month, c/f = up to the month end, lines = the month.
  assert.match(ep, /if \(ym > period\) continue;/);
  assert.match(ep, /if \(ym < period\) \{ bf \+= v; continue; \}/);
  assert.match(ep, /tied: bf \+ moved === cf,/);
  // The same line builder as the P&L drill.
  assert.match(ep, /const lines = await buildDrillLines\(db, orgId, monthLegs, entryLegs, resolve, coa\);/);
  assert.match(ep, /is not a balance-sheet account/);
});

test("the sheet: an account's name opens the drill (not in Edit, not the unclosed-earnings line)", () => {
  const tab = slice(ui, "function BalanceSheetTab(", "\nfunction ");
  assert.match(tab, /const canDrill = !edit && e\.accountCode !== "NP-CURRENT";/);
  assert.match(tab, /const drillKey = `\$\{period\}\|\$\{company\}\|\$\{e\.accountCode\}`;/, "a new month / company starts closed");
  assert.match(tab, /<tr><td colSpan=\{3\} className="p-0"><BsDrillPanel period=\{period\} account=\{e\.accountCode\} company=\{company\} \/><\/td><\/tr>/);
  const panel = slice(ui, "function BsDrillPanel(", "\nfunction ");
  assert.match(panel, /fetch\(`\/api\/accounting\/bs-drill\?period=\$\{encodeURIComponent\(period\)\}&account=\$\{encodeURIComponent\(account\)\}\$\{orgIdParam\(company\)\}`\)/);
  for (const h of ["Date", "Description", "Other side", "Ref. 1", "Ref. 2", "Amount"]) assert.ok(panel.includes(`>${h}</th>`), `column ${h}`);
  assert.match(panel, /Balance b\/f · end of \{drillMonthLabel\(prevYmOf\(period\)\)\}/);
  assert.match(panel, /Balance c\/f · end of \{drillMonthLabel\(period\)\}/);
  assert.match(panel, /const signed = \(l: PlDrillLine\) => \(data\?\.assetSide \? l\.debitSen - l\.creditSen : l\.creditSen - l\.debitSen\);/);
});
