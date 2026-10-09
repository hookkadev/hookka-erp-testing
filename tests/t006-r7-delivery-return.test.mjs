// T-006 R7 — Delivery Return had three holes:
//   1. No cap: the same DO line could be returned twice, or returned more
//      than was ever delivered.
//   2. Whole-line exclusion: computeDoInvoiceLines dropped a line ENTIRELY
//      the moment ANY return touched it (a Set<productionOrderId>
//      membership filter) — so returning 1 of 3 left 0 invoiceable, not 2.
//   3. Cancel-after-restock: a return already in RETURNED_TO_STOCK (stock
//      was credited back) could still be cancelled with no reversal,
//      overstating stock by whatever it put back.
//
// (1) and (3) are source-static (no live D1 in CI). (2) is exercised for
// real against computeDoInvoiceLines with a mocked D1, matching PRD
// acceptance A7 exactly: DO line qty 3, return 1, invoiceable qty is 2.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

const CREATE_SRC = read("src/api/lib/delivery-return-create.ts");
const RETURNS_SRC = read("src/api/routes/delivery-returns.ts");
const HELPERS_SRC = read("src/api/routes/delivery-orders/_helpers.ts");

// ===========================================================================
// 1. Cap + duplicate guard (delivery-return-create.ts)
// ===========================================================================

test("a return is capped at what the DO line actually delivered, cumulative across prior returns", () => {
  const fn = CREATE_SRC.slice(CREATE_SRC.indexOf("export async function createDeliveryReturnRecord"));
  assert.match(
    fn,
    /FROM delivery_return_items dri\s*\n\s*JOIN delivery_returns dr ON dr\.id = dri\.delivery_return_id\s*\n\s*WHERE dr\.delivery_order_id = \? AND dr\.status <> 'CANCELLED'/,
  );
  assert.match(fn, /if \(priorReturned \+ thisReturn > doLineQty\)/);
  // Rejected before the insert batch runs.
  const rejectIdx = fn.indexOf("if (priorReturned + thisReturn > doLineQty)");
  const batchIdx = fn.indexOf("await db.batch(statements)");
  assert.ok(rejectIdx < batchIdx, "the cap check must run before anything is written");
});

