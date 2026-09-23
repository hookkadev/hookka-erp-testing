// ---------------------------------------------------------------------------
// so-duplicate-ref-draft.test.mjs — DEV-12 (2026-09-23).
//
// A scanned PO whose customer S/O no. (e.g. HC-SO-013492) was already on an
// earlier SO for the same customer was rejected by POST /api/sales-orders
// (409), and the PO-scan modal then consumed the scan anyway — the order was
// lost instead of saved. Now: the SO is saved as DRAFT with a warning, a
// failed create leaves its scan in the queue, and a true duplicate customer PO
// still cannot be CONFIRMED (BR-SO-010).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");
const SO = read("src/api/routes/sales-orders.ts");
const MODAL = read("src/components/scan-po-modal.tsx");
const CREATE = read("src/pages/sales/create.tsx");

test("create no longer rejects a repeated customer PO/SO reference", () => {
  assert.doesNotMatch(SO, /looks like a duplicate/, "the 409 rejection must be gone");
  assert.match(SO, /duplicateWarning = \{/);
  assert.match(
    SO,
    /return c\.json\(\{ success: true, data: created, \.\.\.duplicateWarning \}, 201\)/,
    "the created SO must carry the duplicate warning back to the caller",
  );
});

test("confirm still blocks a true duplicate customer PO (BR-SO-010)", () => {
  assert.match(SO, /Customer PO \$\{existing\.customerPOId\} already exists on/);
});

test("scan modal only consumes scans whose SO was created", () => {
  assert.match(MODAL, /createdRows\.add\(row\)/);
  assert.match(MODAL, /if \(!row\.scanQueueRowId \|\| !createdRows\.has\(row\)\) continue;/);
  assert.match(MODAL, /if \(data\.warning\) errs\.push\(`⚠/);
});

test("manual Create Order does not auto-confirm a duplicate-reference SO", () => {
  assert.match(CREATE, /if \(status === "CONFIRMED" && newId && !data\.warning\)/);
});
