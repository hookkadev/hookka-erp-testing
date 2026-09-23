// ---------------------------------------------------------------------------
// stock-orders.ts — schema + constants for make-to-stock orders (DEV-05 / PRD
// T-014).
//
// WHY ITS OWN ENSURE, AND NOT production-orders' ensurePendingMigrations
//   That round is shared by the WIP cascade, which wraps it in a try/catch and
//   keeps going WITHOUT its idempotency guard when it throws (the 2026-05-12
//   wip_cascade_log incident). Seeding a row there means one unexpected INSERT
//   failure silently degrades a cascade that has nothing to do with stock
//   orders — tests/wip-quantity-drift.test.mjs catches exactly that, a replayed
//   transition applying twice. A seed belongs with the one endpoint that needs
//   it, not in a round every production write pays for.
//
// Deploys do not replay migration files in this repo, so this is the
// load-bearing copy of migrations-postgres/0236. Keep the two in step.
// ---------------------------------------------------------------------------
import type { D1Database } from "@cloudflare/workers-types";
import { runSelfApply, memoizeSelfApply } from "./self-apply";

/**
 * The one internal customer every make-to-stock order is booked against
 * (owner 2026-09-07 — "stock orders sit under one internal customer rather
 * than a blank one").
 *
 * The endpoint used to bind the empty string into sales_orders.customer_id,
 * which is NOT NULL REFERENCES customers(id). That only survived because D1
 * does not enforce foreign keys; Supabase Postgres does. A real row makes the
 * write legal — and makes the order VISIBLE to the delivery note's
 * one-customer check, which builds its set from non-empty customer ids only
 * and therefore never conflicted on a blank one.
 */
export const STOCK_CUSTOMER_ID = "cust-factory-stock";
export const STOCK_CUSTOMER_NAME = "Factory Stock";

let _mig: Promise<void> | null = null;

/**
 * Must be awaited at the top of any handler that writes a stock order, before
 * the first INSERT that binds is_stock or STOCK_CUSTOMER_ID.
 *
 * Throws on a non-benign failure and drops the memo so the next request
 * retries, rather than remembering a failed round as done.
 */
export function ensureStockOrderSchema(db: D1Database): Promise<void> {
  return memoizeSelfApply(
    () => _mig,
    (p) => {
      _mig = p;
    },
    () =>
      runSelfApply(db, "stock-orders", [
        "ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS is_stock BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS is_stock BOOLEAN NOT NULL DEFAULT FALSE",
        // 0237 — the stock order this production order was BORN against, kept
        // for life. salesOrderId is then free to move to the customer who is
        // allocated the goods, and "still unallocated" is simply
        // `sales_order_id = stock_origin_so_id` — one column, no second state
        // flag to drift out of step with the first. It also keeps the
        // provenance an invoice needs: this piece came from stock.
        "ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS stock_origin_so_id TEXT",
        // The archive twins. fetchFilteredPOs reads
        // `SELECT *, '' AS archivedAt FROM production_orders UNION ALL
        //  SELECT * FROM production_orders_archive` — a UNION whose two sides
        // must have the same column count, so a column added to one side only
        // breaks the archive branch outright.
        "ALTER TABLE production_orders_archive ADD COLUMN IF NOT EXISTS is_stock BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE production_orders_archive ADD COLUMN IF NOT EXISTS stock_origin_so_id TEXT",
        `INSERT INTO customers (id, code, name, is_active, credit_limit_sen, outstanding_sen)
           VALUES ('${STOCK_CUSTOMER_ID}', 'FACTORY-STOCK', '${STOCK_CUSTOMER_NAME}', 0, 0, 0)
           ON CONFLICT (id) DO NOTHING`,
      ]),
  );
}
