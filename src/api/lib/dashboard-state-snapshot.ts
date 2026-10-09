// ---------------------------------------------------------------------------
// dashboard-state-snapshot.ts — daily capture + read helpers for the
// Command Center's point-in-time STATE metrics (Backlog, Active Jobs,
// Workforce).
//
// Background
// ----------
// GET /api/dashboard/overview accepts a `period` filter ("all" or a
// "YYYY-MM" month). The flow / sum metrics (revenue, orders created,
// deliveries, fabric meters…) are correctly scoped to the selected month's
// date range. But three widgets are point-in-time STATE counts, not sums:
//
//   • Backlog     — minutes/days of not-yet-completed work right now
//   • Active Jobs — production orders still in production right now
//   • Workforce   — active headcount right now
//
// Those are NOT reconstructible for a PAST month (the DB only holds current
// state). To stop the dashboard silently showing today's live value as
// though it were a past month's true figure, we:
//
//   1. capture a daily row of these state metrics from now on, and
//   2. when a past month's last in-range day has a captured row, serve the
//      snapshot for those widgets instead of live (and drop the "live" tag).
//
// Pattern mirrors src/api/lib/dashboard-snapshot.ts /
// src/api/lib/delivery-snapshot.ts. See
// migrations-postgres/0145_dashboard_state_snapshots.sql for the table.
//
// Multi-tenant: every row is scoped by org_id; (org_id, snap_date) is the
// primary key, so the daily write is idempotent (re-reading the dashboard
// many times in one day overwrites the same row).
// ---------------------------------------------------------------------------

import { isBenignSelfApplyError, memoizeSelfApply, runSelfApply } from "./self-apply";

// The state-metric payload we persist and restore. Mirrors the matching
// fields the dashboard read route builds, so a restored snapshot drops
// straight back into the response shape (incl. the drill-down sub-objects).
export type DashboardStateMetrics = {
  backlogMin: number;
  backlogDays: number;
  backlogByDept: unknown[];
  backlogGrandMin: number;
  activeJobs: {
    bedframeUnits: number;
    sofaSets: number;
    byCustomer: unknown[];
  };
  activeHeadcount: number;
};

export type DashboardStateSnapshotRow = {
  snapDate: string; // YYYY-MM-DD
  metrics: DashboardStateMetrics;
  capturedAt: string;
};

