-- 0233_workers_leadership_allowance.sql
-- Per-worker leadership allowance (DEV-06). Mirrors the Efficiency Allowance
-- storage (0151) but with NO threshold/performance gate — owner decision
-- (2026-09): "不设门槛,只按出勤比例" — pay the configured flat amount,
-- pro-rated by attendance only.
--
--   leadership_allowance_sen — the flat bonus (money, in sen) paid each
--                              month, scaled by days actually worked out of
--                              workingDaysPerMonth. Mirrors
--                              efficiency_allowance_sen (INTEGER, sen).
--
-- Defaults to 0 so every existing worker earns NO bonus until the operator
-- sets a real allowance amount. Idempotent (IF NOT EXISTS) so a re-run is a
-- no-op.
ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS leadership_allowance_sen INTEGER NOT NULL DEFAULT 0;
