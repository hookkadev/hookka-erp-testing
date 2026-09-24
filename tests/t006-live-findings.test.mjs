// T-006 — what a live run against the staging DB (2026-09-24) found that the
// mocked tests passed. Two root causes:
//   * The real Postgres client camelCases every column it returns
//     (db-pg.ts columnFrom: accepted_qty → acceptedQty). The earlier mocks
//     returned snake_case keys, so snake-only reads looked fine in CI and were
//     always undefined in production. The fake DB below returns camelCase,
//     like the real one.
//   * Postgres types: grn_items.id is BIGINT, every *_grn_item_id is TEXT, and
//     there is no bigint = text operator. A mock can't see that — so it's
//     pinned here source-side.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on newer Node.
}
const load = (p) => import(pathToFileURL(resolve(process.cwd(), p)).href);
const { createPurchaseReturn, deletePurchaseReturnRestoreStatements } = await load(
  "src/api/lib/purchase-return-create.ts",
);
const { buildInvoiceDeathCnReleaseStatements } = await load(
  "src/api/lib/consignment-note-shared.ts",
);

// Answers by SQL pattern with camelCase rows (what db-pg.ts hands a route).
function camelDb(answers) {
  const batches = [];
  const stmt = (sql, args = []) => ({
    sql,
    args,
    bind: (...a) => stmt(sql, a),
    async run() { return { success: true, meta: {} }; },
    async first() {
      for (const [re, fn] of answers) if (re.test(sql)) return fn(args)?.[0] ?? null;
      return null;
    },
    async all() {
      for (const [re, fn] of answers) if (re.test(sql)) return { results: fn(args) ?? [] };
      return { results: [] };
    },
  });
  return { batches, prepare: (sql) => stmt(sql), async batch(s) { batches.push(s); return []; } };
}

const grnLine = [/FROM grn_items WHERE id = \?/, () => [{ acceptedQty: 10, poItemId: "poi-1" }]];
const noPriorReturns = [/FROM purchase_return_items WHERE grn_item_id/, () => [{ qty: 0 }]];

test("purchase return reads acceptedQty from a camelCased row (was always 0 → every return refused)", async () => {
  const db = camelDb([grnLine, noPriorReturns]);
  const res = await createPurchaseReturn(db, {
    grnId: "grn-1",
    items: [{ grnItemId: "1153", materialName: "Foam", quantity: 1, unitCostSen: 100 }],
  });
  assert.equal(res.ok, true, res.error);
});

