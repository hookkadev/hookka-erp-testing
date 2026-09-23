-- D1-side record of migrations-postgres/0233_pv_approval.sql (see there).
-- ⚠ RECORD ONLY — runtime self-apply `ensurePvApprovalCols` is the mechanism.
ALTER TABLE payment_vouchers ADD COLUMN approval_state TEXT;
ALTER TABLE payment_vouchers ADD COLUMN prepared_at TEXT;
ALTER TABLE payment_vouchers ADD COLUMN prepared_by TEXT;
ALTER TABLE payment_vouchers ADD COLUMN checked_at TEXT;
ALTER TABLE payment_vouchers ADD COLUMN checked_by TEXT;
ALTER TABLE payment_vouchers ADD COLUMN approved_at TEXT;
ALTER TABLE payment_vouchers ADD COLUMN approved_by TEXT;
ALTER TABLE payment_vouchers ADD COLUMN reject_reason TEXT;
UPDATE payment_vouchers SET approval_state = 'APPROVED' WHERE approval_state IS NULL;
