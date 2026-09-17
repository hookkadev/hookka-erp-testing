// ---------------------------------------------------------------------------
// stock-allocations.ts — the append-only record of stock handed to a customer
// order (DEV-05 / PRD T-014 R8-R13).
//
// THE HOLE. Nothing in this system could reserve anything. "Reserved" on the
// inventory screen means only "a DRAFT delivery note already names the item"
// (src/lib/fg-stock.ts) — downstream of production, not an order commitment.
// So a production order built for stock could be finished and sitting in the
// yard while the sales screen showed nothing, and the only way to point those
// goods at an arriving order was to edit the order the PO was born against.
//
// WHY A SIBLING TABLE AND NOT fg_stock_events
//   fg_stock_events is an ON-HAND ledger: its `direction` is
//   onHand(to_status) − onHand(from_status), and Σ direction per product IS the
//   on-hand count. An allocation changes NOTHING about whether we hold the
//   piece — it is still in the yard, it is merely spoken for. Writing
//   allocations into that table would corrupt the one invariant it exists to
//   guarantee. The two compose instead: available = on hand − open allocations.
//
// WHY POOLED, NOT PER-PIECE
//   The stock ledger is already keyed by item code alone — work-in-progress
//   made for stock lands in the same pool everything else draws from. An
//   allocation is therefore a CLAIM ON A QUANTITY of a product code, not a
//   claim on serial number X. A specific piece is only chosen when the delivery
//   note is built, which is the last honest moment to choose one: until then
//   any piece of that spec satisfies the claim equally.
//
// WHY NO FOREIGN KEY ON sales_order_id
//   Archiving a sales order DELETEs the row (it is copied to
//   sales_orders_archive first). A plain FK would block that; ON DELETE CASCADE
//   would silently erase the allocation trail of the very order someone is
//   archiving. History about an archived order is exactly the history worth
//   keeping, so the column is indexed but unconstrained, and the endpoints
//   validate the order exists before writing.
//
// REVERSALS ARE COUNTER-ROWS. Nothing here is ever UPDATEd or DELETEd. A
// release writes a second row with direction −1 pointing at what it undoes,
// the same discipline fg_stock_events and buildDoCancelReleaseStatements
// already follow.
//
// THE ONE ARITHMETIC RULE
//   direction is derived from the ACTION, here, never chosen per call site:
//   ALLOCATE = +1, RELEASE = −1. So
//     Σ (direction × quantity) over a product = the quantity currently spoken
//     for, and it can never go wrong by someone typing the sign themselves.
//
// Deploys do not replay migration files in this repo, so this is the
// load-bearing copy of migrations-postgres/0236. Keep the two in step.
// ---------------------------------------------------------------------------
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { runSelfApply, memoizeSelfApply } from "./self-apply";

let _mig: Promise<void> | null = null;

/** Awaited at the top of every handler that reads or writes an allocation. */
export function ensureStockAllocationSchema(db: D1Database): Promise<void> {
  return memoizeSelfApply(
    () => _mig,
    (p) => {
      _mig = p;
    },
    () =>
      runSelfApply(db, "stock-allocations", [
        `CREATE TABLE IF NOT EXISTS stock_allocations (
           id              TEXT PRIMARY KEY,
           org_id          TEXT NOT NULL DEFAULT 'hookka',
           action          TEXT NOT NULL,
           direction       INTEGER NOT NULL,
           quantity        INTEGER NOT NULL,
           product_code    TEXT NOT NULL,
           sales_order_id  TEXT NOT NULL,
           sales_order_no  TEXT,
           so_item_id      TEXT,
           so_line_no      INTEGER,
           source_po_id    TEXT,
           actor_type      TEXT NOT NULL DEFAULT 'SYSTEM',
           actor_id        TEXT,
           actor_name      TEXT,
           occurred_at     TEXT NOT NULL,
           reverses_id     TEXT,
           reason          TEXT,
           created_at      TEXT NOT NULL
         )`,
        "CREATE INDEX IF NOT EXISTS idx_stock_allocations_product ON stock_allocations (org_id, product_code)",
        "CREATE INDEX IF NOT EXISTS idx_stock_allocations_so ON stock_allocations (sales_order_id)",
        "CREATE INDEX IF NOT EXISTS idx_stock_allocations_item ON stock_allocations (so_item_id)",
      ]),
  );
}

export type AllocationAction = "ALLOCATE" | "RELEASE";

/** The ONE place the sign is decided. */
export function directionFor(action: AllocationAction): 1 | -1 {
  return action === "ALLOCATE" ? 1 : -1;
}

export type AllocationActor = {
  type: "USER" | "SYSTEM";
  id?: string | null;
  name?: string | null;
};

export const SYSTEM_ALLOCATION_ACTOR: AllocationActor = {
  type: "SYSTEM",
  id: null,
  name: "System",
};

export type AllocationInput = {
  productCode: string;
  /** Always POSITIVE. The sign comes from the action, not from the caller. */
  quantity: number;
  salesOrderId: string;
  salesOrderNo?: string | null;
  soItemId?: string | null;
  soLineNo?: number | null;
  /** The stock production order the goods are drawn from, when one is known. */
  sourcePoId?: string | null;
  actor?: AllocationActor;
  occurredAt: string;
  reason?: string | null;
  /** Set on a RELEASE row so the reversal points at what it undoes. */
  reversesId?: string | null;
  orgId?: string;
};

function genAllocationId(): string {
  return `alloc-${crypto.randomUUID()}`;
}

