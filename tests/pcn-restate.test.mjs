// ---------------------------------------------------------------------------
// pcn-restate.test.mjs — Supplier Discount Edit-in-place (owner 2026-09-21:
// "the history part make the row editable... dont just show cancelled and
// type it again"). Static source-inspection, same style as
// pcn-void-status-check.test.mjs — no DB in this test env, so this locks the
// SHAPE of the restate/void SQL rather than executing it.
//
// The restate endpoint mirrors the other-party-bill / payment-voucher
// pattern: reverse whichever GL legs are currently `hidden = 0` (the
// original post, or a prior restate — never more than one live set), post
// corrected legs under a freshly stamped source, hide everything else. The
// void handler has to use the SAME "currently visible" lookup — otherwise
// cancelling a note that was edited first would reverse the wrong (stale,
// already-hidden) legs and leave the corrected ones live in the GL forever.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");
const ROUTE = read("src/api/routes/accounting.ts");

function routeBlock(startMarker, endMarker) {
  const start = ROUTE.indexOf(startMarker);
  assert.ok(start >= 0, `${startMarker} must exist`);
  const end = endMarker ? ROUTE.indexOf(endMarker, start) : ROUTE.indexOf('app.post("/purchase-credit-notes', start + 1);
  assert.ok(end > start, `could not find the end of the block starting at ${startMarker}`);
  return ROUTE.slice(start, end);
}

test("ledger_journal_entries.hidden is self-applied, not assumed present", () => {
  const start = ROUTE.indexOf("function ensurePcnCancellable");
  const end = ROUTE.indexOf("\n}", start);
  const block = ROUTE.slice(start, end);
  assert.match(block, /ADD COLUMN IF NOT EXISTS hidden INTEGER NOT NULL DEFAULT 0/);
});

test("the restate route exists and only allows editing a POSTED note", () => {
  const block = routeBlock('app.post("/purchase-credit-notes/:id/restate"');
  assert.match(block, /existing\.status !== "POSTED"/);
});

test("restate reverses whatever is CURRENTLY visible, not a hardcoded original sourceType", () => {
  const block = routeBlock('app.post("/purchase-credit-notes/:id/restate"');
  assert.match(
    block,
    /hidden = 0 AND sourceType LIKE 'purchase_credit_note%'/,
    "must look up by hidden=0 + LIKE prefix so a second edit reverses the FIRST edit's legs, not the original",
  );
});

test("restate hides every prior source except the fresh post", () => {
  const block = routeBlock('app.post("/purchase-credit-notes/:id/restate"');
  assert.match(block, /SET hidden = 1/);
  assert.match(
    block,
    /sourceType LIKE 'purchase_credit_note%' AND sourceType <> \?/,
    "the hide-sweep must exclude the just-inserted postSource, or the edit would hide itself",
  );
});

test("restate refuses to drop the total below what's already allocated to PIs", () => {
  const block = routeBlock('app.post("/purchase-credit-notes/:id/restate"');
  assert.match(block, /SUM\(booked_sen\)/);
  assert.match(block, /totalAmount < allocatedSen/);
});

test("restate adjusts supplier.outstandingSen by the DELTA, not the new total alone", () => {
  const block = routeBlock('app.post("/purchase-credit-notes/:id/restate"');
  assert.match(
    block,
    /outstandingSen = GREATEST\(0, outstandingSen \+ \? - \?\)/,
    "must undo the OLD gross and apply the NEW one — not just subtract the new total again",
  );
});

test("void is restate-aware: it also reads hidden=0 + LIKE, and hides everything after reversing", () => {
  const voidStart = ROUTE.indexOf('app.post("/purchase-credit-notes/:id/void"');
  const voidEnd = ROUTE.indexOf('app.get("/purchase-credit-notes', voidStart);
  const block = ROUTE.slice(voidStart, voidEnd);
  assert.match(
    block,
    /hidden = 0 AND sourceType LIKE 'purchase_credit_note%'/,
    "void must find the CURRENTLY live legs (original OR a prior restate), not sourceType = 'purchase_credit_note' only",
  );
  assert.match(
    block,
    /SET hidden = 1 WHERE sourceId = \? AND orgId = \? AND sourceType LIKE 'purchase_credit_note%'/,
    "cancelling must hide the whole family (original/restated + the void reversal) so nothing of a cancelled note stays visible",
  );
});

test("the frontend's row actions are Edit + Cancel, not a raw Void button", () => {
  const FE = read("src/pages/accounting/index.tsx");
  const tabStart = FE.indexOf("function SupplierDiscountTab");
  const tabEnd = FE.indexOf("\nfunction ", tabStart + 1);
  const block = FE.slice(tabStart, tabEnd);
  assert.doesNotMatch(block, />Void</, "owner rule: no button may read \"Void\" or \"Delete\" — Cancel only");
  assert.doesNotMatch(block, />Delete</);
  assert.match(block, />Edit</);
  assert.match(block, />Cancel</);
  assert.match(block, /\/restate`/, "Edit must POST to the restate endpoint");
});

test("the history list keeps CANCELLED rows visible (only DRAFT is hidden)", () => {
  const FE = read("src/pages/accounting/index.tsx");
  const tabStart = FE.indexOf("function SupplierDiscountTab");
  const visLine = FE.slice(tabStart, FE.indexOf("\n", FE.indexOf("visibleHistory = history.filter", tabStart)));
  assert.match(visLine, /"DRAFT"/);
  assert.doesNotMatch(visLine, /"CANCELLED"/, "owner 2026-09-21: a cancelled row shows its CANCELLED status, it is not removed");
});

test("Edit is inline in the history row, not the top entry form", () => {
  const FE = read("src/pages/accounting/index.tsx");
  const tabStart = FE.indexOf("function SupplierDiscountTab");
  const block = FE.slice(tabStart, FE.indexOf("\nfunction ", tabStart + 1));
  assert.match(block, /const saveEdit = async/);
  assert.match(block, /editingId === n\.id/, "the row itself swaps to inputs");
  assert.doesNotMatch(block, /disabled=\{!!editingId\}/, "the top form must not have an edit mode");
  assert.doesNotMatch(block, /supplierId && !editingId/);
});
