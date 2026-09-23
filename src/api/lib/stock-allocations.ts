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
//   guarantee.
//
// WHAT ACTUALLY MOVES: A WHOLE PRODUCTION ORDER
//   An allocation is not a counter. `POST /production-orders/stock` builds one
//   order per piece, exactly as a customer order is built, so handing goods
//   over is a whole order changing owner: `sales_order_id` moves from the stock
//   order to the customer's, and `stock_origin_so_id` remembers where it came
//   from. Nothing is ever split — splitting would drag job cards, stickered
//   fg_units and cost rows with it. A SOFA set is one order and goes out whole
//   (owner 2026-09-17).
//
// SO WHAT IS THIS TABLE FOR, THEN?
//   The WHY, not the WHAT. The production order records who owns a piece now;
//   these rows record every time that changed, who did it and for what reason.
//   Availability is RECOMPUTED from the production orders themselves and never
//   summed from here (see loadAvailability, pinned by a test) — so there is one
//   source of truth for "is this spoken for", and this ledger can never drift
//   away from it.
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
// load-bearing copy of migrations-postgres/0237. Keep the two in step.
// ---------------------------------------------------------------------------
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { runSelfApply, memoizeSelfApply } from "./self-apply";
import { STOCK_CUSTOMER_NAME } from "./stock-orders";

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
 * R11 — the availability figure that did not exist.
 *
 * RECOMPUTED, NOT STORED. Every number here is derived from the production
 * orders themselves, never from summing the ledger. A stock order is still
 * unallocated exactly while `sales_order_id = stock_origin_so_id`; allocating
 * it moves sales_order_id to the customer, which removes it from supply in the
 * same stroke. There is therefore only ONE source of truth for "is this piece
 * spoken for", and no possibility of the pool and the ledger disagreeing —
 * which is the failure mode a stored counter always eventually finds.
 *
 * Only STOCK production orders count as supply: a normal made-to-order PO is
 * already somebody's. CANCELLED and ON_HOLD are excluded from both buckets —
 * cancelled goods are not coming and held work is paused, and promising a
 * delivery date off either is how a salesperson ends up apologising.
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

  const res = await db
    .prepare(
      `SELECT product_code,
              SUM(CASE WHEN status = 'COMPLETED'
                        AND sales_order_id = stock_origin_so_id
                       THEN quantity ELSE 0 END) AS available_qty,
              SUM(CASE WHEN status = 'COMPLETED'
                       THEN quantity ELSE 0 END) AS on_hand_qty,
              SUM(CASE WHEN status <> 'COMPLETED'
                        AND sales_order_id = stock_origin_so_id
                       THEN quantity ELSE 0 END) AS in_production_qty,
              SUM(CASE WHEN sales_order_id <> stock_origin_so_id
                       THEN quantity ELSE 0 END) AS allocated_qty
         FROM production_orders
        WHERE is_stock = TRUE
          AND stock_origin_so_id IS NOT NULL
          AND status NOT IN ('CANCELLED', 'ON_HOLD')
          AND product_code IS NOT NULL${filter}
        GROUP BY product_code`,
    )
    .bind(...codes)
    .all<{
      product_code: string;
      available_qty: number | null;
      on_hand_qty: number | null;
      in_production_qty: number | null;
      allocated_qty: number | null;
    }>();

  const out = new Map<string, ProductAvailability>();
  for (const r of res.results ?? []) {
    out.set(r.product_code, {
      productCode: r.product_code,
      onHandQty: Number(r.on_hand_qty ?? 0),
      inProductionQty: Number(r.in_production_qty ?? 0),
      allocatedQty: Number(r.allocated_qty ?? 0),
      availableQty: Number(r.available_qty ?? 0),
    });
  }
  return out;
}

export type AllocatablePO = {
  id: string;
  poNo: string | null;
  productCode: string;
  quantity: number;
  stockOriginSoId: string;
};

/**
 * The stock production orders that can be handed over, oldest first.
 *
 * Oldest first is the owner's tie-break ("earliest sales order date wins")
 * applied to supply: the piece that has been waiting longest goes first, so
 * stock cannot quietly age while newer output ships.
 *
 * Only FINISHED orders are offered. Promising a customer a piece that is still
 * on the floor is a different decision from handing them one that exists, and
 * this feature only claims to do the second.
 */
