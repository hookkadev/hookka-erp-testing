// GRN stock must land on the raw material the PO line ordered.
//
// A PO-sourced GRN line stores a blank material_code (BUG-2026-08-13-052), so
// resolveRmForGRNItem fell through to `description = ? LIMIT 1`. Five raw
// materials are named "WHITE SPONGE"; receiving NLY-D12-6MM posted 140 units
// onto D12-0.5 (measured on staging, 2026-09-24). resolveRmForGRNItem is
// module-private, so this pins the source; the live check in the bug entry
// (BUG-2026-09-24-202) drove the real route against the real rows.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync("src/api/routes/grn.ts", "utf8");
const resolver = SRC.slice(
  SRC.indexOf("async function resolveRmForGRNItem("),
  SRC.indexOf("async function buildGRNStockStatements("),
);

test("the PO line's own item code is tried FIRST", () => {
  const poIdx = resolver.indexOf("FROM purchase_order_items poi");
  assert.ok(poIdx !== -1, "must resolve through the PO line");
  assert.match(resolver, /JOIN raw_materials rm ON rm\.itemCode = poi\.materialCode/);
  assert.ok(poIdx < resolver.indexOf("dashIdx"), "before the name-based guesses");
});

test("a description shared by several raw materials resolves to NOTHING, never the first match", () => {
  assert.doesNotMatch(resolver, /WHERE description = \? LIMIT 1/);
  assert.match(resolver, /matches\.length === 1 \? matches\[0\] : null/);
});

test("both stock builders pass the GRN line's po_item_id through", () => {
  const build = SRC.slice(SRC.indexOf("async function buildGRNStockStatements("));
  assert.match(build, /item\.poItemId \?\? item\.po_item_id \?\? null/);
  // The born-POSTED create path hands its in-memory lines over with poItemId.
  assert.match(SRC, /unitPrice: i\.unitPrice,\s*\n\s*poItemId: i\.poItemId,/);
});

test("editing a POSTED line adjusts the raw material its batch was ORIGINALLY posted to", () => {
  const adj = SRC.slice(SRC.indexOf("async function buildPostedGRNStockAdjustment("));
  const batchLookup = adj.indexOf("SELECT rmId FROM rm_batches WHERE id = ?");
  assert.ok(batchLookup !== -1);
  assert.ok(batchLookup < adj.indexOf("resolveRmForGRNItem("), "resolve only when no batch exists");
});
