// ---------------------------------------------------------------------------
// Command Center figures — ONE copy of each formula, imported by BOTH
// /dashboard (./index.tsx) and /dashboard-experimental (src/pages/dashboards).
//
// Director 2026-09-23: whatever the dashboards show, the experimental one must
// show too, with the same value. The way two screens stop agreeing is two
// copies of a formula, so the derivations live here and nowhere else. Pure (no
// React) so node --test can import it: tests/command-center-lib.test.mjs.
// ---------------------------------------------------------------------------

export type SoStats = {
  success?: boolean;
  total?: number;
  csRevenueSen?: number;
  deliveredItemsSen?: number;
  outstandingItemsSen?: number;
};
export type JobsBreakdown = {
  bedframeUnits: number;
  sofaSets: number;
  byCustomer: { customer: string; bedframeUnits: number; sofaSets: number }[];
};
/**
 * One category's customer-revenue concentration, over ALL customers with
 * revenue in the period. `largestPct` / `top10Pct` are null — never 0 — when
 * the period has no revenue: 0% concentration reads as "perfectly spread",
 * which is a claim, and "no revenue observed" is not that claim.
 */
export type ConcentrationSlice = {
  totalSen: number;
  customerCount: number;
  largestName: string | null;
  largestPct: number | null;
  largestSen: number;
  top10Pct: number | null;
  top10Sen: number;
};
export type DeptBacklog = {
  dept: string;
  sofaMin: number;
  bedframeMin: number;
  totalMin: number;
  dailyCapMin: number;
  // null = "stalled" (zero completions in the rolling window — no honest way
  // to express the queue in days).
  backlogDays: number | null;
};
export type StateSnapshot = {
  source: "live" | "snapshot" | "reconstructed";
  isHistorical: boolean; // true → past-month value (snapshot-less): live or reconstructed
  asOf: string | null; // snap_date (snapshot) or month-end (reconstructed)
};
/** GET /api/dashboard/overview?period=all|YYYY-MM */
export type Overview = {
  success?: boolean;
  salesMonths?: string[];
  salesThisMonthSen?: number;
  deliveredThisMonthSen?: number;
  invoicesThisMonthSen?: number;
  deliveredOfMonthOrdersSen?: number;
  production?: {
    dailyCapacityMin: number;
    backlogMin: number;
    backlogDays: number;
    activeJobs: JobsBreakdown;
    completedYesterday: JobsBreakdown;
    completedLast7: { date: string; bedframeUnits: number; sofaSets: number }[];
    /** Whole-window totals, deduped — NOT the per-day series added up. */
    completedRange?: { bedframeUnits: number; sofaSets: number };
    capacityDays: { date: string; minutes: number; workers: number }[];
    backlogByDept: DeptBacklog[];
    backlogGrandMin: number;
  };
  purchasing?: {
    openPOCount: number;
    spendThisMonthSen: number;
    outstandingPOValueSen: number;
    itemsPendingReceipt: number;
    grnsPendingQC: number;
    topSuppliers: { name: string; spendSen: number }[];
    /** Which month the money figures belong to; "all" for all-time. */
    period: string;
    /** The month before it, or "" on all-time. */
    prevPeriod: string;
    piSpendThisMonthSen: number;
    piSpendPrevMonthSen: number;
    topSuppliersByPi: { name: string; spendSen: number; invoices: number }[];
  };
  fabricCostPerMeterSen?: {
    total: number;
    exclBedframeSofa: number;
    bedframe: number;
    sofa: number;
  };
  aovByCustomer?: {
    customerName: string;
    bedframeAvgSen: number;
    bedframeUnits: number;
    sofaAvgSen: number;
    sofaSets: number;
    totalSen: number;
  }[];
  aovCompany?: {
    bedframeAvgSen: number;
    bedframeUnits: number;
    sofaAvgSen: number;
    sofaSets: number;
    totalSen: number;
  };
  /** Server-computed over ALL customers — see dashboard-overview.ts. */
  customerConcentration?: {
    all: ConcentrationSlice;
    bedframe: ConcentrationSlice;
    sofa: ConcentrationSlice;
    shownCount: number;
  };
  aovMonthlyByCustomer?: Record<
    string,
    {
      month: string;
      bedframeAvgSen: number;
      bedframeUnits: number;
      sofaAvgSen: number;
      sofaSets: number;
    }[]
  >;
  topSellers?: {
    BEDFRAME: { productCode: string; qtySold: number; valueSen: number }[];
    SOFA: { model: string; setsSold: number; valueSen: number }[];
  };
  topSellersByCustomer?: {
    BEDFRAME: Record<string, { customer: string; qty: number; valueSen: number }[]>;
    SOFA: Record<string, { customer: string; sets: number; valueSen: number }[]>;
  };
  monthlySalesByCustomer?: Record<
    string,
    { customer: string; bedframeUnits: number; sofaSets: number }[]
  >;
  monthlySales?: { month: string; bedframeUnits: number; sofaSets: number }[];
  fabric?: {
    BEDFRAME: {
      list: {
        fabCode: string;
        meters: number;
        past30Meters: number;
        next30Meters: number;
        buyAvgSen: number;
        buyMinSen: number;
        buyMaxSen: number;
      }[];
      monthly: { month: string; meters: number; lateMeters?: number }[];
    };
    SOFA: {
      list: {
        fabCode: string;
        meters: number;
        past30Meters: number;
        next30Meters: number;
        buyAvgSen: number;
        buyMinSen: number;
        buyMaxSen: number;
      }[];
      monthly: { month: string; meters: number; lateMeters?: number }[];
    };
  };
  monthlyRevenue?: {
    month: string;
    salesOrderSen: number;
    invoiceSen: number;
    productionSen: number;
  }[];
  weeklyRevenue?: {
    week: string; // ISO week-start date "YYYY-MM-DD" (Monday)
    salesOrderSen: number;
    invoiceSen: number;
    productionSen: number;
  }[];
  employee?: { activeHeadcount: number };
  // Command Center month-awareness. Describes whether the point-in-time
  // STATE widgets (Backlog, Active Jobs, Workforce) reflect a true
  // historical snapshot, the current live value, or a live value shown for
  // a past month with NO stored history (→ show a muted "live" tag).
  stateSnapshot?: StateSnapshot;
};
// Σ valueSen of every PO that is made-but-not-yet-on-a-DO, computed server-side
// by GET /api/delivery-orders/pending-value off the SAME buildReadyPlanning rows
// the Delivery page's Pending-Delivery tab lists. Integer sen.
export type PendingValueResp = {
  success?: boolean;
  pendingDeliveryValueSen?: number;
  readyCount?: number;
};
/** GET /api/delivery-orders/stats — whole-dataset per-status value sums. */
export type DoStatsResp = { valueByStatus?: Record<string, number> };
// Daily Report (process / SOP exceptions) summary. Mirrors
// src/api/lib/compliance-report.ts counts.
export type ComplianceResp = {
  success?: boolean;
  data?: {
    // BUG-2026-08-13-141: each per-check count is `number | null`, and `null`
    // means the check THREW. `0` now only ever means "looked, found nothing".
    counts: {
      total: number;
      /** Coverage of the sweep. `checksRun < checksTotal` ⇒ partial report. */
      checksRun?: number;
      checksTotal?: number;
      doPendingDispatch: number | null;
      doNotDelivered: number | null;
      doNotInvoiced: number | null;
      soNoDo: number | null;
      soNoInvoice: number | null;
      // The two biggest categories on prod (114 + 39 of 380) and absent from
      // this projection until 2026-08-05, which is why they never reached a chip.
      pricingIssues: number | null;
      cogsIssues: number | null;
      overdueOrders: number | null;
      poNotReceived: number | null;
      lowEfficiencyWorkers: number | null;
      processSkips: number | null;
      missingWipTimes: number | null;
      incompleteBoms: number | null;
      rdStalled: number | null;
    };
    unavailable?: { check: string; message: string }[];
  };
};

