-- ---------------------------------------------------------------------------
-- 0240_dashboard_month_frozen.sql — a finished month's dashboard, stored once.
--
-- Owner 2026-10-08: switching between months on the dashboard should show
-- fixed figures for a finished month, not a fresh calculation every time.
-- GET /api/dashboard/overview stores the whole payload of a past month the
-- first time it is opened, and serves that copy from then on (only the month
-- list is read fresh). The current month and All-time are never stored here.
--
-- Inert on deploy like every file here: the table reaches a database through
-- the runtime self-apply in src/api/lib/dashboard-state-snapshot.ts
-- (freezeMonth). This file records the shape.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dashboard_month_frozen (
  org_id    TEXT NOT NULL,
  period    TEXT NOT NULL,
  data      JSONB NOT NULL,
  frozen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, period)
);