/**
 * Returns the statement rather than writing it, so the caller can carry it in
 * the same db.batch() as whatever state change it accompanies. A ledger row
 * that could land without its cause (or the reverse) is the failure this table
 * exists to prevent.
 */
export function buildAllocationStatement(
  db: D1Database,
  action: AllocationAction,
  input: AllocationInput,
): D1PreparedStatement {
  const actor = input.actor ?? SYSTEM_ALLOCATION_ACTOR;
  const qty = Math.max(0, Math.floor(input.quantity));
  return db
    .prepare(
      `INSERT INTO stock_allocations (id, org_id, action, direction, quantity,
         product_code, sales_order_id, sales_order_no, so_item_id, so_line_no,
         source_po_id, actor_type, actor_id, actor_name, occurred_at,
         reverses_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      genAllocationId(),
      input.orgId ?? "hookka",
      action,
      directionFor(action),
      qty,
      input.productCode,
      input.salesOrderId,
      input.salesOrderNo ?? null,
      input.soItemId ?? null,
      input.soLineNo ?? null,
      input.sourcePoId ?? null,
      actor.type,
      actor.id ?? null,
      actor.name ?? null,
      input.occurredAt,
      input.reversesId ?? null,
      input.reason ?? null,
      new Date().toISOString(),
    );
}

export type ProductAvailability = {
  productCode: string;
  /** Finished stock production orders — goods physically in the yard. */
  onHandQty: number;
  /** Stock POs still being made. Real supply, just not yet pickable. */
  inProductionQty: number;
  /** Σ (direction × quantity) — what is currently spoken for. */
  allocatedQty: number;
  /** R11. Never negative: an over-allocation reads as zero available. */
  availableQty: number;
};

/**
 * R11 — the availability figure that did not exist. Only STOCK production
 * orders count as supply: a normal made-to-order PO is already somebody's.
 *
 * CANCELLED and ON_HOLD are excluded from both buckets. Cancelled goods are
 * not coming, and held work is paused — promising a delivery date off either
 * is how a salesperson ends up apologising.
 */
export async function loadAvailability(
  db: D1Database,
  orgId: string,
  productCodes?: string[],
): Promise<Map<string, ProductAvailability>> {
  const codes = (productCodes ?? []).filter(Boolean);
  const filter = codes.length
    ? ` AND product_code IN (${codes.map(() => "?").join(",")})`
    : "";

  const supplyRes = await db
    .prepare(
      `SELECT product_code,
              SUM(CASE WHEN status = 'COMPLETED' THEN quantity ELSE 0 END) AS on_hand_qty,
              SUM(CASE WHEN status = 'COMPLETED' THEN 0 ELSE quantity END) AS in_production_qty
         FROM production_orders
        WHERE is_stock = TRUE
          AND status NOT IN ('CANCELLED', 'ON_HOLD')
          AND product_code IS NOT NULL${filter}
        GROUP BY product_code`,
    )
    .bind(...codes)
    .all<{
      product_code: string;
      on_hand_qty: number | null;
      in_production_qty: number | null;
    }>();

  const allocRes = await db
    .prepare(
      `SELECT product_code, SUM(direction * quantity) AS allocated_qty
         FROM stock_allocations
        WHERE org_id = ?${filter}
        GROUP BY product_code`,
    )
    .bind(orgId, ...codes)
    .all<{ product_code: string; allocated_qty: number | null }>();

  const out = new Map<string, ProductAvailability>();
  const row = (code: string): ProductAvailability => {
    let r = out.get(code);
    if (!r) {
      r = {
        productCode: code,
        onHandQty: 0,
        inProductionQty: 0,
        allocatedQty: 0,
        availableQty: 0,
      };
      out.set(code, r);
    }
    return r;
  };

  for (const s of supplyRes.results ?? []) {
    const r = row(s.product_code);
    r.onHandQty = Number(s.on_hand_qty ?? 0);
    r.inProductionQty = Number(s.in_production_qty ?? 0);
  }
  for (const a of allocRes.results ?? []) {
    row(a.product_code).allocatedQty = Number(a.allocated_qty ?? 0);
  }
  for (const r of out.values()) {
    r.availableQty = Math.max(0, r.onHandQty - r.allocatedQty);
  }
  return out;
}

export type OpenAllocation = {
  productCode: string;
  salesOrderId: string;
  salesOrderNo: string | null;
  soItemId: string | null;
  soLineNo: number | null;
  /** Net of releases. Lines that net to zero are dropped. */
  quantity: number;
};

/**
 * What a given sales order currently holds, netted per line. The detail panel
 * reads this to decide whether there is anything to release.
 */
export async function loadOpenAllocationsForOrder(
  db: D1Database,
  salesOrderId: string,
): Promise<OpenAllocation[]> {
  const res = await db
    .prepare(
      `SELECT product_code, sales_order_id, sales_order_no, so_item_id, so_line_no,
              SUM(direction * quantity) AS net_qty
         FROM stock_allocations
        WHERE sales_order_id = ?
        GROUP BY product_code, sales_order_id, sales_order_no, so_item_id, so_line_no
        HAVING SUM(direction * quantity) > 0`,
    )
    .bind(salesOrderId)
    .all<{
      product_code: string;
      sales_order_id: string;
      sales_order_no: string | null;
      so_item_id: string | null;
      so_line_no: number | null;
      net_qty: number | null;
    }>();
  return (res.results ?? []).map((r) => ({
    productCode: r.product_code,
    salesOrderId: r.sales_order_id,
    salesOrderNo: r.sales_order_no,
    soItemId: r.so_item_id,
    soLineNo: r.so_line_no,
    quantity: Number(r.net_qty ?? 0),
  }));
}