/** The current "YYYY-MM" — the Command Center's default period. */
export const CUR_YM = new Date().toISOString().slice(0, 7);

// Date range for a selected "YYYY-MM": [1st .. month end]. The current
// month is capped at today; a past month runs to its last calendar day.
export function monthWindow(ym: string, curYm: string = CUR_YM): { from: string; to: string } {
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const yr = Number(ym.slice(0, 4));
  const mo = Number(ym.slice(5, 7)); // 1-12
  const from = iso(new Date(yr, mo - 1, 1));
  const lastDay = new Date(yr, mo, 0); // day 0 of next month
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const to = ym === curYm && today < lastDay ? iso(today) : iso(lastDay);
  return { from, to };
}

// Dispatch-chain fold (owner 2026-06-11: "Pending Dispatch 放入 Pending
// Delivery,Dispatch 放进 Delivered"): value of DOs created but not yet
// dispatched joins the PENDING DELIVERY card; value on the truck
// (LOADED / IN_TRANSIT) joins it too. Read from the whole-dataset /stats
// valueByStatus aggregate (same per-DO value resolver the Delivery page tab
// strip uses), so both screens tie AND the values are complete — the old
// 200-row page sum undercounted once DOs exceed 200.
export function dispatchChain(doStats: DoStatsResp | null | undefined) {
  const v = doStats?.valueByStatus ?? {};
  const pendingDispatchSen = v.DRAFT ?? 0;
  const inTransitSen = (v.LOADED ?? 0) + (v.IN_TRANSIT ?? 0);
  return { pendingDispatchSen, inTransitSen };
}

