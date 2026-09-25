-- 0237_scan_override_audit_reason_code.sql
--
-- PRD T-013 (2026-09-17): the weekly sequence-unlock review groups by WHO,
-- WHICH step and WHY, and "why" has to be a code, not prose — a real skip
-- and a recording gap are different problems with different fixes.
--
-- ⚠ THIS FILE IS A RECORD, NOT THE MECHANISM. Deploys do NOT replay
-- migrations-postgres/*.sql — the load-bearing copy is the runtime
-- self-apply `ensurePendingMigrations` in
-- src/api/routes/production-orders/_helpers.ts, awaited before the audit
-- INSERT in recordSequenceUnlock and before the report's SELECT.
--
-- Nullable, no defaults: rows written before this stay distinguishable
-- (reported as UNCLASSIFIED) instead of being back-filled with a guess.
--
--   reason_code      RECORDING_GAP | NOT_APPLICABLE | REAL_SKIP | OTHER | SHEETS_SYNC
--   department_code  the card that was released (e.g. UPHOLSTERY)
--   blocked_by       the departments it was waiting on, comma-joined
--   actor_kind       USER | WORKER | SYSTEM

ALTER TABLE scan_override_audit ADD COLUMN IF NOT EXISTS reason_code TEXT;
ALTER TABLE scan_override_audit ADD COLUMN IF NOT EXISTS department_code TEXT;
ALTER TABLE scan_override_audit ADD COLUMN IF NOT EXISTS blocked_by TEXT;
ALTER TABLE scan_override_audit ADD COLUMN IF NOT EXISTS actor_kind TEXT;
