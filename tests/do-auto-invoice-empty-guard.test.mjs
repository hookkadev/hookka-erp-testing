// ---------------------------------------------------------------------------
// do-auto-invoice-empty-guard.test.mjs — BUG-2026-10-07-266.
//
// DO-2610-013 was marked DELIVERED twice, 0.6 s apart (a double click). Both
// requests read the billing state before either had committed, so both went on
// to build the auto-invoice. The first billed both lines (INV-2610-020,
// RM 915.00). The second then read the DO lines AFTER that commit, found
// nothing left, and posted INV-2610-021 anyway: RM 0.00, no lines, status SENT.
// The delivered email attaches the newest live invoice, so the customer was
// sent the empty one.
//
// This replays the losing request against a book whose reads change underneath
// it exactly the way prod's did: the first billing read is the pre-commit view,
// every later read sees the winner's invoice.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { buildDoDeliveredSoAndInvoice } = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/routes/delivery-orders/_helpers.ts")).href
);

const DO_ID = "do-1";

function racedBook() {
  return {
    // Flipped to true once the losing request has taken its pre-commit read.
    committed: false,
    doItems: [
      { id: "di-1", deliveryOrderId: DO_ID, productionOrderId: "po-1", productCode: "1013-(Q)", productName: "JAGER BEDFRAME", sizeLabel: "5FT", fabricCode: "PC151-04", quantity: 1 },
      { id: "di-2", deliveryOrderId: DO_ID, productionOrderId: "po-2", productCode: "1005(HF)(W)-(Q)", productName: "FENRIR BEDFRAME", sizeLabel: "5FT", fabricCode: "PC151-12", quantity: 1 },
    ],
    prodOrders: [
      { id: "po-1", orgId: "hookka", salesOrderId: "so-1", productCode: "1013-(Q)", sizeCode: "5FT", fabricCode: "PC151-04" },
      { id: "po-2", orgId: "hookka", salesOrderId: "so-2", productCode: "1005(HF)(W)-(Q)", sizeCode: "5FT", fabricCode: "PC151-12" },
    ],
    salesOrders: [
      { id: "so-1", orgId: "hookka", status: "CONFIRMED", totalSen: 30500 },
      { id: "so-2", orgId: "hookka", status: "CONFIRMED", totalSen: 61000 },
    ],
    soItems: [
      { id: "soi-1", salesOrderId: "so-1", productCode: "1013-(Q)", sizeCode: "5FT", fabricCode: "PC151-04", unitPriceSen: 30500, quantity: 1, lineTotalSen: 30500 },
      { id: "soi-2", salesOrderId: "so-2", productCode: "1005(HF)(W)-(Q)", sizeCode: "5FT", fabricCode: "PC151-12", unitPriceSen: 61000, quantity: 1, lineTotalSen: 61000 },
    ],
    winner: { id: "inv-020", invoiceNo: "INV-2610-020", status: "SENT" },
  };
}

