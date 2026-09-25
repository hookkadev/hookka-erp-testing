// Pure calculations shared by the desktop dashboard views (AllOverviewView,
// SalesOrdersView) AND the /m mobile dashboard (src/pages/m/screens/dashboard).
// Extracted from those views verbatim so both surfaces compute the same
// numbers — change a rule here, both follow. No React, no DOM: node --test can
// import it (tests/dashboard-sales-lib.test.mjs).
import { isOutstanding, isPendingDelivery, isCompleted } from "../../lib/so-status";
import {
  inPeriod, inFocus, previousPeriod, periodLabel, dayLabel, isConfirmedOrder, ymd,
  type Period,
} from "./dashboard-shared-lib";

export type ByDay = { date: string; orders: number; revenueSen: number; cancelled?: number };
export type SalesOrderRow = {
  customer: string | null;
  status: string;
  totalSen: number;
  createdAt: string | null;
};

export const pctDelta = (now: number, prev: number): string => {
  const d = ((now - prev) / prev) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`;
};

// ---------------------------------------------------------------------------
// Revenue trend. Monthly/range = one point per DAY, zero-filled (the feed only
// returns days that have rows; a quiet day is a real zero, not a gap) and
// capped at `today` (a future day is unknown, not zero). YTD = one point per
// month. `today` is a parameter so tests are deterministic.
// ---------------------------------------------------------------------------
export type TrendPoint = { date: string; iso: string; Revenue: number; Orders: number };

export function buildSalesTrend(byDay: ByDay[], period: Period, today: string): TrendPoint[] {
  const sorted = [...byDay].sort((a, b) => (a.date < b.date ? -1 : 1));

  if (period.mode === "ytd") {
    const byMonth = new Map<string, { revenueSen: number; orders: number }>();
    for (const d of sorted) {
      const m = d.date.slice(0, 7);
      const e = byMonth.get(m) ?? { revenueSen: 0, orders: 0 };
      e.revenueSen += d.revenueSen;
      e.orders += d.orders;
      byMonth.set(m, e);
    }
    return [...byMonth.entries()].map(([m, v]) => ({
      date: m.slice(5),
      iso: m,
      Revenue: Math.round(v.revenueSen / 100),
      Orders: v.orders,
    }));
  }

  const have = new Map(sorted.map((d) => [d.date, d]));
  let first: string;
  let last: string;
  if (period.mode === "range" && period.from && period.to) {
    first = period.from;
    last = period.to;
  } else {
    const [y, m] = period.month.split("-").map(Number);
    if (!y || !m) return [];
    first = `${period.month}-01`;
    last = `${period.month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
  }
  if (last > today) last = today;
  if (first > last) return [];

  const out: TrendPoint[] = [];
  const cursor = new Date(first + "T00:00:00");
  const end = new Date(last + "T00:00:00");
  while (cursor <= end) {
    const iso = ymd(cursor);
    const hit = have.get(iso);
    out.push({
      date: iso.slice(8),
      iso,
      Revenue: hit ? Math.round(hit.revenueSen / 100) : 0,
      Orders: hit ? hit.orders : 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

// KPI set over an already period/day-scoped order list. Count and money share
// ONE definition (confirmed orders only).
export function computeSalesKpis(scopedOrders: SalesOrderRow[]) {
  const live = scopedOrders.filter((o) => isConfirmedOrder(o.status));
  const outstanding = scopedOrders.filter((o) => isOutstanding(o.status));
  const pending = scopedOrders.filter((o) => isPendingDelivery(o.status));
  const completed = scopedOrders.filter((o) => isCompleted(o.status));
  return {
    soCount: live.length,
    revenueSen: live.reduce((s, o) => s + o.totalSen, 0),
    outstandingCount: outstanding.length,
    outstandingSen: outstanding.reduce((s, o) => s + o.totalSen, 0),
    pendingDelivery: pending.length,
    pendingDeliverySen: pending.reduce((s, o) => s + o.totalSen, 0),
    completedCount: completed.length,
  };
}

// The same headline over the previous comparable period. Null while a single
// day is focused (day-vs-month is a wrong comparison) or when none exists.
export function previousSalesKpis(
  allOrders: SalesOrderRow[],
  period: Period,
  months: string[],
  dayFocused: boolean,
) {
  if (dayFocused) return null;
  const prev = previousPeriod(period, months);
  if (!prev) return null;
  const rows = allOrders
    .filter((o) => inPeriod(prev, o.createdAt))
    .filter((o) => isConfirmedOrder(o.status));
  return {
    label: periodLabel(prev),
    count: rows.length,
    revenueSen: rows.reduce((s, o) => s + o.totalSen, 0),
  };
}

// Revenue per customer, largest first. Mirrors the Overview card's grouping
// (null customer = "Unnamed").
export function customerRevenue(orders: SalesOrderRow[]) {
  const by = new Map<string, { revenueSen: number; count: number }>();
  for (const o of orders) {
    const k = o.customer ?? "Unnamed";
    const e = by.get(k) ?? { revenueSen: 0, count: 0 };
    e.revenueSen += o.totalSen;
    e.count += 1;
    by.set(k, e);
  }
  return [...by.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.revenueSen - a.revenueSen);
}

// ---- Overview ------------------------------------------------------------
// A focused day reads that day alone and compares it with the day before -
// day-vs-month would be a wrong comparison.
export function overviewTotals(byDay: ByDay[], period: Period, months: string[]) {
  const days = byDay.filter((d) => inFocus(period, d.date));
  let dayBefore = "";
  if (period.day) {
    const [y, m, d] = period.day.split("-").map(Number);
    dayBefore = ymd(new Date(y, m - 1, d - 1));
  }
  const prev = period.day ? null : previousPeriod(period, months);
  const prevDays = period.day
    ? byDay.filter((d) => d.date === dayBefore)
    : prev ? byDay.filter((d) => inPeriod(prev, d.date)) : [];
  const revenueSen = days.reduce((s, d) => s + d.revenueSen, 0);
  const prevRevenueSen = prevDays.reduce((s, d) => s + d.revenueSen, 0);
  return {
    revenueSen,
    orders: days.reduce((s, d) => s + d.orders, 0),
    prevRevenueSen,
    prevLabel: period.day ? dayLabel(dayBefore) : prev ? periodLabel(prev) : "",
    deltaPct: prevRevenueSen > 0 ? ((revenueSen - prevRevenueSen) / prevRevenueSen) * 100 : null,
  };
}

export function overviewSalesSnapshot(
  orders: SalesOrderRow[],
  byStateCategory: { state: string | null; category: string | null; revenueSen: number }[],
  period: Period,
) {
  const inP = orders.filter((o) => inFocus(period, o.createdAt));
  const top = customerRevenue(inP)[0];
  const total = inP.reduce((s, o) => s + o.totalSen, 0);

  // No date column on byStateCategory — these are book-wide, labelled as such.
  const byState = new Map<string, number>();
  const byCat = new Map<string, number>();
  let bookTotal = 0;
  for (const r of byStateCategory) {
    byState.set(r.state ?? "—", (byState.get(r.state ?? "—") ?? 0) + r.revenueSen);
    byCat.set(r.category ?? "—", (byCat.get(r.category ?? "—") ?? 0) + r.revenueSen);
    bookTotal += r.revenueSen;
  }
  const pick = (m: Map<string, number>) => {
    const e = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    return e && bookTotal > 0 ? `${e[0]} (${Math.round((e[1] / bookTotal) * 100)}%)` : "—";
  };
  return {
    topCustomer: top && total > 0 ? `${top.name} (${Math.round((top.revenueSen / total) * 100)}%)` : "—",
    topState: pick(byState),
    topCategory: pick(byCat),
  };
}

export type AttendanceRow = {
  date: string | null;
  status: string | null;
  efficiencyPct: number | null;
};

export function overviewWorkforce(rows: AttendanceRow[], period: Period, fmt: (n: number) => string) {
  const inP = rows.filter((r) => inFocus(period, r.date));
  const measured = inP.filter((r) => r.efficiencyPct != null);
  const avg = measured.length
    ? measured.reduce((s, r) => s + (r.efficiencyPct ?? 0), 0) / measured.length
    : null;
  // "Present" is one day's roll-call: the focused day, else the newest day recorded.
  const latest = period.day ?? rows.reduce((m, r) => (r.date && r.date > m ? r.date : m), "");
  const today = rows.filter((r) => r.date === latest);
  const present = today.filter((r) => (r.status ?? "").toUpperCase() !== "ABSENT").length;
  return {
    avg,
    presentLabel: latest ? `${fmt(present)} / ${fmt(today.length)}` : "—",
    presentDay: latest,
    measuredDays: measured.length,
  };
}
