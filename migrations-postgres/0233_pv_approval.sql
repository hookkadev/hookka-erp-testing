-- Payment-voucher four-tier approval (owner 2026-09-22, adopted from the
-- Houzs trading ERP: Draft -> Prepared -> Checked -> Approved; the GL posting
-- moves to the APPROVE step for vouchers born as drafts).
--
-- ⚠ RECORD ONLY. Migrations do not auto-apply on deploy — the live schema
-- change is the runtime self-apply `ensurePvApprovalCols` in
-- src/api/routes/accounting.ts, awaited by the PV write paths.
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS approval_state TEXT;
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS prepared_at TEXT;
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS prepared_by TEXT;
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS checked_at TEXT;
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS checked_by TEXT;
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS approved_at TEXT;
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS reject_reason TEXT;
-- Every voucher that existed before the tiers were introduced posted at
-- creation, so historically it IS approved.
UPDATE payment_vouchers SET approval_state = 'APPROVED' WHERE approval_state IS NULL;
-- 2026-09-22 (found on prod): status CHECK from 0159 only allowed POSTED|VOID;
-- the draft road writes DRAFT. Widened. ⚠ RECORD ONLY — ensurePvApprovalCols
-- re-creates the constraint at runtime.
ALTER TABLE payment_vouchers DROP CONSTRAINT IF EXISTS payment_vouchers_status_check;
ALTER TABLE payment_vouchers ADD CONSTRAINT payment_vouchers_status_check CHECK (status IN ('POSTED','VOID','DRAFT'));
