-- ---------------------------------------------------------------------------
-- 0237_stock_allocations.sql — the append-only record of stock handed to a
-- customer order.
--
-- DEV-05 / PRD T-014, R8-R13. RECORD ONLY — deploys do not replay migration
-- files in this repo, so the LOAD-BEARING copy of this DDL is
-- `ensureStockAllocationSchema` in src/api/lib/stock-allocations.ts. Keep the
-- two in step.
--
-- WHY A SIBLING TABLE AND NOT fg_stock_events (0221)
--   That table's `direction` is onHand(to_status) − onHand(from_status), and
--   Σ direction per product IS the on-hand count. An allocation changes nothing
--   about whether we hold the piece — it is still in the yard, merely spoken
--   for. Recording allocations there would break the one invariant it exists to
--   guarantee. The two compose instead:
--       available = on hand (fg / stock POs) − open allocations (here)
--
-- WHY POOLED, NOT PER-PIECE
--   The stock ledger is already keyed by item code alone, so work-in-progress
--   built for stock lands in the same pool everything else draws from. An
--   allocation is a claim on a QUANTITY of a product code, not on serial X. The
--   specific piece is chosen when the delivery note is built — the last honest
--   moment to choose, since until then any piece of that spec satisfies the
--   claim equally.
--
-- WHY NO FOREIGN KEY ON sales_order_id
--   Archiving a sales order DELETEs the row (after copying it to
--   sales_orders_archive). A plain FK would block that; ON DELETE CASCADE would
--   erase the allocation trail of the very order being archived. History about
--   an archived order is the history worth keeping, so the column is indexed
--   but unconstrained and the endpoints validate the order before writing.
--
-- REVERSALS ARE COUNTER-ROWS. Nothing here is ever UPDATEd or DELETEd; a
-- release writes a second row with direction −1 and `reverses_id` pointing at
-- what it undoes. Same discipline as fg_stock_events and
-- buildDoCancelReleaseStatements.
--
-- `direction` is derived from `action` in ONE place (directionFor), so no call
-- site can get the sign wrong: ALLOCATE = +1, RELEASE = −1, and
-- Σ (direction × quantity) is what is currently spoken for.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stock_allocations (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL DEFAULT 'hookka',
  -- ALLOCATE / RELEASE. Stored so a reader does not have to infer intent from
  -- the sign of `direction`.
  action          TEXT NOT NULL,
  direction       INTEGER NOT NULL,
  -- Always positive; the sign lives in `direction`.
  quantity        INTEGER NOT NULL,
  product_code    TEXT NOT NULL,
  -- Who the goods were promised to. No FK — see the header.
  sales_order_id  TEXT NOT NULL,
  sales_order_no  TEXT,
  so_item_id      TEXT,
  so_line_no      INTEGER,
  -- The stock production order drawn from, when one is known at write time.
  source_po_id    TEXT,
  actor_type      TEXT NOT NULL DEFAULT 'SYSTEM',
  actor_id        TEXT,
  actor_name      TEXT,
  occurred_at     TEXT NOT NULL,
  -- Set on a RELEASE row so the reversal points at what it undoes.
  reverses_id     TEXT,
  reason          TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stock_allocations_product
  ON stock_allocations (org_id, product_code);
CREATE INDEX IF NOT EXISTS idx_stock_allocations_so
  ON stock_allocations (sales_order_id);
CREATE INDEX IF NOT EXISTS idx_stock_allocations_item
  ON stock_allocations (so_item_id);