test("purchase return still refuses more than was accepted", async () => {
  const db = camelDb([grnLine, noPriorReturns]);
  const res = await createPurchaseReturn(db, {
    grnId: "grn-1",
    items: [{ grnItemId: "1153", materialName: "Foam", quantity: 11 }],
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /accepted 10/);
});

test("purchase return gives the PO line back its qty, and does NOT re-open the GRN line for billing", async () => {
  const db = camelDb([grnLine, noPriorReturns]);
  await createPurchaseReturn(db, {
    grnId: "grn-1",
    items: [{ grnItemId: "1153", materialName: "Foam", quantity: 2 }],
  });
  const stmts = db.batches[0];
  const po = stmts.find((s) => /UPDATE purchase_order_items SET receivedQty/.test(s.sql));
  assert.ok(po, "the PO counter write-back must be in the batch");
  assert.deepEqual(po.args, [2, "poi-1"], "poItemId comes off the camelCased row");
  assert.ok(
    !stmts.some((s) => /UPDATE grn_items SET invoiced_qty/.test(s.sql)),
    "lowering invoiced_qty let the returned goods be invoiced a second time",
  );
});

test("deleting an OPEN return puts the PO line's receivedQty back", async () => {
  const db = camelDb([
    [/FROM purchase_return_items pri/, () => [{ poItemId: "poi-1", qty: 2 }]],
  ]);
  const stmts = await deletePurchaseReturnRestoreStatements(db, "pr-1");
  assert.equal(stmts.length, 1);
  assert.match(stmts[0].sql, /SET receivedQty = receivedQty \+ \?/);
  assert.deepEqual(stmts[0].args, [2, "poi-1"]);
});

test("the purchase-returns DELETE route restores the counter in the same batch as the delete", () => {
  const src = readFileSync("src/api/routes/purchase-returns.ts", "utf8");
  const del = src.slice(src.indexOf('app.delete("/:id"'));
  assert.match(del, /deletePurchaseReturnRestoreStatements\(c\.var\.DB, id\)/);
  assert.match(del, /c\.var\.DB\.batch\(\[/);
});

test("R4 release restores the status the CN had, read off a camelCased row", async () => {
  const db = camelDb([
    [/FROM consignment_notes WHERE convertedInvoiceId/, () => [{ id: "cn-1", statusBeforeConversion: "ACTIVE" }]],
  ]);
  const [stmt] = await buildInvoiceDeathCnReleaseStatements(db, { invoiceId: "inv-1" });
  assert.equal(stmt.args[0], "ACTIVE", "was always PARTIALLY_SOLD");
  assert.equal(stmt.args.at(-1), "cn-1");
});

test("R4 release undoes exactly what the conversion did — items back AT_BRANCH, units back LOADED", async () => {
  const at = "2026-09-24T02:00:00.000Z"; // convert's `now`, stamped on invoice + items + units
  const db = camelDb([
    [/FROM consignment_notes WHERE convertedInvoiceId/, () => [{ id: "cn-1", statusBeforeConversion: "ACTIVE" }]],
    [/SELECT created_at FROM invoices/, () => [{ createdAt: at }]],
    [/FROM fg_units/, () => [{ id: "fgu-1", status: "DELIVERED", productCode: "SOFA", cnId: "cn-1" }]],
  ]);
  const stmts = await buildInvoiceDeathCnReleaseStatements(db, { invoiceId: "inv-1" });
  const items = stmts.find((s) => /UPDATE consignment_items SET status = 'AT_BRANCH'/.test(s.sql));
  assert.ok(items, "items flipped SOLD by the convert go back AT_BRANCH");
  assert.deepEqual(items.args, ["cn-1", at], "matched on the convert stamp, not every SOLD item");
  const units = stmts.find((s) => /UPDATE fg_units SET status = 'LOADED'/.test(s.sql));
  assert.ok(units, "units flipped DELIVERED by the convert go back LOADED");
  assert.deepEqual(units.args, ["cn-1", at]);
  assert.ok(stmts.some((s) => /fg_stock_events/i.test(s.sql)), "the unit move is written to the FG ledger");
});

test("R4 release without a convert stamp touches only the CN header", async () => {
  const db = camelDb([
    [/FROM consignment_notes WHERE convertedInvoiceId/, () => [{ id: "cn-1", statusBeforeConversion: "ACTIVE" }]],
  ]);
  const stmts = await buildInvoiceDeathCnReleaseStatements(db, { invoiceId: "inv-1" });
  assert.equal(stmts.length, 1);
});

test("deleting a CN-sourced draft invoice releases the CN too, not only a void", () => {
  const src = readFileSync("src/api/routes/invoices.ts", "utf8");
  const del = src.slice(src.indexOf('app.delete("/:id"'));
  const releaseIdx = del.indexOf("buildInvoiceDeathCnReleaseStatements(c.var.DB");
  const batchIdx = del.indexOf("await c.var.DB.batch(stmts)");
  assert.ok(releaseIdx !== -1 && releaseIdx < batchIdx, "release must be built into the delete batch");
});

test("no join compares grn_items.id (BIGINT) to a TEXT grn_item_id without a cast", () => {
  for (const f of [
    "src/api/routes/purchase-invoices.ts",
    "src/api/lib/purchase-return-create.ts",
  ]) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /\bgi\.id\s*=\s*\w+\.grn_item_id/, `${f}: needs gi.id::text`);
  }
});

test("no UPDATE customers writes updated_at — the column does not exist (CN convert 400'd)", () => {
  const src = readFileSync("src/api/routes/consignment-notes.ts", "utf8");
  for (const m of src.matchAll(/UPDATE customers[\s\S]*?WHERE/g)) {
    assert.doesNotMatch(m[0], /updated_at/);
  }
});
