-- sqlite mirror of migrations-postgres/0233_scan_override_audit_reason_code.sql
-- (feeds the rename-map identifier scan; columns are snake_case in BOTH
-- dialects, so no column-rename-map entries). Runtime self-applied
-- (`ensurePendingMigrations` in src/api/routes/production-orders/_helpers.ts)
-- — record only.

ALTER TABLE scan_override_audit ADD COLUMN reason_code TEXT;
ALTER TABLE scan_override_audit ADD COLUMN department_code TEXT;
ALTER TABLE scan_override_audit ADD COLUMN blocked_by TEXT;
ALTER TABLE scan_override_audit ADD COLUMN actor_kind TEXT;
