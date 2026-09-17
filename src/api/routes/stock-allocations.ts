// ---------------------------------------------------------------------------
// Stock allocations — hand goods built for stock to the customer order that
// arrives (DEV-05 / PRD T-014 R9-R13).
//
// Endpoints:
//   GET  /availability?productCodes=A,B   on hand / in production / allocated / available
//   GET  /?salesOrderId=…                 what this order currently holds (netted)
//   POST /                                allocate stock to a sales order line
//   POST /release                         give it back
//
// The ledger itself, the arithmetic rule and the reasoning for a separate table
// live in src/api/lib/stock-allocations.ts.
//
// OVER-ALLOCATION IS BOUNDED, NOT IMPOSSIBLE. Availability is recomputed on
// every write and the request is rejected when it asks for more than exists,
// but two confirms racing each other can still both pass that check. That is
// deliberate: the design this follows is pooled and recomputed, hardened only
// when the delivery note is built — which is the moment a real piece has to be
// picked and the shortfall becomes visible to a human. A lock here would buy
// exactness in the pool at the cost of blocking order confirmation, which is
// the worse trade for a factory that oversells by at most a piece.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import {
  ensureStockAllocationSchema,
  buildAllocationStatement,
  buildOwnershipTransferStatements,
  buildOwnershipReleaseStatements,
  loadAllocatablePOs,
  loadAllocatedPOsForOrder,
  loadAvailability,
  loadOpenAllocationsForOrder,
  type AllocationActor,
} from "../lib/stock-allocations";
import { ensureStockOrderSchema } from "../lib/stock-orders";

const app = new Hono<Env>();

// userId is stamped by auth-middleware; worker.ts's typed Variables map does
// not enumerate the auth-injected keys, so it is read through the same get()
// escape hatch rbac.ts and fgActorFor use.
function actorFrom(c: Context<Env>): AllocationActor {
  const userId = (c as unknown as { get: (k: string) => unknown }).get("userId");
  return typeof userId === "string" && userId
    ? { type: "USER", id: userId, name: null }
    : { type: "SYSTEM", id: null, name: "System" };
}

// ---------------------------------------------------------------------------
// GET /availability — R11. The number that did not exist: what can actually be
// promised to a customer today.
// ---------------------------------------------------------------------------
app.get("/availability", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "read");
  if (denied) return denied;
  // Both: the ledger table, and the is_stock / stock_origin_so_id columns every
  // query below reads off production_orders.
  await ensureStockOrderSchema(c.var.DB);
  await ensureStockAllocationSchema(c.var.DB);

  const raw = c.req.query("productCodes") ?? "";
  const codes = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const map = await loadAvailability(c.var.DB, getOrgId(c), codes);
  return c.json({ success: true, data: [...map.values()] });
});

// ---------------------------------------------------------------------------
// GET /?salesOrderId=… — what this order holds, netted per line. Lines that
// net to zero are absent rather than shown as zero: a released allocation is
// not a thing the panel should offer to release again.
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "read");
  if (denied) return denied;
  const salesOrderId = c.req.query("salesOrderId");
  if (!salesOrderId) {
    return c.json({ success: false, error: "salesOrderId is required" }, 400);
  }
  // Both: the ledger table, and the is_stock / stock_origin_so_id columns every
  // query below reads off production_orders.
  await ensureStockOrderSchema(c.var.DB);
  await ensureStockAllocationSchema(c.var.DB);
  const rows = await loadOpenAllocationsForOrder(c.var.DB, salesOrderId);
  return c.json({ success: true, data: rows });
});

// ---------------------------------------------------------------------------
// POST / — R9 + R13. Allocate `quantity` of a product to one sales order line.
// Partial is the normal case: order ten, allocate four, produce six.
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "edit");
  if (denied) return denied;
  const db = c.var.DB;
  // Both: the ledger table, and the is_stock / stock_origin_so_id columns every
  // query below reads off production_orders.
  await ensureStockOrderSchema(db);
  await ensureStockAllocationSchema(db);

  const body = await c.req.json().catch(() => ({}));
  const productCode = String(body?.productCode ?? "").trim();
  const salesOrderId = String(body?.salesOrderId ?? "").trim();
  const quantity = Math.floor(Number(body?.quantity) || 0);
  const soItemId = body?.soItemId ? String(body.soItemId) : null;
  const soLineNo =
    body?.soLineNo === undefined || body?.soLineNo === null
      ? null
      : Math.floor(Number(body.soLineNo));

  if (!productCode) {
    return c.json({ success: false, error: "productCode is required" }, 400);
  }
  if (!salesOrderId) {
    return c.json({ success: false, error: "salesOrderId is required" }, 400);
  }
  if (quantity < 1) {
    return c.json({ success: false, error: "quantity must be >= 1" }, 400);
  }

  // The order has to exist and has to be a real customer's. Allocating stock to
  // a stock order would be the placeholder problem all over again.
  const so = await db
    .prepare(
      `SELECT id, companySOId, isStock, status, customerName, customerState
         FROM sales_orders WHERE id = ?`,
    )
    .bind(salesOrderId)
    .first<{
      id: string;
      companySOId: string | null;
      isStock: boolean | null;
      status: string | null;
      customerName: string | null;
      customerState: string | null;
    }>();
  if (!so) {
    return c.json({ success: false, error: "Sales order not found" }, 404);
  }
  if (so.isStock === true) {
    return c.json(
      {
        success: false,
        error: "A stock order cannot receive an allocation — it IS the stock.",
      },
      422,
    );
  }
  if ((so.status ?? "").toUpperCase() === "CANCELLED") {
    return c.json(
      { success: false, error: "This order is cancelled." },
      422,
    );
  }

  // Whole production orders only — one is never split to top up a line. Taking
  // a 3-piece sofa set to satisfy a line that wants 1 would hand the customer
  // two pieces nobody ordered, so a set that overshoots is simply not taken.
  const candidates = await loadAllocatablePOs(db, productCode);
  const taken: typeof candidates = [];
  let got = 0;
  for (const po of candidates) {
    if (got >= quantity) break;
    if (got + po.quantity > quantity) continue;
    taken.push(po);
    got += po.quantity;
  }
  if (got < quantity) {
    const row = (await loadAvailability(db, getOrgId(c), [productCode])).get(
      productCode,
    );
    return c.json(
      {
        success: false,
        code: "INSUFFICIENT_STOCK",
        error:
          got === 0
            ? `No finished ${productCode} is available to allocate.`
            : `Only ${got} of ${productCode} can be allocated as whole production orders.`,
        data: row ?? null,
      },
      422,
    );
  }

  const now = new Date().toISOString();
  await db.batch([
    // R12 — the ownership change and the record of WHY it happened land
    // together or not at all. Never bare.
    ...buildOwnershipTransferStatements(
      db,
      taken.map((p) => p.id),
      {
        salesOrderId,
        salesOrderNo: so.companySOId,
        customerName: so.customerName,
        customerState: so.customerState,
      },
      now,
    ),
    ...taken.map((po) =>
      buildAllocationStatement(db, "ALLOCATE", {
        productCode,
        quantity: po.quantity,
        salesOrderId,
        salesOrderNo: so.companySOId,
        soItemId,
        soLineNo,
        sourcePoId: po.id,
        actor: actorFrom(c),
        occurredAt: now,
        reason: body?.reason ? String(body.reason) : null,
        orgId: getOrgId(c),
      }),
    ),
  ]);

  const after = await loadAvailability(db, getOrgId(c), [productCode]);
  return c.json({
    success: true,
    data: after.get(productCode) ?? null,
    allocated: taken.map((p) => p.poNo ?? p.id),
  });
});