// ---------------------------------------------------------------------------
// Idempotent UPSERT of today's state metrics. (org_id, snap_date) PK means
// repeated reads on the same day just overwrite the row — no duplicate
// accumulation. Headline count columns are stored alongside the JSON blob
// for at-a-glance queryability; the blob carries the full drill-down
// sub-objects so the read path can restore them.
// ---------------------------------------------------------------------------
export async function writeStateSnapshot(
  db: D1Database,
  orgId: string,
  snapDate: string,
  metrics: DashboardStateMetrics,
): Promise<void> {
  const activeJobsCount =
    (Number(metrics.activeJobs?.bedframeUnits) || 0) +
    (Number(metrics.activeJobs?.sofaSets) || 0);
  // data is MERGED on conflict, never replaced: writeStateKpis adds its own
  // keys to the same day's row, and a replace would wipe them.
  const dataJson = JSON.stringify(metrics);
  const capturedAt = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO dashboard_state_snapshots
         (org_id, snap_date, backlog_count, active_jobs_count, workforce_count, data, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (org_id, snap_date) DO UPDATE
       SET backlog_count     = EXCLUDED.backlog_count,
           active_jobs_count = EXCLUDED.active_jobs_count,
           workforce_count   = EXCLUDED.workforce_count,
           data              = dashboard_state_snapshots.data || EXCLUDED.data,
           captured_at       = EXCLUDED.captured_at`,
    )
    .bind(
      orgId,
      snapDate,
      Math.round(Number(metrics.backlogMin) || 0),
      activeJobsCount,
      Math.round(Number(metrics.activeHeadcount) || 0),
      dataJson,
      capturedAt,
    )
    .run();
}

// ---------------------------------------------------------------------------
// Read the snapshot that best represents the END-OF-MONTH state for a past
// month. Returns the most recent captured row whose snap_date falls within
// the month (i.e. the last in-range day we have), or null if no row exists
// for that month (it predates this table → caller serves live + tag).
//
// `period` is a "YYYY-MM" string. Caller is responsible for only calling
// this for PAST months — the current month and the all-time view always
// serve live (the current value IS truthful for "now").
// ---------------------------------------------------------------------------
// The month's rows, newest day first (at most ~31). Filtering happens here
// rather than in SQL: a day can hold only KPI keys (its KPI endpoints were read
// but the overview was not), and naming a JSON key in SQL would put a
// camelCase string through the column-rename rewrite.
async function readMonthRows(
  db: D1Database,
  orgId: string,
  period: string,
): Promise<{ snapDate: string; data: Record<string, unknown>; capturedAt: string }[]> {
  if (!/^\d{4}-\d{2}$/.test(period)) return [];
  const monthStart = `${period}-01`;
  // Exclusive upper bound = first day of the next month.
  const [y, m] = period.split("-").map((n) => parseInt(n, 10));
  const nextMonth =
    m === 12
      ? `${y + 1}-01-01`
      : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const res = await db
    .prepare(
      `SELECT snap_date AS "snapDate", data, captured_at AS "capturedAt"
         FROM dashboard_state_snapshots
        WHERE org_id = ? AND snap_date >= ? AND snap_date < ?
        ORDER BY snap_date DESC`,
    )
    .bind(orgId, monthStart, nextMonth)
    .all<{ snapDate: string; data: unknown; capturedAt: string }>();
  return (res.results ?? []).map((r) => ({
    snapDate: r.snapDate,
    // D1 stores TEXT JSON; the Postgres adapter returns JSONB already parsed.
    data:
      typeof r.data === "string"
        ? (JSON.parse(r.data) as Record<string, unknown>)
        : ((r.data ?? {}) as Record<string, unknown>),
    capturedAt: r.capturedAt,
  }));
}

export async function readStateSnapshotForMonth(
  db: D1Database,
  orgId: string,
  period: string,
): Promise<DashboardStateSnapshotRow | null> {
  const row = (await readMonthRows(db, orgId, period)).find(
    (r) => r.data.backlogGrandMin !== undefined,
  );
  if (!row) return null;
  return {
    snapDate: row.snapDate,
    metrics: row.data as unknown as DashboardStateMetrics,
    capturedAt: row.capturedAt,
  };
}

// ---------------------------------------------------------------------------
// Pending Delivery and Outstanding, saved daily (owner 2026-10-09: a finished
// month must show that month's figure, not today's live one).
//
// The two KPI tiles read three endpoints, so each endpoint saves its own part
// into today's row, merged by key: /delivery-orders/pending-value
// (pendingDeliveryValueSen), /delivery-orders/stats (pendingDispatchSen,
// inTransitSen) and /sales-orders/stats (outstandingItemsSen). Callers save
// only an UNSCOPED whole-company total: a salesperson's narrowed figure must
// never become the company's history.
//
// snap_date is the UTC date, the same basis captureTodayState uses, so one
// day never splits across two rows.
// ---------------------------------------------------------------------------
export const STATE_KPI_KEYS = [
  "pendingDeliveryValueSen",
  "pendingDispatchSen",
  "inTransitSen",
  "outstandingItemsSen",
] as const;
export type StateKpiKey = (typeof STATE_KPI_KEYS)[number];

export async function writeStateKpis(
  db: D1Database,
  orgId: string,
  kpis: Partial<Record<StateKpiKey, number>>,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO dashboard_state_snapshots (org_id, snap_date, data, captured_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (org_id, snap_date) DO UPDATE
       SET data = dashboard_state_snapshots.data || EXCLUDED.data`,
    )
    .bind(orgId, new Date().toISOString().slice(0, 10), JSON.stringify(kpis), new Date().toISOString())
    .run();
}

/**
 * Fire-and-forget save after the response. A failed save is logged, not
 * thrown: the endpoint's own answer is already correct, and the next read
 * that day saves again.
 */
