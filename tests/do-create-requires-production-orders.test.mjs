// ---------------------------------------------------------------------------
// do-create-requires-production-orders.test.mjs — BUG-06 / T-006 R1.
//
// The Sales page "Transfer to Delivery Order" posted { salesOrderId, items }
// with hand-built items and NO productionOrderIds. validateDoComposition, the
// once-only-delivery guard (BUG-2026-05-16: 13 duplicate DOs, RM 24,647 of FG
// double-consumed), only runs when productionOrderIds is non-empty, so that
// entry point could deliver the same sales order again and again.
//
// Behavioural, not a source grep: drives the real createDeliveryOrderForPOs
// against a fake DB that logs every statement, so "refused" means no
// delivery_orders row was written.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { createDeliveryOrderForPOs } = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/routes/delivery-orders/_helpers.ts")).href
);

const SO = {
  id: "so-1",
  customerId: "cust-1",
  customerName: "Test Customer",
  customerState: "Selangor",
  companySOId: "SO-2609-001",
  hubId: null,
};
const PO = {
  id: "po-1",
  poNo: "PO-1",
  salesOrderId: "so-1",
  consignmentOrderId: null,
  customerName: "Test Customer",
  quantity: 1,
};
const PO2 = { ...PO, id: "po-2", poNo: "PO-2" };
// po-1 already sits on a live DO: delivering it again is the duplicate.
const LIVE_DO_ITEM = { productionOrderId: "po-1", deliveryOrderId: "do-old", doNo: "DO-OLD", status: "DRAFT" };

function fakeCtx() {
  const log = [];
  const stmt = (sql, args = []) => ({
    sql,
    bind: (...a) => stmt(sql, a),
    async first() {
      log.push(sql);
      if (/FROM sales_orders WHERE id = \?/.test(sql)) return SO;
      if (/FROM customers/.test(sql)) return { id: "cust-1", name: "Test Customer", creditLimitSen: 0, outstandingSen: 0 };
      return null;
    },
    async all() {
      log.push(sql);
      if (/FROM production_orders WHERE id IN/.test(sql)) return { results: [PO, PO2].filter((p) => args.includes(p.id)) };
      if (/delivery_order_items/.test(sql) && /production_?[oO]rder_?[iI]d/.test(sql)) return { results: [LIVE_DO_ITEM].filter((r) => args.includes(r.productionOrderId)) };
      return { results: [] };
    },
    async run() {
      log.push(sql);
      return { success: true, meta: { changes: 1 } };
    },
  });
  const DB = {
    prepare: (sql) => stmt(sql.replace(/\s+/g, " ").trim()),
    async batch(stmts) {
      for (const s of stmts) log.push(s.sql);
      return stmts.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
  const vars = { DB, orgId: "org-1", userId: "u-1", role: "SUPER_ADMIN" };
  const c = {
    var: vars,
    env: {},
    get: (k) => vars[k],
    set: (k, v) => { vars[k] = v; },
    req: { header: () => undefined },
  };
  return { c, log };
}

const wroteDo = (log) => log.some((s) => /INSERT INTO delivery_orders\b/i.test(s));

test("the Sales page shape { salesOrderId, items } with no productionOrderIds is refused, nothing written", async () => {
  const { c, log } = fakeCtx();
  const out = await createDeliveryOrderForPOs(c, {
    salesOrderId: "so-1",
    items: [{ productCode: "BED-Q", productName: "Queen bed", quantity: 1, packingStatus: "PENDING" }],
  });
  assert.equal(wroteDo(log), false, "no delivery_orders row may be written");
  assert.equal(out.ok, false, "a hand-built SO-linked DO must not be created");
  assert.equal(out.status, 400);
  assert.match(String(out.body.error), /productionOrderIds/);
});

test("the same SO through productionOrderIds hits the once-only-delivery guard", async () => {
  const { c, log } = fakeCtx();
  const out = await createDeliveryOrderForPOs(c, { salesOrderId: "so-1", productionOrderIds: ["po-1"] });
  assert.equal(out.ok, false, "po-1 is already on DO-OLD");
  assert.equal(out.status, 409);
  assert.equal(wroteDo(log), false);
});

// The create writes body.items as sent when present, so the guard must cover
// every production order those items name, not only body.productionOrderIds.
// The edit path already derives its ids from the items.
test("items naming an already-delivered PO are refused even when productionOrderIds lists another", async () => {
  const { c, log } = fakeCtx();
  const out = await createDeliveryOrderForPOs(c, {
    productionOrderIds: ["po-2"],
    items: [{ productionOrderId: "po-1", productCode: "BED-Q", quantity: 1 }],
  });
  assert.equal(wroteDo(log), false, "po-1 is already on DO-OLD");
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
});

test("items naming an already-delivered PO are refused with no sales order and no productionOrderIds", async () => {
  const { c, log } = fakeCtx();
  const out = await createDeliveryOrderForPOs(c, {
    customerId: "cust-1",
    items: [{ productionOrderId: "po-1", productCode: "BED-Q", quantity: 1 }],
  });
  assert.equal(wroteDo(log), false, "po-1 is already on DO-OLD");
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
});