// ---------------------------------------------------------------------------
// POST /release — R10. A counter-row, never an edit or a delete.
//
// Q5, owner 2026-09-07: reversible until the delivery note is issued. The
// delivery-note gate is not enforced here yet — the allocation is consumed when
// the DO is built, and that is where the check belongs.
// ---------------------------------------------------------------------------
app.post("/release", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "edit");
  if (denied) return denied;
  const db = c.var.DB;
  // Both: the ledger table, and the is_stock / stock_origin_so_id columns every
  // query below reads off production_orders.
  await ensureStockOrderSchema(db);
  await ensureStockAllocationSchema(db);

  const body = await c.req.json().catch(() => ({}));
  const productCode = String(body?.productCode ?? "").trim();
  const salesOrderId = String(body?.salesOrderId ?? "").trim();
  const quantity = Math.floor(Number(body?.quantity) || 0);
  const soItemId = body?.soItemId ? String(body.soItemId) : null;

  if (!productCode || !salesOrderId) {
    return c.json(
      { success: false, error: "productCode and salesOrderId are required" },
      400,
    );
  }
  if (quantity < 1) {
    return c.json({ success: false, error: "quantity must be >= 1" }, 400);
  }

  const held = (await loadAllocatedPOsForOrder(db, salesOrderId)).filter(
    (p) => p.productCode === productCode,
  );
  const heldQty = held.reduce((n, p) => n + p.quantity, 0);
  if (heldQty === 0) {
    return c.json(
      {
        success: false,
        code: "NOTHING_TO_RELEASE",
        error: `This order holds no ${productCode} from stock.`,
      },
      422,
    );
  }

  // Newest first, so releasing part of a holding gives back what was taken
  // last and leaves the oldest stock where it was — the same first-in-first-out
  // intent the allocation side follows.
  const giveBack: typeof held = [];
  let back = 0;
  for (const po of [...held].reverse()) {
    if (back >= quantity) break;
    if (back + po.quantity > quantity) continue;
    giveBack.push(po);
    back += po.quantity;
  }
  if (back === 0) {
    return c.json(
      {
        success: false,
        code: "NOTHING_TO_RELEASE",
        error: `This order holds ${heldQty} of ${productCode} as whole production orders; ${quantity} cannot be given back without splitting one.`,
      },
      422,
    );
  }

  // The stock order each piece goes home to is recorded on the piece itself
  // (stock_origin_so_id), so the number it carries after a release is exact
  // rather than reconstructed.
  const originNo = await db
    .prepare("SELECT companySOId FROM sales_orders WHERE id = ?")
    .bind(giveBack[0].stockOriginSoId)
    .first<{ companySOId: string | null }>();

  const now = new Date().toISOString();
  await db.batch([
    ...buildOwnershipReleaseStatements(
      db,
      giveBack.map((p) => ({ id: p.id, stockOriginSoId: p.stockOriginSoId })),
      originNo?.companySOId ?? null,
      now,
    ),
    ...giveBack.map((po) =>
      buildAllocationStatement(db, "RELEASE", {
        productCode,
        quantity: po.quantity,
        salesOrderId,
        soItemId,
        sourcePoId: po.id,
        actor: actorFrom(c),
        occurredAt: now,
        reason: body?.reason ? String(body.reason) : null,
        orgId: getOrgId(c),
      }),
    ),
  ]);

  const after = await loadAvailability(db, getOrgId(c), [productCode]);
  return c.json({
    success: true,
    data: after.get(productCode) ?? null,
    released: giveBack.map((p) => p.poNo ?? p.id),
  });
});

export default app;
