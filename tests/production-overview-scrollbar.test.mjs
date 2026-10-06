// ---------------------------------------------------------------------------
// production-overview-scrollbar.test.mjs — BUG-2026-10-06-260.
//
// The /production Overview Grid had a full-table-width up/down scroll box
// inside a left/right one, so the up/down scrollbar sat at the table's far
// right and only showed once you had scrolled all the way across. The grid
// body must be ONE box that scrolls both ways, with the header inside it.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PAGE = readFileSync(resolve(process.cwd(), "src/pages/production/index.tsx"), "utf8");
const grid = PAGE.slice(PAGE.indexOf('key="grid"'), PAGE.indexOf("renderRow=", PAGE.indexOf('key="grid"')));

test("the Grid body is one box that scrolls both ways, header inside it", () => {
  assert.ok(grid.length > 0, 'the key="grid" OverviewVirtualRows block exists');
  assert.match(grid, /header=\{overviewHeaderRow\}/);
  assert.match(grid, /className="overflow-auto"/);
  assert.doesNotMatch(grid, /overflow-x-hidden/, "an up/down-only body needs an outer side-scroller again");
  assert.doesNotMatch(grid, /minWidth/, "a full-table-width scroll box pushes its scrollbar off screen");
});

test("the Grid header stays on top while the body scrolls", () => {
  const header = PAGE.slice(PAGE.indexOf("const overviewHeaderRow = ("), PAGE.indexOf("const togglePill"));
  assert.match(header, /sticky top-0/);
});

test("OverviewVirtualRows renders the header inside its scroll box", () => {
  const host = PAGE.slice(PAGE.indexOf("function OverviewVirtualRows("));
  assert.match(host, /<div ref=\{scrollRef\}[^>]*>\s*\{header\}/);
});
