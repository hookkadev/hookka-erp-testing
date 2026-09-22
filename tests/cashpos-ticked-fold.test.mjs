// ---------------------------------------------------------------------------
// cashpos-ticked-fold.test.mjs — Daily Cash Position: a ticked row (seen in
// the banking app) leaves the pending list and folds under a per-account
// count (owner 2026-09-22 「这些 tick 了还需要出现吗？」→「做」). The fold opens
// to review or untick; the maths never depended on the rows being visible.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const ui = readFileSync("src/pages/accounting/index.tsx", "utf8").replace(/\r\n/g, "\n");
const tab = ui.slice(ui.indexOf("function DailyCashTab("), ui.indexOf("function DailyCashTab(") + 40000);

test("pending list shows only unticked rows; ticked ones fold under a count", () => {
  assert.match(tab, /const open = a\.pending\.filter\(\(p\) => !p\.ticked\);/);
  assert.match(tab, /const ticked = a\.pending\.filter\(\(p\) => p\.ticked\);/);
  assert.match(tab, /\{open\.map\(row\)\}/);
  assert.match(tab, /\{showing && ticked\.map\(row\)\}/, "ticked rows render only when the fold is open");
  assert.match(tab, /✓ Ticked as gone through: \{ticked\.length\}/);
  assert.match(tab, /const \[showTicked, setShowTicked\] = useState<Record<string, boolean>>\(\{\}\);/, "fold state is per account");
});

test("the fold row still lets a mistake be unticked (same handler, same checkbox)", () => {
  // One row renderer for both halves — the checkbox + handleTick are shared.
  assert.equal((tab.match(/onChange=\{\(e\) => void handleTick\(a, p\.legId, e\.target\.checked\)\}/g) ?? []).length, 1);
  assert.match(tab, /Untick — it has NOT gone through after all/);
});

test("an account with everything ticked says so instead of showing an empty table", () => {
  assert.match(tab, /Nothing pending — everything booked has gone through the bank\./);
});
