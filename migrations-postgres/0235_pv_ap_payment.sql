-- Payment Vouchers "AP Payment" (owner 2026-09-22, Houzs adoption:
-- 「ap payment 和 payment voucher 一起」). A voucher of pv_kind 'AP' pays a
-- creditor's bills — party_kind SUPPLIER → purchase invoices (+ optional
-- unallocated advance_sen), party_kind OTHER → other-creditor bills — and walks
-- the same Draft → Prepared → Checked → Approved ladder. Its ticked bills live
-- in payment_voucher_allocs; at APPROVE the settlement document
-- (supplier_payments / other_party_payments rows + GL) is written by the
-- payment pages' own builders under paymentNo = pvNo. The voucher itself
-- carries no ledger legs.
--
-- ⚠ RECORD ONLY. Migrations do not auto-apply on deploy — the live schema
-- change is the runtime self-apply `ensurePvApColumns` in
-- src/api/routes/accounting.ts, awaited by the PV write paths.
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS pv_kind TEXT;       -- NULL/'EXPENSE' | 'AP'
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS party_kind TEXT;    -- 'SUPPLIER' | 'OTHER' (AP only)
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS party_id TEXT;      -- suppliers.id | other_parties.id
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS advance_sen INTEGER; -- supplier overpay kept as prepayment

CREATE TABLE IF NOT EXISTS payment_voucher_allocs (
  id         TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL,          -- payment_vouchers.id
  doc_kind   TEXT NOT NULL,          -- 'PI' (purchase_invoices.id) | 'AP' (other_party_bills.id)
  doc_id     TEXT NOT NULL,
  amount_sen INTEGER NOT NULL,
  line_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pv_allocs_voucher ON payment_voucher_allocs (voucher_id);
CREATE INDEX IF NOT EXISTS idx_pv_allocs_doc ON payment_voucher_allocs (doc_kind, doc_id);