export async function loadAllocatablePOs(
  db: D1Database,
  productCode: string,
): Promise<AllocatablePO[]> {
  const res = await db
    .prepare(
      `SELECT id, poNo, product_code, quantity, stock_origin_so_id
         FROM production_orders
        WHERE is_stock = TRUE
          AND stock_origin_so_id IS NOT NULL
          AND sales_order_id = stock_origin_so_id
          AND status = 'COMPLETED'
          AND product_code = ?
        ORDER BY created_at ASC, poNo ASC`,
    )
    .bind(productCode)
    .all<{
      id: string;
      poNo: string | null;
      product_code: string;
      quantity: number | null;
      stock_origin_so_id: string;
    }>();
  return (res.results ?? []).map((r) => ({
    id: r.id,
    poNo: r.poNo,
    productCode: r.product_code,
    quantity: Number(r.quantity ?? 0),
    stockOriginSoId: r.stock_origin_so_id,
  }));
}

export type OwnerTarget = {
  salesOrderId: string;
  salesOrderNo: string | null;
  customerName: string | null;
  customerState: string | null;
};

/**
 * R12 — the ownership change itself, and it is NEVER BARE: the caller is
 * expected to carry these statements in the same batch as the ledger rows that
 * explain them, so a piece can never change hands without a record of why.
 *
 * `is_stock` is deliberately NOT cleared. It records how the piece was BORN,
 * which stays true forever and is what tells an invoice this came from stock
 * rather than from the customer's own production run. What changes is who owns
 * it, and that is `sales_order_id` — the one link every downstream reader
 * (delivery, the one-customer check, invoice-so-item-link) already trusts.
 */