function fakeDb(b) {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  let itemReads = 0;
  const answerFirst = (q, args) => {
    if (/SELECT id, status FROM sales_orders WHERE id = \?/.test(q)) {
      return b.salesOrders.find((s) => s.id === args[0]) ?? null;
    }
    if (/SELECT orgId, salesOrderId FROM delivery_orders WHERE id = \?/.test(q)) {
      return { orgId: "hookka", salesOrderId: null };
    }
    if (/FROM invoice_items WHERE invoiceId = \? AND delivery_order_item_id IS NOT NULL/.test(q)) {
      return args[0] === b.winner.id ? { id: "ii-1" } : null;
    }
    throw new Error("unexpected first(): " + q);
  };
  const answerAll = (q, args) => {
    if (/SELECT DISTINCT po.salesOrderId AS soId/.test(q)) {
      return { results: [{ soId: "so-1" }, { soId: "so-2" }] };
    }
    if (/FROM delivery_order_items\s+WHERE deliveryOrderId = \?/.test(q)) {
      // Read 1 is loadDoBillingState's gate, taken before the winner commits.
      itemReads++;
      if (itemReads > 1) b.committed = true;
      const billed = b.committed ? 1 : 0;
      return {
        results: b.doItems
          .filter((d) => d.deliveryOrderId === args[0])
          .map((d) => ({ ...d, invoicedQty: billed * d.quantity })),
      };
    }
    if (/SELECT id, invoiceNo, status FROM invoices\s+WHERE deliveryOrderId = \? AND status <> 'CANCELLED'/.test(q)) {
      return { results: b.committed ? [b.winner] : [] };
    }
    if (/FROM production_orders WHERE orgId = \?/.test(q)) {
      return { results: b.prodOrders.filter((p) => p.orgId === args[0]) };
    }
    if (/FROM sales_order_items si JOIN sales_orders s/.test(q)) {
      return { results: b.soItems };
    }
    if (/FROM delivery_return_items dri/.test(q)) {
      return { results: [] };
    }
    throw new Error("unexpected all(): " + q);
  };
  return {
    prepare(sql) {
      const q = norm(sql);
      return {
        async run() { return { success: true }; },
        bind(...args) {
          return {
            sql: q,
            args,
            async run() { return { success: true }; },
            async first() { return answerFirst(q, args); },
            async all() { return answerAll(q, args); },
          };
        },
      };
    },
  };
}

const doRow = {
  id: DO_ID,
  doNo: "DO-2610-013",
  salesOrderId: null,
  companySOId: null,
  customerId: "cust-1",
  customerName: "Houzs Century",
  customerState: null,
  deliveryAddress: "1831-B, JALAN KPB 1",
  contactPerson: "Purchasing",
  contactPhone: "011-6151 1613",
  customerPOId: null,
  hubId: "hub-h3",
  hubName: "Houzs SRW",
  dispatchedAt: "2026-10-05T08:18:19.422Z",
  deliveredAt: null,
  deliveryDate: "2026-10-05",
};

async function replayLoser() {
  const b = racedBook();
  const dc = await buildDoDeliveredSoAndInvoice(
    fakeDb(b), doRow, "2026-10-06T06:53:08.121Z", "hookka", "user-violet",
  );
  return { b, dc };
}

test("the losing DELIVERED request posts no invoice when the winner already billed every line", async () => {
  const { dc } = await replayLoser();
  assert.equal(dc.createdInvoice, false);
  assert.equal(dc.invoiceStmtIdx, -1);
  assert.equal(dc.rebuildInvoiceInsert, null);
  assert.equal(dc.invoiceTotalSen, 0);
  const sqls = dc.statements.map((s) => s.sql);
  assert.ok(!sqls.some((s) => /INSERT INTO invoices\b/.test(s)), "no invoice header");
  assert.ok(!sqls.some((s) => /INSERT INTO invoice_items/.test(s)), "no invoice lines");
  assert.ok(!sqls.some((s) => /UPDATE customers SET outstandingSen/.test(s)), "no A/R bump");
  assert.ok(!sqls.some((s) => /invoiced_qty = invoiced_qty \+/.test(s)), "no draw-down");
});

test("the losing request still leaves both SOs and the DO at INVOICED", async () => {
  const { b, dc } = await replayLoser();
  // Its batch carries SO→DELIVERED from the stale read; apply the batch in
  // order and the SOs must still finish INVOICED, as the winner left them.
  const so = new Map(b.salesOrders.map((s) => [s.id, "INVOICED"]));
  let doStatus = "DELIVERED";
  for (const st of dc.statements) {
    let m = /^UPDATE sales_orders SET status = '(\w+)', updated_at = \? WHERE id = \?( AND status = '(\w+)')?$/.exec(st.sql);
    if (m) {
      const id = st.args[1];
      if (!m[3] || so.get(id) === m[3]) so.set(id, m[1]);
      continue;
    }
    m = /^UPDATE delivery_orders SET status = '(\w+)'/.exec(st.sql);
    if (m) doStatus = m[1];
  }
  assert.deepEqual([...so.values()], ["INVOICED", "INVOICED"]);
  assert.equal(doStatus, "INVOICED");
});