test("createDeliveryReturnRecord returns ok:false on cap violation instead of null", () => {
  const fn = CREATE_SRC.slice(CREATE_SRC.indexOf("export async function createDeliveryReturnRecord"));
  assert.match(fn, /return \{\s*ok: false,\s*error: `Return exceeds/);
  assert.match(fn, /return \{ ok: true, id, returnNo \};/);
  assert.doesNotMatch(fn, /return null;/);
});

test("the office route surfaces a cap rejection as 409 (a bad request as 400) with the real error", () => {
  assert.match(RETURNS_SRC, /if \(!created\.ok\) \{\s*\n\s*return c\.json\(\{ success: false, error: created\.error \}, created\.status \?\? 409\);/);
});

// ===========================================================================
// 2. Partial exclusion, not whole-line (delivery-orders/_helpers.ts,
//    computeDoInvoiceLines) — exercised live against a mocked D1.
// ===========================================================================

const { computeDoInvoiceLines } = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/routes/delivery-orders/_helpers.ts")).href
);

function book() {
  return {
    deliveryOrders: [{ id: "do-1", orgId: "hookka", salesOrderId: "so-1" }],
    doItems: [
      { id: "di-1", deliveryOrderId: "do-1", productionOrderId: "po-1", productCode: "CHAIR", productName: "Chair", sizeLabel: "", fabricCode: "", quantity: 3, invoiced_qty: 0 },
    ],
    prodOrders: [
      { id: "po-1", orgId: "hookka", salesOrderId: "so-1", productCode: "CHAIR", sizeCode: "", fabricCode: "" },
    ],
    soItems: [
      { salesOrderId: "so-1", productCode: "CHAIR", sizeCode: "", fabricCode: "", unitPriceSen: 10000, quantity: 3, lineTotalSen: 30000 },
    ],
    returnedQtyByPoId: {}, // populated per-test
  };
}

function fakeDb(b) {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  return {
    prepare(sql) {
      const q = norm(sql);
      return {
        async run() { return { success: true }; }, // DDL self-applies
        bind(...args) {
          return {
            async first() {
              if (/SELECT orgId, salesOrderId FROM delivery_orders WHERE id = \?/.test(q)) {
                return b.deliveryOrders.find((d) => d.id === args[0]) ?? null;
              }
              throw new Error("unexpected first(): " + q);
            },
            async all() {
              if (/FROM delivery_order_items WHERE deliveryOrderId = \?/.test(q)) {
                return {
                  results: b.doItems
                    .filter((d) => d.deliveryOrderId === args[0])
                    .map((d) => ({ ...d, invoicedQty: d.invoiced_qty })),
                };
              }
              if (/FROM delivery_return_items dri/.test(q)) {
                return {
                  results: Object.entries(b.returnedQtyByPoId).map(([poId, qty]) => ({
                    poId,
                    qty,
                  })),
                };
              }
              if (/FROM production_orders WHERE orgId = \?/.test(q)) {
                return { results: b.prodOrders.filter((p) => p.orgId === args[0]) };
              }
              if (/FROM sales_order_items si JOIN sales_orders s/.test(q)) {
                return { results: b.soItems };
              }
              if (/FROM sales_order_items WHERE salesOrderId IN/.test(q)) {
                return { results: b.soItems.filter((si) => args.includes(si.salesOrderId)) };
              }
              throw new Error("unexpected all(): " + q);
            },
          };
        },
      };
    },
  };
}

test("A7 — DO line qty 3, no return, invoiceable qty is 3", async () => {
  const b = book();
  const db = fakeDb(b);
  const { invItems } = await computeDoInvoiceLines(db, "do-1", ["so-1"], null);
  assert.equal(invItems.length, 1);
  assert.equal(invItems[0].quantity, 3);
});

test("A7 — DO line qty 3, return 1, invoiceable qty is 2 (not 0, not 3)", async () => {
  const b = book();
  b.returnedQtyByPoId["po-1"] = 1;
  const db = fakeDb(b);
  const { invItems } = await computeDoInvoiceLines(db, "do-1", ["so-1"], null);
  assert.equal(invItems.length, 1, "the line must still appear — a partial return does not drop it");
  assert.equal(invItems[0].quantity, 2);
});

test("A7 — a return of the WHOLE line zeroes just that line, a sibling line is unaffected", async () => {
  // A second, untouched line keeps computedTotal > 0 so this test stays on
  // the per-line drawdown path (a DO with only one line, fully returned,
  // hits a separate pre-existing "nothing priced → bill the SO directly"
  // fallback that predates and is unrelated to this fix).
  const b = book();
  b.doItems.push({ id: "di-2", deliveryOrderId: "do-1", productionOrderId: "po-2", productCode: "TABLE", productName: "Table", sizeLabel: "", fabricCode: "", quantity: 2, invoiced_qty: 0 });
  b.prodOrders.push({ id: "po-2", orgId: "hookka", salesOrderId: "so-1", productCode: "TABLE", sizeCode: "", fabricCode: "" });
  b.soItems.push({ salesOrderId: "so-1", productCode: "TABLE", sizeCode: "", fabricCode: "", unitPriceSen: 5000, quantity: 2, lineTotalSen: 10000 });
  b.returnedQtyByPoId["po-1"] = 3;
  const db = fakeDb(b);
  const { invItems } = await computeDoInvoiceLines(db, "do-1", ["so-1"], null);
  const chair = invItems.find((i) => i.productCode === "CHAIR");
  const table = invItems.find((i) => i.productCode === "TABLE");
  assert.equal(chair, undefined, "the fully-returned line must not bill anything");
  assert.equal(table.quantity, 2, "the untouched sibling line bills in full");
});

test("a single-line DO returned in FULL bills nothing — it must not fall back to billing the whole SO", async () => {
  // Was the "nothing priced → bill the SO lines directly" fallback: an empty
  // invItems read as "priced at zero", so a DO whose only line came back
  // invoiced the entire sales order (RM 830.00 on staging, 2026-09-24).
  const b = book();
  b.returnedQtyByPoId["po-1"] = 3;
  const db = fakeDb(b);
  const { invItems, computedTotal } = await computeDoInvoiceLines(db, "do-1", ["so-1"], null);
  assert.equal(invItems.length, 0);
  assert.equal(computedTotal, 0);
});

test("the auto-invoice on delivery raises no invoice when nothing is left to bill", () => {
  const i = HELPERS_SRC.indexOf("export async function buildDoDeliveredSoAndInvoice");
  const fn = HELPERS_SRC.slice(i);
  assert.match(fn, /if \(lines && \(lines\.invItems\.length > 0 \|\| lines\.computedTotal > 0\)\)/);
});

// ===========================================================================
// 3. Cancel must refuse after restock (delivery-returns.ts)
// ===========================================================================

test("cancel refuses a RETURNED_TO_STOCK return — no reversal exists, so it must not silently succeed", () => {
  const idx = RETURNS_SRC.indexOf('app.post("/:id/cancel"');
  const routeBody = RETURNS_SRC.slice(idx);
  assert.match(routeBody, /h\.status === "RETURNED_TO_STOCK"/);
  assert.match(routeBody, /Cannot cancel a \$\{h\.status\} return/);
});

// ===========================================================================
// 4. The cap and the insert read ONE quantity (BUG-2026-09-30-224).
//    Drives the real createDeliveryReturnRecord on a stateful fake DB. On the
//    old code `quantity: -1` was stored as -1 (and lowered the returned sum),
//    and an omitted quantity passed the cap as 0 then was stored as 1.
// ===========================================================================

const { createDeliveryReturnRecord } = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/delivery-return-create.ts")).href
);

// DO do-1: po-1 delivered 2. `returned` holds the stored delivery_return_items.
function returnsDb({ returned = [] } = {}) {
  const doLines = [{ poId: "po-1", quantity: 2 }];
  const stmt = (sql, args = []) => ({
    sql,
    args,
    bind: (...a) => stmt(sql, a),
    async run() { return { success: true }; },
    async first() {
      if (/SELECT COUNT\(\*\) AS n FROM delivery_order_items/.test(sql)) return { n: doLines.length };
      return null; // DO / SO snapshot, last return number
    },
    async all() {
      if (/FROM delivery_order_items WHERE deliveryOrderId = \? AND productionOrderId IN/.test(sql)) {
        return { results: doLines.filter((l) => args.slice(1).includes(l.poId)) };
      }
      if (/FROM delivery_return_items dri/.test(sql)) {
        const by = new Map();
        for (const r of returned) by.set(r.poId, (by.get(r.poId) ?? 0) + r.quantity);
        return { results: [...by].map(([poId, qty]) => ({ poId, qty })) };
      }
      return { results: [] }; // production_orders enrichment
    },
  });
  return {
    returned,
    prepare: (sql) => stmt(sql.replace(/\s+/g, " ").trim()),
    async batch(stmts) {
      for (const s of stmts) {
        if (/INSERT INTO delivery_return_items/.test(s.sql)) {
          returned.push({ poId: s.args[2], quantity: s.args[7] });
        }
      }
      return stmts.map(() => ({ success: true }));
    },
  };
}

const line = (extra) => ({ productionOrderId: "po-1", productCode: "CHAIR", ...extra });

test("a negative quantity is refused with 400 and nothing is written", async () => {
  const db = returnsDb();
  const out = await createDeliveryReturnRecord(db, "org-1", { doId: "do-1", items: [line({ quantity: -1 })] });
  assert.equal(out.ok, false);
  assert.equal(out.status, 400);
  assert.match(out.error, /quantity greater than 0/);
  assert.deepEqual(db.returned, []);
});

test("an omitted quantity is refused with 400, even when the line is fully returned", async () => {
  const db = returnsDb({ returned: [{ poId: "po-1", quantity: 2 }] });
  const out = await createDeliveryReturnRecord(db, "org-1", { doId: "do-1", items: [line({})] });
  assert.equal(out.ok, false);
  assert.equal(out.status, 400);
  assert.equal(db.returned.length, 1, "no second return row may be written");
});

test("zero, null, non-numeric and infinite quantities are refused with 400", async () => {
  for (const quantity of [0, null, "abc", Infinity]) {
    const db = returnsDb();
    const out = await createDeliveryReturnRecord(db, "org-1", { doId: "do-1", items: [line({ quantity })] });
    assert.equal(out.status, 400, `quantity ${String(quantity)}`);
    assert.deepEqual(db.returned, []);
  }
});

test("an explicit over-return is still a cap refusal (no status, so the route sends 409)", async () => {
  const db = returnsDb({ returned: [{ poId: "po-1", quantity: 2 }] });
  const out = await createDeliveryReturnRecord(db, "org-1", { doId: "do-1", items: [line({ quantity: 1 })] });
  assert.equal(out.ok, false);
  assert.equal(out.status, undefined);
  assert.match(out.error, /Return exceeds/);
});

test("a valid partial return stores exactly the quantity the cap measured", async () => {
  const db = returnsDb();
  const out = await createDeliveryReturnRecord(db, "org-1", { doId: "do-1", items: [line({ quantity: "1" })] });
  assert.equal(out.ok, true);
  assert.deepEqual(db.returned, [{ poId: "po-1", quantity: 1 }]);
});

test("a line with no production order is refused when the DO's lines carry one", async () => {
  const db = returnsDb({ returned: [{ poId: "po-1", quantity: 2 }] });
  const out = await createDeliveryReturnRecord(db, "org-1", {
    doId: "do-1",
    items: [{ productCode: "CHAIR", quantity: 1 }],
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 400);
  assert.equal(db.returned.length, 1);
});