export function buildOwnershipTransferStatements(
  db: D1Database,
  poIds: string[],
  to: OwnerTarget,
  updatedAt: string,
): D1PreparedStatement[] {
  return poIds.map((id) =>
    db
      .prepare(
        `UPDATE production_orders
            SET salesOrderId = ?, salesOrderNo = ?, companySOId = ?,
                customerName = ?, customerState = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(
        to.salesOrderId,
        to.salesOrderNo,
        to.salesOrderNo,
        to.customerName,
        to.customerState,
        updatedAt,
        id,
      ),
  );
}

/**
 * The mirror of the transfer: hand the piece back to the stock order it was
 * born against. `stock_origin_so_id` is what makes this exact rather than a
 * guess — without it there would be no way to know where a released piece
 * belongs.
 */
export function buildOwnershipReleaseStatements(
  db: D1Database,
  pos: Array<{ id: string; stockOriginSoId: string }>,
  stockOrderNo: string | null,
  updatedAt: string,
): D1PreparedStatement[] {
  return pos.map((po) =>
    db
      .prepare(
        `UPDATE production_orders
            SET salesOrderId = ?, salesOrderNo = ?, companySOId = ?,
                customerName = ?, customerState = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(
        po.stockOriginSoId,
        stockOrderNo,
        stockOrderNo,
        STOCK_CUSTOMER_NAME,
        "",
        updatedAt,
        po.id,
      ),
  );
}

/** The production orders this sales order currently holds FROM STOCK. */
export async function loadAllocatedPOsForOrder(
  db: D1Database,
  salesOrderId: string,
): Promise<AllocatablePO[]> {
  const res = await db
    .prepare(
      `SELECT id, poNo, product_code, quantity, stock_origin_so_id
         FROM production_orders
        WHERE is_stock = TRUE
          AND stock_origin_so_id IS NOT NULL
          AND sales_order_id = ?
          AND sales_order_id <> stock_origin_so_id
        ORDER BY created_at ASC`,
    )
    .bind(salesOrderId)
    .all<{
      id: string;
      poNo: string | null;
      product_code: string;
      quantity: number | null;
      stock_origin_so_id: string;
    }>();
  return (res.results ?? []).map((r) => ({
    id: r.id,
    poNo: r.poNo,
    productCode: r.product_code,
    quantity: Number(r.quantity ?? 0),
    stockOriginSoId: r.stock_origin_so_id,
  }));
}

export type AutoAllocationLine = {
  productCode: string;
  soItemId?: string | null;
  soLineNo?: number | null;
  quantity: number;
};

export type AutoAllocationPlan = {
  statements: D1PreparedStatement[];
  /** One human sentence per allocation, for so_status_changes.autoActions. */
  notes: string[];
};

/**
 * Owner decision 2026-09-07: allocation is AUTOMATIC when a sales order is
 * confirmed. The rails that keep this from repeating the 2026-06-08 removal
 * ("your scan silently completes someone else's job") are all here:
 *
 *   • it touches UNALLOCATED stock only — availability is already net of every
 *     open claim, so nothing is ever taken from another order;
 *   • a MANUAL decision always wins — a line that already holds an allocation
 *     is skipped entirely rather than topped up, so no operator's number is
 *     changed behind their back;
 *   • NOTHING on the shop floor changes — this writes ledger rows and not one
 *     job card, production order or piece;
 *   • it is VISIBLE and REVERSIBLE — every row is named in autoActions on the
 *     order's own history, and POST /release gives it back.
 *
 * Returns statements so the caller can carry them in the SAME batch as the
 * confirm. An allocation that could land without its confirm (or the reverse)
 * is exactly the drift this ledger exists to prevent.
 */
export async function planAutoAllocation(
  db: D1Database,
  orgId: string,
  order: {
    id: string;
    companySOId?: string | null;
    isStock?: boolean | null;
    customerName?: string | null;
    customerState?: string | null;
  },
  lines: AutoAllocationLine[],
  actor: AllocationActor,
  occurredAt: string,
): Promise<AutoAllocationPlan> {
  // A stock order IS the stock. Allocating to it would be the placeholder
  // problem all over again.
  if (order.isStock === true) return { statements: [], notes: [] };

  const wanted = lines.filter((l) => l.productCode && l.quantity > 0);
  if (wanted.length === 0) return { statements: [], notes: [] };

  const alreadyHeld = await loadAllocatedPOsForOrder(db, order.id);
  const heldCodes = new Set(alreadyHeld.map((p) => p.productCode));

  // Candidates are fetched ONCE per product and spent down locally, so two
  // lines of the same product cannot both claim the same production orders.
  const pool = new Map<string, AllocatablePO[]>();
  for (const code of new Set(wanted.map((l) => l.productCode))) {
    pool.set(code, await loadAllocatablePOs(db, code));
  }

  const statements: D1PreparedStatement[] = [];
  const notes: string[] = [];
  for (const line of wanted) {
    // A manual decision wins: a product this order already holds from stock is
    // left exactly as the operator set it.
    if (heldCodes.has(line.productCode)) continue;

    const candidates = pool.get(line.productCode) ?? [];
    const taken: AllocatablePO[] = [];
    let got = 0;
    while (candidates.length > 0 && got < line.quantity) {
      const next = candidates[0];
      // Whole orders only — never split one to top up a line. Taking a set of
      // 3 to satisfy a line that wants 1 would hand the customer two pieces
      // nobody ordered.
      if (got + next.quantity > line.quantity) break;
      candidates.shift();
      taken.push(next);
      got += next.quantity;
    }
    if (taken.length === 0) continue;

    statements.push(
      ...buildOwnershipTransferStatements(
        db,
        taken.map((p) => p.id),
        {
          salesOrderId: order.id,
          salesOrderNo: order.companySOId ?? null,
          customerName: order.customerName ?? null,
          customerState: order.customerState ?? null,
        },
        occurredAt,
      ),
    );
    for (const po of taken) {
      statements.push(
        buildAllocationStatement(db, "ALLOCATE", {
          productCode: line.productCode,
          quantity: po.quantity,
          salesOrderId: order.id,
          salesOrderNo: order.companySOId ?? null,
          soItemId: line.soItemId ?? null,
          soLineNo: line.soLineNo ?? null,
          sourcePoId: po.id,
          actor,
          occurredAt,
          reason: "Auto-allocated on order confirmation",
          orgId,
        }),
      );
    }
    notes.push(
      `Allocated ${got} x ${line.productCode} from stock` +
        (line.quantity > got ? ` (${line.quantity - got} to be produced)` : ""),
    );
  }
  return { statements, notes };
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
