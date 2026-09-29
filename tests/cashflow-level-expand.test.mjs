// ---------------------------------------------------------------------------
// cashflow-level-expand.test.mjs — owner 2026-09-29 「这些我希望我按了 L2 我还是
// 能自己点开」: on the Cash Flow statement, L1–L4 set the collapse baseline
// only. The old `r.depth <= level` gate hid every row deeper than the level
// even after the owner clicked a group open, so at L2 the caret flipped and
// nothing appeared. Now a level collapses every group whose children sit
// deeper than it, and visibility is decided by the collapse set alone.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const ui = readFileSync("src/pages/accounting/index.tsx", "utf8").replace(/\r\n/g, "\n");
const cf = ui.slice(ui.indexOf("function CashFlowTab()"), ui.indexOf("function CashFlowTab()") + 60000);

test("a level only sets the baseline: groups at depth >= L start collapsed, nothing else", () => {
  const fn = cf.slice(cf.indexOf("const cfCollapseForLevel = "), cf.indexOf("const applyLevel = "));
  assert.match(fn, /if \(r\.kind === "group" && r\.groupId && r\.depth >= L\) s\.add\(r\.groupId\);/);
  assert.doesNotMatch(fn, /if \(L >= 3\) return s;/, "L3 used to short-circuit; the rule is uniform now");
  assert.match(cf, /const applyLevel = \(L: number\) => \{ setCollapsed\(cfCollapseForLevel\(rows, L\)\); setLevel\(L\); \};/);
});

test("visibility is the collapse set alone — no depth gate swallows a click", () => {
  assert.match(cf, /const visibleRows = \(edit \? rows : cleanRows\)\.filter\(\(r\) => !hiddenByCollapse\(r\)\);/);
  assert.doesNotMatch(cf, /r\.depth <= \(level >= 3 \? 9 : level\)/, "the depth gate is back");
  // A group row still toggles its own id on click (outside Edit mode).
  assert.match(cf, /onClick=\{isGroup && !edit \? \(\) => \{ const n = new Set\(collapsed\); if \(n\.has\(r\.groupId!\)\) n\.delete\(r\.groupId!\); else n\.add\(r\.groupId!\); setCollapsed\(n\); \} : undefined\}/);
});
