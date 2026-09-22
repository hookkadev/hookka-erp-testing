-- D1-side record of migrations-postgres/0235_pv_ap_payment.sql (see there).
-- ⚠ RECORD ONLY — runtime self-apply `ensurePvApColumns` is the mechanism.
ALTER TABLE payment_vouchers ADD COLUMN pv_kind TEXT;
ALTER TABLE payment_vouchers ADD COLUMN party_kind TEXT;
ALTER TABLE payment_vouchers ADD COLUMN party_id TEXT;
ALTER TABLE payment_vouchers ADD COLUMN advance_sen INTEGER;

CREATE TABLE IF NOT EXISTS payment_voucher_allocs (
  id         TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL,
  doc_kind   TEXT NOT NULL,
  doc_id     TEXT NOT NULL,
  amount_sen INTEGER NOT NULL,
  line_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pv_allocs_voucher ON payment_voucher_allocs (voucher_id);
CREATE INDEX IF NOT EXISTS idx_pv_allocs_doc ON payment_voucher_allocs (doc_kind, doc_id);
