// ---------------------------------------------------------------------------
// dashboard-daily-slice.ts — the "Daily (Lim)" dashboard tab's feed slice.
// Pure function over rows dashboard-prototype.ts has ALREADY loaded: no query,
// no new column. Read-only.
//
// DEFINITIONS (the UI repeats these in its subtitles — keep them in sync):
//
//  PLAN vs ACTUAL, per day per department — job-card based, the same three
//  measures as the Schedule email (schedule-overdue-report.ts): job cards,
//  units, planned time.
//    plan   = job cards (not CANCELLED, PO not CANCELLED) whose due_date is
//             that day.
//    actual = job cards COMPLETED/TRANSFERRED whose completed_date is that day.
//    units  = the card's production-order quantity (as the email counts it).
//    minutes= estimate-first (est_minutes, else actual_minutes) through
//             jcMinutesTotal, on BOTH sides, so actual = the planned time of
//             the work that finished. (The email uses actual-first, but it only
//             lists open cards, where that is the estimate anyway.)
//    Two independent tallies by date: a card finished late counts as actual
//    on the day it finished and as plan on the day it was due.
//
//  PRODUCTION REVENUE, per day
//    Pre-aggregated in SQL by dashboard-prototype.ts with the main dashboard's
//    definition (dashboard-overview.ts, Employee /production-revenue): a PO
//    books on the day its LAST upholstery job card completes, SO line → CO
//    line → product master price × qty, SOFA/BEDFRAME/ACCESSORY, integer sen.
//    It is the value of what production finished, NOT invoiced or delivered
//    revenue. Orders whose price resolves to 0 are counted in
//    `unpricedOrders`, not hidden.
// ---------------------------------------------------------------------------
import { jcMinutesTotal } from "../../lib/job-card-minutes";

export type DailyPo = {
  id: string;
  status: string | null;
  quantity: number | string | null;
};
export type DailyJc = {
  productionOrderId?: string | null;
  estMinutes?: number | string | null;
  actualMinutes?: number | string | null;
  wipQty?: number | string | null;
  departmentCode: string | null;
  status: string | null;
  dueDate: string | null;
  completedDate: string | null;
};

export type DailyRevenueRow = {
  date: string;
  orders: number | string;
  unpricedOrders: number | string;
  revenueSen: number | string;
};

export type StageDay = {
  date: string; dept: string;
  plan: number; actual: number;
  planUnits: number; actualUnits: number;
  planMin: number; actualMin: number;
};

export type DailySlice = {
  stages: {
    byDay: StageDay[];
    cardsWithoutDue: number;
  };
  // null when the value maps could not be loaded (reason says why).
  revenue: {
    byDay: { date: string; orders: number; unpricedOrders: number; revenueSen: number }[];
    unpricedOrders: number;
  } | null;
  revenueError?: string;
};

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const day = (v: string | null | undefined) => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v ?? "");
  return m ? m[1] : null;
};
const up = (s: string | null | undefined) => (s ?? "").toUpperCase();

export function buildDailySlice(
  pos: DailyPo[],
  cards: DailyJc[],
  revenueByDay: DailyRevenueRow[] | null,
  revenueError?: string,
): DailySlice {
  const poById = new Map(pos.map((p) => [p.id, p]));

  const rev = (revenueByDay ?? []).flatMap((r) => {
    const d = day(r.date);
    return d ? [{ date: d, orders: num(r.orders), unpricedOrders: num(r.unpricedOrders), revenueSen: Math.round(num(r.revenueSen)) }] : [];
  });

  const stg = new Map<string, StageDay>();
  const s = (d: string, dept: string) => {
    const k = `${d}|${dept}`;
    let e = stg.get(k);
    if (!e) stg.set(k, (e = { date: d, dept, plan: 0, actual: 0, planUnits: 0, actualUnits: 0, planMin: 0, actualMin: 0 }));
    return e;
  };
  let cardsWithoutDue = 0;
  for (const c of cards) {
    const st = up(c.status);
    const po = c.productionOrderId ? poById.get(c.productionOrderId) : undefined;
    if (st === "CANCELLED" || up(po?.status) === "CANCELLED") continue;
    const dept = c.departmentCode || "(no dept)";
    const units = num(po?.quantity);
    const mins = jcMinutesTotal(num(c.estMinutes) || num(c.actualMinutes), {
      departmentCode: c.departmentCode, wipQty: num(c.wipQty),
    });
    const due = day(c.dueDate);
    if (due) {
      const e = s(due, dept);
      e.plan++;
      e.planUnits += units;
      e.planMin += mins;
    } else cardsWithoutDue++;
    if (st === "COMPLETED" || st === "TRANSFERRED") {
      const d = day(c.completedDate);
      if (d) {
        const e = s(d, dept);
        e.actual++;
        e.actualUnits += units;
        e.actualMin += mins;
      }
    }
  }

  const byDate = <T extends { date: string }>(a: T, b: T) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return {
    stages: { byDay: [...stg.values()].sort(byDate), cardsWithoutDue },
    revenue: revenueByDay ? { byDay: rev.sort(byDate), unpricedOrders: rev.reduce((a, r) => a + r.unpricedOrders, 0) } : null,
    ...(revenueError ? { revenueError } : {}),
  };
}
