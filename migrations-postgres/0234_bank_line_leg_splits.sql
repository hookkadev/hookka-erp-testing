-- Reverse combo match (Houzs adoption Phase 3, 2026-09-22): ONE bank statement
-- line paid SEVERAL book legs. The line's matchedLegId holds the sentinel
-- 'SPLIT' and one row per leg here records the pieces (Σ = line amount).
-- ⚠ RECORD ONLY — runtime self-apply `ensureBankLineSplits` is the mechanism.
CREATE TABLE IF NOT EXISTS bank_line_leg_splits (
  line_id    TEXT NOT NULL,
  leg_id     TEXT NOT NULL,
  amount_sen INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (line_id, leg_id)
);
