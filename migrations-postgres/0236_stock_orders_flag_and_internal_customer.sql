-- ---------------------------------------------------------------------------
-- 0236_stock_orders_flag_and_internal_customer.sql — make a make-to-stock order
-- identifiable by a COLUMN instead of a number prefix, and give it a real
-- customer to hang off.
--
-- DEV-05 / PRD T-014, R4 + R5. RECORD ONLY — deploys do not replay migration
-- files in this repo, so the LOAD-BEARING copy of this DDL is
-- `ensurePendingMigrations` in src/api/routes/production-orders/_helpers.ts,
-- awaited at the top of POST /stock before the first write. Keep the two in step.
--
-- WHY A COLUMN
--   `isStock` has existed in src/types/index.ts since the Create Stock PO button
--   shipped, but it appears in no migration, is never written and never read —
--   a stock order was distinguishable from a real one ONLY by its `SOH-` number
--   prefix. Matching on a prefix is how the placeholder reached the sales order
--   list, the Pending Delivery list, and (unallocated, at price zero) a real
--   customer's delivery note. `is_service_order` (0134) is the same shape and is
--   the precedent followed here.
--
-- WHY AN INTERNAL CUSTOMER AND NOT A BLANK ONE
--   Owner decision 2026-09-07. The endpoint currently binds the empty string
--   into sales_orders.customer_id, which is `TEXT NOT NULL REFERENCES
--   customers(id)` (0001_init.sql:382,400). That was survivable on D1, which
--   does not enforce foreign keys by default; it is not on Supabase Postgres,
--   which does. A real row makes the write legal, and — the part that matters
--   downstream — makes the stock order VISIBLE to the delivery order's
--   one-customer check, which builds its set only from non-empty customer ids
--   (delivery-orders/_helpers.ts:2168) and therefore never conflicted on a blank
--   one.
--
--   is_active = 0 so the row stays out of the operator-facing customer pickers.
--   Nothing picks it by hand: POST /stock references the fixed id directly.
--
-- Measured 2026-09-07 (owner): 1,617 sales orders, 3,354 production orders,
-- ZERO stock orders — the button has never successfully run, so there is no
-- legacy stock row to backfill and DEFAULT FALSE is exact for every existing row.
-- ---------------------------------------------------------------------------

ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS is_stock BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE production_orders
  ADD COLUMN IF NOT EXISTS is_stock BOOLEAN NOT NULL DEFAULT FALSE;

-- The stock order this production order was BORN against, kept for life.
-- sales_order_id is then free to move to whoever is allocated the goods, and
-- "still unallocated" is simply `sales_order_id = stock_origin_so_id` — one
-- column, with no second state flag that could drift out of step with the
-- first. It also preserves the provenance an invoice needs: this piece came
-- from stock, and here is the order it was built under.
ALTER TABLE production_orders
  ADD COLUMN IF NOT EXISTS stock_origin_so_id TEXT;

CREATE INDEX IF NOT EXISTS idx_production_orders_stock_origin
  ON production_orders (stock_origin_so_id);

-- The archive twin, for the same reason sales_orders_archive gets one:
-- fetchFilteredPOs reads `SELECT *, '' AS archivedAt FROM production_orders
-- UNION ALL SELECT * FROM production_orders_archive`, and a UNION's two sides
-- must have the same column count.
ALTER TABLE production_orders_archive
  ADD COLUMN IF NOT EXISTS is_stock BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE production_orders_archive
  ADD COLUMN IF NOT EXISTS stock_origin_so_id TEXT;

-- The archive twin gets it too. `?includeArchive=true` unions sales_orders with
-- sales_orders_archive and the sales-order list filters on is_stock, so the
-- column has to exist on BOTH sides or that branch throws. The archive table was
-- created `AS SELECT * FROM sales_orders WHERE FALSE` (0038) and nothing keeps
-- it in column-parity since, so this is parity for THIS column only — whether
-- the two column sets still line up overall is UNMEASURED here.
ALTER TABLE sales_orders_archive
  ADD COLUMN IF NOT EXISTS is_stock BOOLEAN NOT NULL DEFAULT FALSE;

-- The one internal customer every stock order is booked against. Fixed id (not
-- a generated `cust-<uuid8>`) so the endpoint can reference it as a constant and
-- this INSERT stays idempotent across environments.
INSERT INTO customers (id, code, name, is_active, credit_limit_sen, outstanding_sen)
VALUES ('cust-factory-stock', 'FACTORY-STOCK', 'Factory Stock', 0, 0, 0)
ON CONFLICT (id) DO NOTHING;
