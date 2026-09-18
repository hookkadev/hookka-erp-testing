// ---------------------------------------------------------------------------
// pcn-void-status-check.test.mjs — void 500'd because CANCELLED was never a
// legal purchase_credit_notes.status.
//
// migrations/0088 + migrations-postgres/0156 created the table with
// CHECK (status IN ('DRAFT','POSTED')). POST /purchase-credit-notes/:id/void
// has always written status='CANCELLED' — every void hit that constraint
// and 500'd (same class as BUG-2026-06-25-001's purchase_invoices.status
// CHECK, which has its own single-source-of-truth test in
// pi-status-check-single-source.test.mjs). Fix: a self-apply that drops the
// old constraint (both possible auto-generated names) and re-adds it with
// CANCELLED, run at the top of the void handler before the UPDATE.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");
const ROUTE = read("src/api/routes/accounting.ts");

function pcnStatusMigrationBlock() {
  const start = ROUTE.indexOf("function ensurePcnCancellable");
  assert.ok(start >= 0, "ensurePcnCancellable must exist");
  const end = ROUTE.indexOf("\n}", start);
  return ROUTE.slice(start, end);
}

test("the self-apply re-adds the constraint WITH CANCELLED", () => {
  const block = pcnStatusMigrationBlock();
  assert.match(block, /ADD CONSTRAINT purchase_credit_notes_status_chk/);
  assert.match(block, /CHECK \(status IN \([^)]*'CANCELLED'[^)]*\)\)/);
  assert.match(block, /'DRAFT'/);
  assert.match(block, /'POSTED'/);
});

test("both possible pre-existing constraint names are dropped before the re-add", () => {
  const block = pcnStatusMigrationBlock();
  for (const name of [
    "purchase_credit_notes_status_check", // 0088/0156's auto-named inline CHECK
    "purchase_credit_notes_status_chk", // this fix's own name, on re-run
  ]) {
    assert.ok(
      block.includes(`DROP CONSTRAINT IF EXISTS ${name}`),
      `${name} must be dropped first`,
    );
  }
  const dropIdx = block.lastIndexOf("DROP CONSTRAINT");
  const addIdx = block.indexOf("ADD CONSTRAINT");
  assert.ok(addIdx > dropIdx, "the ADD must come after every DROP");
});

test("the void handler runs the self-apply before writing CANCELLED", () => {
  const voidStart = ROUTE.indexOf('app.post("/purchase-credit-notes/:id/void"');
  assert.ok(voidStart >= 0, "the void route must exist");
  const cancelWriteIdx = ROUTE.indexOf("status = 'CANCELLED'", voidStart);
  const ensureCallIdx = ROUTE.indexOf("await ensurePcnCancellable(", voidStart);
  assert.ok(ensureCallIdx >= 0, "void must call ensurePcnCancellable");
  assert.ok(cancelWriteIdx >= 0, "void must write status = 'CANCELLED'");
  assert.ok(
    ensureCallIdx < cancelWriteIdx,
    "the constraint must be relaxed before the CANCELLED write is queued",
  );
});