export function saveStateKpisLater(
  c: { var: { DB: D1Database }; executionCtx: { waitUntil(p: Promise<unknown>): void } },
  orgId: string,
  kpis: Partial<Record<StateKpiKey, number>>,
): void {
  const p = writeStateKpis(c.var.DB, orgId, kpis).catch((e) =>
    console.warn("[dashboard-state-kpis] save failed:", e),
  );
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    // No execution context (tests): the promise still runs.
  }
}

/**
 * A finished month's Pending Delivery and Outstanding: each part from the
 * latest day in the month that saved it. Pending Delivery is the sum of its
 * three parts, so it is null unless all three were saved. asOf = the latest
 * day any part came from.
 */
export async function readStateKpisForMonth(
  db: D1Database,
  orgId: string,
  period: string,
): Promise<{ pendingDeliverySen: number | null; outstandingSen: number | null; asOf: string | null }> {
  const rows = await readMonthRows(db, orgId, period);
  const pick = (k: StateKpiKey) => rows.find((r) => typeof r.data[k] === "number");
  const parts = STATE_KPI_KEYS.map((k) => pick(k));
  const [pdv, pds, its, out] = parts;
  const pendingDeliverySen =
    pdv && pds && its
      ? (pdv.data.pendingDeliveryValueSen as number) +
        (pds.data.pendingDispatchSen as number) +
        (its.data.inTransitSen as number)
      : null;
  const outstandingSen = out ? (out.data.outstandingItemsSen as number) : null;
  const dates = parts.filter(Boolean).map((r) => r!.snapDate).sort();
  return { pendingDeliverySen, outstandingSen, asOf: dates.length ? dates[dates.length - 1] : null };
}

// ---------------------------------------------------------------------------
// Frozen past months (owner 2026-10-08: "dashboard data should keep per
// month so when juggling between months it is dead set, not recalculated").
//
// The first time a FINISHED month is opened, its whole overview payload is
// stored here and every later view of that month serves the stored copy.
// The current month and the all-time view are never frozen.
//
// Known limit: the freeze happens on that first view, usually the 1st or
// 2nd of the next month. A job card closed or corrected after that never
// shows in the frozen month. `frozen_at` records when it happened.
//
// No schema work on the READ (see readSnapshot in dashboard-snapshot.ts: DDL
// per read took production down on 2026-08-02). A missing table on the read
// just means "not frozen yet"; the write creates it.
// ---------------------------------------------------------------------------
const FROZEN_DDL = `CREATE TABLE IF NOT EXISTS dashboard_month_frozen (
  org_id    TEXT NOT NULL,
  period    TEXT NOT NULL,
  data      JSONB NOT NULL,
  frozen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, period)
)`;
let frozenTablePromise: Promise<void> | null = null;

export async function readFrozenMonth(
  db: D1Database,
  orgId: string,
  period: string,
): Promise<Record<string, unknown> | null> {
  let row: { data: unknown } | null;
  try {
    row = await db
      .prepare(`SELECT data FROM dashboard_month_frozen WHERE org_id = ? AND period = ?`)
      .bind(orgId, period)
      .first<{ data: unknown }>();
  } catch (e) {
    if (!isBenignSelfApplyError(e)) throw e;
    return null; // table not created yet
  }
  if (!row) return null;
  return typeof row.data === "string"
    ? (JSON.parse(row.data) as Record<string, unknown>)
    : (row.data as Record<string, unknown>);
}

/** Store a past month once. A second writer racing the first is a no-op. */
export async function freezeMonth(
  db: D1Database,
  orgId: string,
  period: string,
  data: Record<string, unknown>,
): Promise<void> {
  await memoizeSelfApply(
    () => frozenTablePromise,
    (p) => {
      frozenTablePromise = p;
    },
    () => runSelfApply(db, "dashboard_month_frozen", [FROZEN_DDL]),
  );
  await db
    .prepare(
      `INSERT INTO dashboard_month_frozen (org_id, period, data)
       VALUES (?, ?, ?)
       ON CONFLICT (org_id, period) DO NOTHING`,
    )
    .bind(orgId, period, JSON.stringify(data))
    .run();
}
