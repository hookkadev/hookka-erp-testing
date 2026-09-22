// Last verified: 2026-09-21 against src/api/routes/accounting.ts (`loadFinanceSeries`).
//
// GET /api/dashboard/finance?mode=monthly|ytd&month=YYYY-MM  — the Finance tab.
// PUT /api/dashboard/finance/valuation                        — owner-entered valuation.
//
// WHY A SEPARATE ENDPOINT: these are ledger-derived figures (profit, assets,
// equity, payroll cost). GET /api/dashboard/prototype is cached and shared
// across the org, so nothing financial may ride on it. This route is gated by
// the ACCOUNTING read permission — the same gate as the P&L / Balance Sheet
// endpoints it reads through — and answers `Cache-Control: no-store`.
//
// The maths is in lib/dashboard-finance.ts (pure); the ledger figures come from
// accounting.ts `loadFinanceSeries` (the P&L and Balance Sheet code itself).
//
// VALUATION (P/E): a private company has no share price, so P/E needs an
// owner-entered valuation. Stored in kv_config key `company_valuation_sen`
// (integer sen, same store as `rm_valuation_mode`); written by accounting
// `update` permission, exactly like the other accounting settings.
import { Hono } from "hono";
import type { Env } from "../worker";
import { getOrgId } from "../lib/tenant";
import { requirePermission, hasPermission } from "../lib/rbac";
import { emitAudit } from "../lib/audit";
import { getFyeMonth } from "../lib/fiscal";
import { countsToHeadcount } from "../lib/headcount-rule";
import {
  addMonths,
  buildFinancePayload,
  headcountAt,
  type FinMonth,
  type Mode,
  type WorkerLite,
} from "../lib/dashboard-finance";
import { loadFinanceSeries } from "./accounting";

const app = new Hono<Env>();

export const VALUATION_KV_KEY = "company_valuation_sen";
const HISTORY_MONTHS = 24; // enough for YoY, trailing-12 and the last full fiscal year
const MAX_VALUATION_RM = 1_000_000_000_000;

app.get("/", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  c.header("Cache-Control", "no-store");

  const month = c.req.query("month") ?? "";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return c.json({ success: false, error: "month must be YYYY-MM" }, 400);
  }
  const mode: Mode = c.req.query("mode") === "ytd" ? "ytd" : "monthly";
  const nowYm = new Date().toISOString().slice(0, 7);
  // YTD is the picker's whole calendar year, but months that have not happened
  // yet carry no ledger — the window ends at the current month for this year.
  const year = month.slice(0, 4);
  let endYm = month;
  if (mode === "ytd") endYm = `${year}-12` < nowYm ? `${year}-12` : nowYm >= `${year}-01` ? nowYm : month;

  try {
    const db = c.var.DB;
    const months: string[] = [];
    for (let i = HISTORY_MONTHS - 1; i >= 0; i--) months.push(addMonths(endYm, -i));

    const [series, workersRes, fyeMonth, valRow, canEdit] = await Promise.all([
      loadFinanceSeries(db, getOrgId(c), months),
      db
        .prepare("SELECT emp_no, status, join_date, resigned_at FROM workers")
        .all<{ emp_no?: string | null; empNo?: string | null; status: string | null; join_date?: string | null; joinDate?: string | null; resigned_at?: string | null; resignedAt?: string | null }>(),
      getFyeMonth(db),
      db
        .prepare("SELECT value FROM kv_config WHERE key = ?")
        .bind(VALUATION_KV_KEY)
        .first<{ value: string | null }>()
        .catch(() => null),
      hasPermission(c, "accounting", "update"),
    ]);
    const workers: WorkerLite[] = (workersRes.results ?? []).map((w) => ({
      empNo: (w.empNo ?? w.emp_no) ?? null,
      status: w.status,
      joinDate: (w.joinDate ?? w.join_date) ? String(w.joinDate ?? w.join_date) : null,
      resignedAt: (w.resignedAt ?? w.resigned_at) ? String(w.resignedAt ?? w.resigned_at) : null,
    }));
    const rows: FinMonth[] = series.map((r) => ({
      ...r,
      headcount: headcountAt(workers, r.ym, nowYm, countsToHeadcount),
    }));
    const valSen = Math.round(Number(valRow?.value));
    const valuationSen = Number.isFinite(valSen) && valSen > 0 ? valSen : null;

    const payload = buildFinancePayload(rows, { mode, month, endYm, fyeMonth, valuationSen });
    return c.json({
      success: true,
      data: {
        ...payload,
        meta: {
          canEditValuation: canEdit,
          headcountBasis:
            "Headcount = ACTIVE, non-TEST workers (the Employees rule). The current month uses the live status; finished months are reconstructed from join / resign dates (INACTIVE workers carry no date and are excluded from history). YTD uses the average of the month-end headcounts.",
          fyeMonth,
        },
      },
    });
  } catch (e) {
    console.error("[dashboard-finance] failed:", e);
    return c.json({ success: false, error: "Could not build the finance figures" }, 500);
  }
});

// Owner-entered company valuation, RM. null / 0 clears it.
app.put("/valuation", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as { valuationRm?: number | null };
  const raw = body.valuationRm;
  let sen: number | null;
  if (raw === null || raw === undefined || raw === 0) sen = null;
  else if (typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw <= MAX_VALUATION_RM) sen = Math.round(raw * 100);
  else return c.json({ success: false, error: "valuationRm must be a positive number, or null to clear" }, 400);

  if (sen === null) {
    await c.var.DB.prepare("DELETE FROM kv_config WHERE key = ?").bind(VALUATION_KV_KEY).run();
  } else {
    await c.var.DB.prepare(
      `INSERT INTO kv_config (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
      .bind(VALUATION_KV_KEY, String(sen), new Date().toISOString())
      .run();
  }
  await emitAudit(c, {
    resource: "accounting",
    resourceId: VALUATION_KV_KEY,
    action: "update",
    after: { valuationSen: sen },
  });
  return c.json({ success: true, data: { valuationSen: sen } });
});

export default app;
