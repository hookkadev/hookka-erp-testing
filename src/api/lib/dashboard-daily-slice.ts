// ---------------------------------------------------------------------------
// dashboard-daily-slice.ts — the "Daily (Lim)" dashboard tab's feed slice.
// Pure function over rows dashboard-prototype.ts has ALREADY loaded: no query,
// no new column. Read-only.
//
// DEFINITIONS (the UI repeats these in its subtitles — keep them in sync):
//
//  ORDER PLAN vs ACTUAL, per day
//    plan   = production orders (not CANCELLED) whose target_end_date is that
//             day — "scheduled to finish that day".
//    actual = production orders with status COMPLETED whose completed_date is
//             that day — "finished that day".
//    Both are counted in orders and in units (quantity). variance = actual −
//    plan. These are two independent tallies by date, NOT "of the orders
//    planned that day, how many finished": an order finished late counts as
//    actual on the day it finished and as plan on the day it was due.
//
//  STAGE PLAN vs ACTUAL, per day per department
//    plan   = job cards (not CANCELLED) whose due_date is that day.
//    actual = job cards COMPLETED/TRANSFERRED whose completed_date is that day.
//    Counted in cards (one card = one department stage of one order); job
//    cards carry no unit count in the feed.
//
//  PRODUCTION REVENUE, per day
//    Value of production orders that COMPLETED that day = PO quantity × the
//    unit price of its own sales-order line (do-value.ts loadPoValueMap — the
//    same resolver Delivery/Planning use, integer sen). It is the value of what
//    production finished, NOT invoiced or delivered revenue. Orders whose price
//    cannot be resolved (value 0) are counted in `unpricedOrders`, not hidden.
// ---------------------------------------------------------------------------

export type DailyPo = {
  id: string;
  status: string | null;
  quantity: number | string | null;
  targetEndDate: string | null;
  completedDate: string | null;
};
export type DailyJc = {
  departmentCode: string | null;
  status: string | null;
  dueDate: string | null;
  completedDate: string | null;
};

export type DailySlice = {
  orders: {
    byDay: { date: string; planOrders: number; planUnits: number; actualOrders: number; actualUnits: number }[];
    // Non-cancelled orders with no target_end_date cannot be planned on any day.
    withoutTarget: number;
    completedTotal: number;
  };
  stages: {
    byDay: { date: string; dept: string; plan: number; actual: number }[];
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
  poValueSen: Map<string, number> | null,
  revenueError?: string,
): DailySlice {
  const ord = new Map<string, { date: string; planOrders: number; planUnits: number; actualOrders: number; actualUnits: number }>();
  const o = (d: string) => {
    let e = ord.get(d);
    if (!e) ord.set(d, (e = { date: d, planOrders: 0, planUnits: 0, actualOrders: 0, actualUnits: 0 }));
    return e;
  };
  const rev = new Map<string, { date: string; orders: number; unpricedOrders: number; revenueSen: number }>();
  let withoutTarget = 0;
  let completedTotal = 0;
  let unpriced = 0;
  for (const p of pos) {
    const st = up(p.status);
    if (st === "CANCELLED") continue;
    const qty = num(p.quantity);
    const t = day(p.targetEndDate);
    if (t) {
      const e = o(t);
      e.planOrders++;
      e.planUnits += qty;
    } else withoutTarget++;
    if (st !== "COMPLETED") continue;
    completedTotal++;
    const c = day(p.completedDate);
    if (!c) continue;
    const e = o(c);
    e.actualOrders++;
    e.actualUnits += qty;
    if (poValueSen) {
      const v = Math.round(poValueSen.get(p.id) ?? 0);
      let r = rev.get(c);
      if (!r) rev.set(c, (r = { date: c, orders: 0, unpricedOrders: 0, revenueSen: 0 }));
      r.orders++;
      r.revenueSen += v;
      if (v <= 0) { r.unpricedOrders++; unpriced++; }
    }
  }

  const stg = new Map<string, { date: string; dept: string; plan: number; actual: number }>();
  const s = (d: string, dept: string) => {
    const k = `${d}|${dept}`;
    let e = stg.get(k);
    if (!e) stg.set(k, (e = { date: d, dept, plan: 0, actual: 0 }));
    return e;
  };
  let cardsWithoutDue = 0;
  for (const c of cards) {
    const st = up(c.status);
    if (st === "CANCELLED") continue;
    const dept = c.departmentCode || "(no dept)";
    const due = day(c.dueDate);
    if (due) s(due, dept).plan++;
    else cardsWithoutDue++;
    if (st === "COMPLETED" || st === "TRANSFERRED") {
      const d = day(c.completedDate);
      if (d) s(d, dept).actual++;
    }
  }

  const byDate = <T extends { date: string }>(a: T, b: T) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return {
    orders: { byDay: [...ord.values()].sort(byDate), withoutTarget, completedTotal },
    stages: { byDay: [...stg.values()].sort(byDate), cardsWithoutDue },
    revenue: poValueSen ? { byDay: [...rev.values()].sort(byDate), unpricedOrders: unpriced } : null,
    ...(revenueError ? { revenueError } : {}),
  };
}