/**
 * "Pending Delivery" tile: everything made but not yet delivered — pending
 * delivery (made, not on a dispatched DO) + pending dispatch (DRAFT DOs) +
 * dispatched / in transit. A live as-of-now figure (not period-scoped).
 * Owner 2026-06-12.
 */
export function pendingDeliveryTotalSen(
  pending: PendingValueResp | null | undefined,
  doStats: DoStatsResp | null | undefined,
): number {
  const chain = dispatchChain(doStats);
  return (pending?.pendingDeliveryValueSen ?? 0) + chain.pendingDispatchSen + chain.inTransitSen;
}

/**
 * Order Pipeline. The /api/sales-orders/stats endpoint is NOT period-aware (it
 * only aggregates the whole table), so for a selected month the month-scoped
 * figures the overview payload computes are used instead.
 *   • period === "all" → all-time so.* values.
 *   • a month          → SAME-COHORT funnel of the orders confirmed that
 *     month: confirmed = salesThisMonthSen, delivered = how much of THAT
 *     cohort has shipped (deliveredOfMonthOrdersSen — the SO's confirm-month,
 *     not the ship date), outstanding = the rest. So delivered ≤ confirmed and
 *     Outstanding is meaningful (≠ the dispatch-month "delivered this month"
 *     figure, which folds in prior-month backlog and can exceed 100%).
 * Percentages are returned unrounded; the caller decides how to print them.
 */
export function orderPipeline(period: string, so: SoStats, ov: Overview) {
  const delivered = so.deliveredItemsSen ?? 0;
  const outstanding = so.outstandingItemsSen ?? 0;
  const confirmedAll = so.csRevenueSen ?? delivered + outstanding;
  const monthScoped = period !== "all";
  const confirmed = monthScoped ? (ov.salesThisMonthSen ?? 0) : confirmedAll;
  const pipeDelivered = monthScoped ? (ov.deliveredOfMonthOrdersSen ?? 0) : delivered;
  const pipeOutstanding = monthScoped ? Math.max(0, confirmed - pipeDelivered) : outstanding;
  return {
    monthScoped,
    confirmed,
    delivered: pipeDelivered,
    outstanding: pipeOutstanding,
    max: Math.max(1, confirmed, pipeDelivered, pipeOutstanding),
    deliveredRate: confirmed > 0 ? (pipeDelivered / confirmed) * 100 : 0,
    outstandingPct: confirmed > 0 ? (pipeOutstanding / confirmed) * 100 : 0,
  };
}

/**
 * Daily Report summary.
 *
 * `failedUnknown` = the fetch failed with no body (isUnknownOutcome). A dead
 * read must not become a green "All clear": `total ?? 0` used to print a large
 * green 0 whenever the fetch timed out — the same state a genuinely clean day
 * produces (C15). And a fetch can SUCCEED while some checks inside it did not
 * run (BUG-2026-08-13-141): a partial sweep may not borrow the words "All clear".
 *
 * `chips` is every category behind the headline, biggest first, top four. The
 * list used to omit the three LARGEST and take the first four in declaration
 * order — 35 under a headline of 380.
 */
