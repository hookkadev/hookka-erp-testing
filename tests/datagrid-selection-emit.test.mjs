// BUG-2026-09-22-005 / BUG-CLASSES C24 — a selectable DataGrid must not
// re-emit an unchanged selection, and no page may rebuild its `columns` from
// the selection state it stores off that emission. Either half alone reopens
// the loop that froze the delivery page's Pending Delivery tab:
//   emit → parent stores a fresh Set → columns memo re-runs → DataGrid's
//   sortedData (always `[...filteredData]`) is new → effect → emit → …
// No DOM test runner in this repo, so this pins the two guards at source.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("DataGrid emits onSelectionChange only when the selected rows actually changed", () => {
  const grid = read("../src/components/ui/data-grid.tsx");
  const effect = grid.slice(grid.indexOf("const lastEmittedSelection"), grid.indexOf("}, [selectedKeys, sortedData]);"));
  assert.ok(effect.length > 0, "selection effect not found");
  assert.match(effect, /prev\.length === selected\.length && prev\.every\(\(row, i\) => row === selected\[i\]\)/);
  assert.match(effect, /lastEmittedSelection\.current = selected;\s*onSelectionChange\(selected\);/);
});

test("no page rebuilds a selectable grid's columns from the selection it stores", () => {
  const page = read("../src/pages/delivery/index.tsx");
  const memo = page.slice(page.indexOf("const pendingDeliveryColumns"), page.indexOf("// ---------- DO Columns ----------"));
  assert.ok(memo.length > 0);
  assert.doesNotMatch(memo, /\[selectedReadyPOs, updateExpectedDD\]/);
  assert.match(memo, /\[updateExpectedDD\]\s*\);\s*$/);
});
