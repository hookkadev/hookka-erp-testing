-- 0238_pi_item_discount.sql — per-line discount on purchase invoice lines.
--
-- DEV-14. RECORD ONLY — deploys do not replay migration files. The
-- load-bearing copy is `ensurePiMigrations` in src/api/routes/purchase-invoices.ts,
-- awaited at the top of the PI POST / PUT.
--
-- line_total_sen is stored NET of this discount (qty × unit − discount), so
-- existing readers of line_total_sen need no change. Old rows read 0.
ALTER TABLE purchase_invoice_items ADD COLUMN IF NOT EXISTS discount_sen INTEGER DEFAULT 0;