export function complianceSummary(raw: ComplianceResp | null | undefined, failedUnknown: boolean) {
  const counts = raw?.data?.counts;
  const failed = !counts && failedUnknown;
  const unavailable = raw?.data?.unavailable?.length ?? 0;
  const checksTotal = counts?.checksTotal ?? 15;
  const partial = !failed && unavailable > 0;
  const chips: [string, number][] = counts
    ? (
        [
          ["Overdue", counts.overdueOrders],
          ["SO not invoiced", counts.soNoInvoice],
          ["Pricing issues", counts.pricingIssues],
          ["COGS issues", counts.cogsIssues],
          ["DO not invoiced", counts.doNotInvoiced],
          ["DO pending dispatch", counts.doPendingDispatch],
          ["DO not delivered", counts.doNotDelivered],
          ["SO no DO", counts.soNoDo],
          ["PO not received", counts.poNotReceived],
          ["Low efficiency", counts.lowEfficiencyWorkers],
          ["Process skips", counts.processSkips],
          ["Missing WIP times", counts.missingWipTimes],
          ["Incomplete BOMs", counts.incompleteBoms],
          ["R&D stalled", counts.rdStalled],
        ] as [string, number | null][]
      )
        .filter(([, n]) => (n ?? 0) > 0)
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
        .slice(0, 4)
        .map(([label, n]) => [label, n ?? 0])
    : [];
  const total = counts?.total ?? 0;
  const caption = failed
    ? "Couldn't load — this is not a clean day, it is an unknown one"
    : partial
      ? `${unavailable} of ${checksTotal} checks couldn't run — this count is a floor, not a total`
      : total === 0
        ? "All clear — nothing flagged today"
        : "process & SOP exceptions to action today";
  return { counts, failed, unavailable, checksTotal, partial, total, chips, caption };
}

/**
 * Department Backlog bars. Widths scale by DAYS-to-clear, not raw minutes
 * (2026-05-25: "22.8d 的 bar 比 8.7d 还短"). dailyCapMin === 0 → "stalled":
 * never divide by a 1-minute fallback — that painted thousands of fake days
 * (owner audit 2026-07-11). With one category toggled off, the row shows only
 * the visible segments' days.
 */
export function deptBacklogRows(depts: DeptBacklog[], sofaOn: boolean, bedOn: boolean) {
  const rows = depts.map((d) => {
    const stalled = !(d.dailyCapMin > 0);
    const cap = stalled ? 1 : d.dailyCapMin;
    const sofaDays = sofaOn && !stalled ? d.sofaMin / cap : 0;
    const bedDays = bedOn && !stalled ? d.bedframeMin / cap : 0;
    const filtered = !(sofaOn && bedOn);
    const showDays = stalled ? null : filtered ? sofaDays + bedDays : d.backlogDays;
    return { d, sofaDays, bedDays, showDays };
  });
  const mxDays = Math.max(1, ...rows.map((r) => r.showDays ?? 0));
  return { rows, mxDays };
}

/**
 * Completed headline. All-time shows yesterday's live pulse; a selected month
 * shows that month's RUNNING TOTAL. Takes the server's whole-window total:
 * adding up the per-day series double-counts sofa sets, which are a DISTINCT
 * count of sales orders — an order finishing across two days appears in both.
 * Falls back to the sum only if an older payload has no range total.
 * Counts a production order on the day its LAST job card closes.
 */
export function completedHeadline(period: string, prod: Overview["production"] | undefined) {
  const allTime = period === "all";
  const series = prod?.completedLast7 ?? [];
  const monthBf =
    prod?.completedRange?.bedframeUnits ?? series.reduce((s, d) => s + (d.bedframeUnits || 0), 0);
  const monthSofa =
    prod?.completedRange?.sofaSets ?? series.reduce((s, d) => s + (d.sofaSets || 0), 0);
  return {
    allTime,
    bedframeUnits: allTime ? (prod?.completedYesterday?.bedframeUnits ?? 0) : monthBf,
    sofaSets: allTime ? (prod?.completedYesterday?.sofaSets ?? 0) : monthSofa,
    days: series,
  };
}

/**
 * Month-awareness of the point-in-time STATE widgets (Backlog / Active Jobs /
 * Workforce):
 *   • "snapshot"      → a captured daily snapshot for that past month: "as of".
 *   • "reconstructed" → rebuilt as of the month's last day (estimate).
 *   • "live" + isHistorical → live value shown for a past month (warn).
 *   • "live" (current / all) → no tag.
 */
export function stateTags(ss: StateSnapshot | undefined) {
  const reconstructed = ss?.source === "reconstructed";
  return {
    reconstructed,
    liveTag: ss?.isHistorical === true && !reconstructed,
    asOf: ss?.source === "snapshot" || reconstructed ? (ss?.asOf ?? null) : null,
  };
}
