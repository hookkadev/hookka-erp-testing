-- D1-side record of migrations-postgres/0234_bank_line_leg_splits.sql.
-- ⚠ RECORD ONLY — runtime self-apply `ensureBankLineSplits` is the mechanism.
CREATE TABLE IF NOT EXISTS bank_line_leg_splits (
  line_id    TEXT NOT NULL,
  leg_id     TEXT NOT NULL,
  amount_sen INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (line_id, leg_id)
);
