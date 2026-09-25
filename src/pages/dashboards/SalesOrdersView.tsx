import { useMemo, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  LineChart,
  Cell,
  Line,
  Bar,
  BarChart,
  Legend,
  Pie,
  PieChart,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useCachedJson } from "@/lib/cached-fetch";
import { formatCurrency } from "@/lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { CalendarX2 } from "lucide-react";
import {
  TAUPE, GREEN, AMBER, TEAL, fmtN, fmtRMAxis, ymd, dayLabel,
  CHART_INK, CHART_GOLD, CHART_AXIS, CARD_BORDER, CARD_BG, CHART_SERIES,
  inPeriod, inFocus, periodLabel, isConfirmedOrder, type Period,
} from "./dashboard-shared-lib";
import { Kpi, LiveBadge } from "./dashboard-shared";
import { CustomerRevenueCard, OrderPipelineCard, RevenueTrendCard, TopSellersCard } from "./DashboardWidgets";
import { rollingForecast } from "@/lib/revenue-forecast";
import { pctDelta, buildSalesTrend, previousSalesKpis, computeSalesKpis } from "./dashboard-sales-lib";

// Today, in the app's own local date. Used to cap the zero-fill: a future day
// has no rows because it has not happened, which is not the same as a day that
// recorded nothing.
const todayYmd = ymd(new Date());

// Six customers + Other, drawn from the shared warm-industrial series so the
// attribution chart reads as part of the same system as the trend/forecast.
const ATTR_COLORS = CHART_SERIES;

// Dark tooltip for Sales Attribution: header is the bucket and its total, then
// one row per customer with money and share, largest first. Reads __sen /
// __totalSen carried on the row so it can show both regardless of which mode
// the chart is plotting.
function AttrTooltip({
  active,
  payload,
  label,
  series,
}: {
  active?: boolean;
  payload?: { payload?: Record<string, unknown> }[];
  label?: string | number;
  series: string[];
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as
    | { __sen?: Record<string, number>; __totalSen?: number }
    | undefined;
  const sen = row?.__sen ?? {};
  const total = row?.__totalSen ?? 0;
  const rows = series
    .map((name, i) => ({ name, sen: sen[name] ?? 0, color: ATTR_COLORS[i % ATTR_COLORS.length] }))
    .filter((r) => r.sen > 0)
    .sort((a, b) => b.sen - a.sen);

  return (
    <div className="rounded-lg px-3 py-2 text-[11px] shadow-lg" style={{ background: "#2A2723", color: "#F5F1EA" }}>
      <p className="font-semibold mb-1 tabular-nums">
        {String(label ?? "")} · {formatCurrency(total)}
      </p>
      {rows.map((r) => (
        <p key={r.name} className="flex items-center gap-1.5 tabular-nums">
          <span className="h-2 w-2 rounded-full shrink-0" style={{ background: r.color }} />
          <span className="truncate max-w-[13rem]">{r.name}:</span>
          <span className="ml-auto">
            {formatCurrency(r.sen)}
            <span style={{ color: "#A39E93" }}>
              {" "}({total > 0 ? Math.round((r.sen / total) * 100) : 0}%)
            </span>
          </span>
        </p>
      ))}
    </div>
  );
}

// Real data from GET /api/dashboard/prototype (src/api/routes/dashboard-
// prototype.ts) — the SAME route + SQL the original HTML prototype read.
// Only the `sales` + `availability.sales` slices are used here; the route
// also computes delivery/inventory/purchase/employee/production, ready for
// when those tabs get ported.
type Feed = {
  success?: boolean;
  availability?: { sales?: { live: boolean; rows: number; reason?: string } };
  sales?: {
    byDay: { date: string; orders: number; revenueSen: number; cancelled: number }[];
    orders: {
      id: string;
      no: string | null;
      customer: string | null;
      status: string;
      totalSen: number;
      createdAt: string | null;
      deliveryDate: string | null;
      isServiceOrder: boolean;
    }[];
    pipeline: { status: string; count: number; valueSen: number }[];
    // One row per (order day, state, category, sku) — the day is the order's
    // createdAt, the same date every other Sales card filters on.
    byStateCategory: {
      date: string | null;
      state: string | null;
      category: string | null;
      sku: string | null;
      name: string | null;
      qty: number;
      revenueSen: number;
    }[];
  };
};

export function SalesOrdersView({
  period,
  months,
  onPeriodChange,
}: {
  period: Period;
  months: string[];
  onPeriodChange: (p: Period) => void;
}) {
  const { data, loading, error } = useCachedJson<Feed>("/api/dashboard/prototype");
  const [attrGran, setAttrGran] = useState<"monthly" | "quarterly" | "yearly">("monthly");
  const [attrView, setAttrView] = useState<"value" | "share">("value");
  const [stateFilter, setStateFilter] = useState<string | null>(null);
  const [skuCat, setSkuCat] = useState<string | null>(null);
  const [skuSort, setSkuSort] = useState<"revenue" | "units">("revenue");

  // `?? []` allocates a fresh array each render, which would make every
  // downstream useMemo re-run regardless of its deps. Memoised so the deps
  // below actually mean something.
  const allOrders = useMemo(() => data?.sales?.orders ?? [], [data]);
  const allByDay = useMemo(() => data?.sales?.byDay ?? [], [data]);
  const live = data?.availability?.sales?.live ?? false;

  // Everything with a date is scoped to the global period picker above the
  // tabs.
  const orders = useMemo(
    () => allOrders.filter((o) => inPeriod(period, o.createdAt)),
    [allOrders, period],
  );
  const byDay = useMemo(
    () => allByDay.filter((d) => inPeriod(period, d.date)),
    [allByDay, period],
  );



  // Monthly shows bare day numbers (01, 02, ...) as the design prototype does;
  // YTD rolls the days up per month so the axis stays readable.
  //
  // ZERO-FILL: the feed only returns days that HAVE rows, so a day with no
  // sales was simply absent from the axis — the chart silently skipped it and
  // the line joined across the gap as if it never existed. Every day in the
  // window is generated here and missing ones default to 0, so a quiet day
  // reads as a real zero rather than vanishing. The fill stops at today: days
  // that have not happened yet are not zeros, they are unknown.
  const chartData = useMemo(
    () => buildSalesTrend(byDay, period, todayYmd),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byDay, period.mode, period.month, period.from, period.to],
  );

  // Clicking a bar drills in: a month in YTD becomes the selected month; a day
  // anywhere else highlights that day. The highlight lives on `period.day`, the
  // same field the datepicker writes, so the chart keeps showing the whole
  // month either way and only the order-scoped panels narrow.
  const onBucketClick = (label: string) => {
    const hit = chartData.find((d) => d.date === label);
    if (!hit) return;
    if (period.mode === "ytd") {
      onPeriodChange({ mode: "monthly", month: hit.iso });
      return;
    }
    onPeriodChange({ ...period, day: period.day === hit.iso ? undefined : hit.iso });
  };

  const clearDay = () => onPeriodChange({ ...period, day: undefined });

  // The bucket key (an axis label) for whichever day is highlighted.
  const selectedBucket = useMemo(
    () => chartData.find((d) => d.iso === period.day)?.date ?? null,
    [chartData, period.day],
  );

  const selectedDetail = useMemo(() => {
    if (!period.day) return null;
    const hit = chartData.find((d) => d.iso === period.day);
    if (!hit) return null;
    return { label: hit.iso, revenueSen: hit.Revenue * 100, orders: hit.Orders };
  }, [period.day, chartData]);

  // Same KPI set over the previous comparable period, for the deltas.
  //
  // Suppressed while a single DAY is selected: comparing one day against a
  // whole previous month produced "-86.6% vs Aug 2026", which reads as a
  // collapse when it is really just a day-vs-month mismatch. No comparison is
  // better than a wrong one.
  const prevKpis = useMemo(
    () => previousSalesKpis(allOrders, period, months, !!selectedDetail),
    [allOrders, period, months, selectedDetail],
  );

  // Clicking a day in the trend narrows EVERYTHING that is order-scoped —
  // the KPI row, the pipeline and the recent list — to that day, so the cards
  // answer "what happened on the 10th" rather than staying on the month while
  // the chart below them says otherwise.
  const scopedOrders = useMemo(
    () =>
      selectedDetail
        ? orders.filter((o) => o.createdAt === selectedDetail.label)
        : orders,
    [orders, selectedDetail],
  );

  const kpis = useMemo(() => computeSalesKpis(scopedOrders), [scopedOrders]);

  // Sales Attribution — revenue by CUSTOMER over time. Granularity buckets the
  // order's own createdAt, so this one spans the whole book rather than the
  // selected period: the point of the chart is the trend BETWEEN periods.
  const attrChart = useMemo(() => {
    const bucketOf = (d: string) =>
      attrGran === "yearly"
        ? d.slice(0, 4)
        : attrGran === "quarterly"
          ? `${d.slice(0, 4)} Q${Math.ceil(Number(d.slice(5, 7)) / 3)}`
          : d.slice(0, 7);

    const totalByCustomer = new Map<string, number>();
    for (const o of allOrders) {
      if (!isConfirmedOrder(o.status) || !o.createdAt) continue;
      totalByCustomer.set(o.customer ?? "Unnamed", (totalByCustomer.get(o.customer ?? "Unnamed") ?? 0) + o.totalSen);
    }
    const grand = [...totalByCustomer.values()].reduce((s, v) => s + v, 0);
    const top = [...totalByCustomer.entries()].sort((a, b) => b[1] - a[1]);
    const names = top.slice(0, 6).map(([n]) => n);

    const buckets = new Map<string, Record<string, number>>();
    for (const o of allOrders) {
      if (!isConfirmedOrder(o.status) || !o.createdAt) continue;
      const b = bucketOf(o.createdAt);
      const row = buckets.get(b) ?? {};
      const key = names.includes(o.customer ?? "Unnamed") ? (o.customer ?? "Unnamed") : "Other";
      row[key] = (row[key] ?? 0) + o.totalSen;
      buckets.set(b, row);
    }
    const series = [...names, "Other"];
    const rows = [...buckets.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([bucket, row]) => {
        const sum = series.reduce((s, k) => s + (row[k] ?? 0), 0) || 1;
        // Carry the raw sen and the bucket total alongside the plotted value so
        // the tooltip can show BOTH money and share without a second lookup —
        // Recharts hands the whole row back on the payload.
        const sen: Record<string, number> = {};
        const out: Record<string, unknown> = { bucket, __sen: sen, __totalSen: sum };
        for (const k of series) {
          const v = row[k] ?? 0;
          sen[k] = v;
          out[k] = attrView === "share" ? (v / sum) * 100 : v / 100;
        }
        return out;
      });

    return {
      rows,
      series,
      topName: top[0]?.[0] ?? "—",
      topPct: grand > 0 && top[0] ? Math.round((top[0][1] / grand) * 100) : 0,
      grandSen: grand,
    };
  }, [allOrders, attrGran, attrView]);

  // Clicking an attribution bucket moves the global period onto it: a month
  // bucket directly, a quarter/year bucket onto its first month that the book
  // actually has (months outside the book would leave the picker stranded).
  const onAttrBucketClick = (label: string) => {
    let target: string | undefined;
    if (/^\d{4}-\d{2}$/.test(label)) target = label;
    else if (/^\d{4} Q[1-4]$/.test(label)) {
      const [y, q] = label.split(" Q");
      const first = String((Number(q) - 1) * 3 + 1).padStart(2, "0");
      target = months.find((m) => m >= `${y}-${first}` && m.slice(0, 4) === y);
    } else if (/^\d{4}$/.test(label)) {
      target = months.find((m) => m.slice(0, 4) === label);
    }
    if (target && months.includes(target)) {
      onPeriodChange({ mode: "monthly", month: target });
    }
  };

  // Sales forecast — the TARGET is the 3-month rolling average of the months
  // before it, which is what "actual vs target" means here; this book carries
  // no externally-set revenue target anywhere in the feed, and inventing one
  // would put a number on the page that nothing backs. A month is "hit" when
  // actual >= that rolling target. Future months carry the last known target
  // forward as a projection and have no actual, so they draw as empty slots
  // rather than as zero — a zero would read as "sold nothing".
  const forecast = useMemo(() => {
    const byMonth = new Map<string, number>();
    for (const d of allByDay) {
      const m = d.date.slice(0, 7);
      byMonth.set(m, (byMonth.get(m) ?? 0) + d.revenueSen);
    }
    const { actual, projected } = rollingForecast([...byMonth.entries()], 6);
    const out = actual.map((r) => ({
      month: `${r.ym.slice(5)} ${r.ym.slice(2, 4)}`,
      iso: r.ym,
      actualSen: r.sen,
      Actual: Math.round(r.sen / 100),
      Target: r.targetSen === null ? null : Math.round(r.targetSen / 100),
      hit: r.hit,
      projected: false,
    }));
    // Carry the trend forward: each projected month's target is the rolling
    // average of the last three known actuals.
    for (const p of projected) {
      out.push({
        month: `${p.ym.slice(5)} ${p.ym.slice(2, 4)}`,
        iso: p.ym,
        actualSen: 0,
        Actual: null as unknown as number,
        Target: Math.round(p.sen / 100),
        hit: null,
        projected: true,
      });
    }
    return out;
  }, [allByDay]);

  // Fulfilment pipeline follows the period picker rather than showing the
  // whole book. The feed's own `pipeline` is a book-wide aggregate, so it is
  // used ONLY for its status ordering — the counts and values are re-summed
  // from the orders already scoped to the selected period.
  const pipeline = useMemo(() => {
    const order = (data?.sales?.pipeline ?? []).map((p) => p.status);
    const acc = new Map<string, { status: string; count: number; valueSen: number }>();
    for (const o of scopedOrders) {
      const st = o.status || "—";
      const e = acc.get(st) ?? { status: st, count: 0, valueSen: 0 };
      e.count += 1;
      e.valueSen += o.totalSen;
      acc.set(st, e);
    }
    const rank = (st: string) => {
      const i = order.indexOf(st);
      return i < 0 ? order.length : i;
    };
    return [...acc.values()].sort((a, b) => rank(a.status) - rank(b.status));
  }, [scopedOrders, data]);
  const pipelineMax = Math.max(1, ...pipeline.map((p) => p.count));


  // State x Category and Top SKUs follow the picker (and a clicked day), same
  // as the KPI row and pipeline.
  const stateCatRows = useMemo(
    () => (data?.sales?.byStateCategory ?? []).filter((r) => inFocus(period, r.date)),
    [data, period],
  );
  const attribution = useMemo(() => {
    const rows = stateCatRows;
    const states = new Map<string, { state: string; revenueSen: number; qty: number }>();
    const cats = new Map<string, { category: string; revenueSen: number; qty: number }>();
    const skus = new Map<string, { sku: string; name: string; category: string; revenueSen: number; qty: number }>();
    for (const r of rows) {
      const st = r.state ?? "—";
      const ct = r.category ?? "—";
      const sk = r.sku ?? "—";
      const s = states.get(st) ?? { state: st, revenueSen: 0, qty: 0 };
      s.revenueSen += r.revenueSen; s.qty += r.qty; states.set(st, s);
      const c = cats.get(ct) ?? { category: ct, revenueSen: 0, qty: 0 };
      c.revenueSen += r.revenueSen; c.qty += r.qty; cats.set(ct, c);
      const e = skus.get(sk) ?? { sku: sk, name: r.name ?? sk, category: ct, revenueSen: 0, qty: 0 };
      e.revenueSen += r.revenueSen; e.qty += r.qty; skus.set(sk, e);
    }
    const desc = <T extends { revenueSen: number }>(a: T, b: T) => b.revenueSen - a.revenueSen;
    const total = rows.reduce((s, r) => s + r.revenueSen, 0);
    return {
      states: [...states.values()].sort(desc),
      categories: [...cats.values()].sort(desc),
      allSkus: [...skus.values()].sort(desc),
      total,
    };
  }, [stateCatRows]);

  // Donut: top states, with anything past the 6th folded into "Other" so the
  // outside labels cannot collide into an unreadable fan.
  const donutData = useMemo(() => {
    const rows = attribution.states;
    const head = rows.slice(0, 6);
    const tailSen = rows.slice(6).reduce((t, r) => t + r.revenueSen, 0);
    const tailQty = rows.slice(6).reduce((t, r) => t + r.qty, 0);
    return tailSen > 0
      ? [...head, { state: "Other", revenueSen: tailSen, qty: tailQty }]
      : head;
  }, [attribution.states]);

  const donutTop = useMemo(() => {
    const top = donutData[0];
    if (!top || attribution.total <= 0) return null;
    return { state: top.state, pct: (top.revenueSen / attribution.total) * 100 };
  }, [donutData, attribution.total]);

  // Rebuilt from the raw (state, category, sku) rows rather than from the
  // pre-aggregated list, because a state filter has to re-sum the SKUs — an
  // aggregate over every state cannot be narrowed to one afterwards.
  const visibleSkus = useMemo(() => {
    const acc = new Map<string, { sku: string; name: string; category: string; revenueSen: number; qty: number }>();
    for (const r of stateCatRows) {
      if (stateFilter && (r.state ?? "—") !== stateFilter) continue;
      if (skuCat && (r.category ?? "—") !== skuCat) continue;
      const sk = r.sku ?? "—";
      const e = acc.get(sk) ?? { sku: sk, name: r.name ?? sk, category: r.category ?? "—", revenueSen: 0, qty: 0 };
      e.revenueSen += r.revenueSen;
      e.qty += r.qty;
      acc.set(sk, e);
    }
    return [...acc.values()]
      .sort((a, b) => (skuSort === "revenue" ? b.revenueSen - a.revenueSen : b.qty - a.qty))
      .slice(0, 10);
  }, [stateCatRows, stateFilter, skuCat, skuSort]);

  const recentOrders = useMemo(
    () =>
      [...scopedOrders]
        .sort((a, b) => ((a.createdAt ?? "") < (b.createdAt ?? "") ? 1 : -1))
        .slice(0, 30),
    [scopedOrders],
  );

  if (loading) {
    return <div className="py-16 text-center text-sm text-[#6B7280]">Loading…</div>;
  }

  if (error || !data?.success) {
    return (
      <Card className="border-[#F0D9AE] bg-[#FDF3E4]">
        <CardContent className="p-4 text-sm text-[#B5701A]">
          Couldn't load Sales Orders: {error ?? "unknown error"}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6 max-md:space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Sales Orders</h2>
        <LiveBadge live={live} />
        {selectedDetail ? (
          <button
            type="button"
            onClick={clearDay}
            className="text-xs rounded-md border border-[#E5E0D8] bg-[#F7F5F3] px-2 py-0.5 text-[#6B5C32] hover:bg-white max-md:min-h-10 max-md:px-3 max-md:text-left"
          >
            Showing: {selectedDetail.label} — click to go back
          </button>
        ) : (
          <span className="text-xs text-[#6B7280]">
            {fmtN(kpis.soCount)} orders · {periodLabel(period)}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        <Kpi
          label="Total Orders"
          value={fmtN(kpis.soCount)}
          sub={
            prevKpis && prevKpis.count > 0
              ? `${pctDelta(kpis.soCount, prevKpis.count)} vs ${prevKpis.label}`
              : undefined
          }
        />
        <Kpi
          label="Revenue"
          value={formatCurrency(kpis.revenueSen)}
          sub={
            prevKpis && prevKpis.revenueSen > 0
              ? `${pctDelta(kpis.revenueSen, prevKpis.revenueSen)} vs ${prevKpis.label}`
              : undefined
          }
          valueColorClass="text-[#6B5C32]"
          valueSizeClass="text-xl"
        />
        <Kpi
          label="Outstanding"
          value={fmtN(kpis.outstandingCount)}
          sub={`${formatCurrency(kpis.outstandingSen)} value`}
          valueColorClass="text-[#9C6F1E]"
        />
        <Kpi
          label="Pending Delivery"
          value={fmtN(kpis.pendingDelivery)}
          sub={`${formatCurrency(kpis.pendingDeliverySen)} value`}
          valueColorClass="text-[#3E6570]"
        />
        <Kpi
          label="Completed"
          value={fmtN(kpis.completedCount)}
          valueColorClass="text-[#4F7C3A]"
        />
      </div>

      {/* Revenue trend + Recent orders side by side, as the design prototype
          has them. Revenue is BARS and orders a LINE on its own right-hand
          axis: two lines on one plot were unreadable where the scales differ
          by ~100x. Clicking a bar drills in — a month in YTD, a day in
          Monthly. */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2 bg-white border-[#E5E0D8]">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <CardTitle>Revenue trend</CardTitle>
              {selectedBucket && (
                <button
                  type="button"
                  onClick={clearDay}
                  className="text-xs text-[#6B5C32] underline underline-offset-2"
                >
                  clear selection
                </button>
              )}
            </div>
            <p className="text-xs text-[#6B7280]">
              {selectedDetail
                ? `${selectedDetail.label} · ${formatCurrency(selectedDetail.revenueSen)} · ${fmtN(selectedDetail.orders)} orders`
                : `${period.mode === "ytd" ? "Every month" : "Every day"} of ${periodLabel(period)} · click a bar to ${period.mode === "ytd" ? "open that month" : "highlight that day"}`}
            </p>
          </CardHeader>
          <CardContent>
            <div
              className="select-none [&_*]:outline-none [&_.recharts-wrapper]:outline-none"
              style={{ width: "100%", height: 260 }}
            >
              {chartData.length === 0 ? (
                <div className="flex items-center justify-center h-full text-xs text-[#6B7280]">
                  No orders in range.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={chartData}
                    margin={{ top: 6, right: 6, bottom: 0, left: 0 }}
                    onClick={(e) => {
                      const key = e?.activeLabel;
                      if (typeof key === "string") onBucketClick(key);
                    }}
                  >
                    <CartesianGrid vertical={false} stroke={CHART_AXIS} strokeOpacity={0.25} />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10, fill: CHART_AXIS }}
                      axisLine={{ stroke: CARD_BORDER }}
                      tickLine={false}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      yAxisId="rev"
                      tick={{ fontSize: 10, fill: CHART_AXIS }}
                      axisLine={false}
                      tickLine={false}
                      width={56}
                      tickFormatter={(v) => fmtRMAxis(Number(v))}
                    />
                    <YAxis
                      yAxisId="ord"
                      orientation="right"
                      tick={{ fontSize: 10, fill: CHART_AXIS }}
                      axisLine={false}
                      tickLine={false}
                      width={30}
                    />
                    <Tooltip
                      cursor={{ fill: "#F0ECE9" }}
                      contentStyle={{
                        background: CARD_BG,
                        border: `1px solid ${CARD_BORDER}`,
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      formatter={(value, name) => {
                        // Explicit for zero days: "RM 0.00" / "0", never a
                        // blank, a null or a skipped entry.
                        const n = Number(value ?? 0);
                        const safe = Number.isFinite(n) ? n : 0;
                        return name === "Revenue"
                          ? [formatCurrency(safe * 100), name]
                          : [fmtN(safe), name];
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar
                      yAxisId="rev"
                      dataKey="Revenue"
                      fill={CHART_INK}
                      radius={[4, 4, 0, 0]}
                      maxBarSize={28}
                      // activeBar MUST stay off. On hover Recharts lifts the
                      // hovered bar out of the bar layer (zIndex 300) and
                      // redraws it in an active-bar layer at zIndex 1000 —
                      // above the line at 400 — so the line vanished behind
                      // whichever bar the pointer was over. Styling the active
                      // bar to match does not help: the layer is the problem,
                      // not the colour. Selection is already shown via Cell
                      // fill, so nothing is lost by removing it.
                      activeBar={false}
                      isAnimationActive={false}
                      // The bar shapes render into Recharts' `inactive-bar`
                      // layer, which swallows the click without invoking any
                      // handler — clicking a bar did nothing while clicking the
                      // line or empty plot worked. Letting pointer events fall
                      // THROUGH the bars hands the click to the chart-level
                      // handler below, which resolves the bucket from
                      // activeLabel and already worked everywhere else.
                      style={{ pointerEvents: "none" }}
                    >
                      {chartData.map((d) => (
                        <Cell
                          key={d.date}
                          fill={selectedBucket && selectedBucket !== d.date ? "#D9D2CA" : CHART_INK}
                        />
                      ))}
                    </Bar>
                    <Line
                      yAxisId="ord"
                      type="monotone"
                      dataKey="Orders"
                      stroke={CHART_GOLD}
                      strokeWidth={3}
                      dot={{ r: 3.5, fill: "#FFFFFF", stroke: CHART_GOLD, strokeWidth: 2 }}
                      activeDot={{ r: 5.5, fill: "#FFFFFF", stroke: CHART_GOLD, strokeWidth: 2 }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Recent orders</CardTitle>
            <p className="text-xs text-[#6B7280]">
              {selectedDetail ? selectedDetail.label : periodLabel(period)} · {fmtN(recentOrders.length)} shown
            </p>
          </CardHeader>
          <CardContent className="p-0">
            {/* A selected day with nothing on it gets a stated empty result,
                not an blank panel — "no rows" and "failed to load" must not
                look the same. */}
            {selectedDetail && recentOrders.length === 0 ? (
              <div className="m-3 rounded-lg border border-dashed border-[#E5E0D8] bg-[#FBF9F5] px-4 py-8 text-center">
                <CalendarX2
                  className="mx-auto mb-2 h-7 w-7"
                  style={{ color: "#C0B49B" }}
                  strokeWidth={1.5}
                />
                <p className="text-[13px] font-semibold text-[#1F1D1B]">
                  No transactions recorded for {dayLabel(selectedDetail.label)}
                </p>
                <p className="mt-0.5 text-[11.5px]" style={{ color: CHART_AXIS }}>
                  0 orders processed on this date.
                </p>
                <button
                  type="button"
                  onClick={clearDay}
                  className="mt-3 rounded-md border border-[#E5E0D8] bg-white px-2.5 py-1 text-[11px] font-medium text-[#6B5C32] hover:bg-[#F7F5F3]"
                >
                  Back to {periodLabel({ ...period, day: undefined })}
                </button>
              </div>
            ) : (
            <div className="overflow-y-auto" style={{ maxHeight: 300 }}>
              <table className="w-full text-[12px]">
                <tbody>
                  {recentOrders.map((o) => (
                    <tr key={o.id} className="border-b border-[#E2DDD8]">
                      <td className="px-3 py-2 align-top">
                        <p className="font-mono text-[#1F1D1B]">{o.no ?? o.id}</p>
                        <p className="text-[#6B7280] truncate max-w-[11rem]">{o.customer ?? "—"}</p>
                      </td>
                      <td className="px-3 py-2 text-right align-top whitespace-nowrap">
                        <p className="amount text-[#1F1D1B]">{formatCurrency(o.totalSen)}</p>
                        <p className="text-[#6B7280]">{o.createdAt ?? "—"}</p>
                      </td>
                    </tr>
                  ))}
                  {recentOrders.length === 0 && (
                    <tr>
                      <td className="px-3 py-6 text-center text-[#6B7280]">No orders.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Attribution and forecast sit side by side, as the design
          prototype pairs them. */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle>Sales attribution</CardTitle>
                <p className="text-xs" style={{ color: CHART_AXIS }}>
                  {attrView === "share"
                    ? `Each line is one customer's share of revenue per period · currently led by ${attrChart.topName} at ${attrChart.topPct}%`
                    : `Top customer: ${attrChart.topName} (${attrChart.topPct}% of total) · Whole book: ${formatCurrency(attrChart.grandSen)}`}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex rounded-lg border border-[#E2DDD8] overflow-hidden">
                  {(["monthly", "quarterly", "yearly"] as const).map((g) => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => setAttrGran(g)}
                      className={
                        "px-2.5 py-1 max-md:py-2.5 text-xs font-medium capitalize " +
                        (attrGran === g ? "bg-[#F0ECE9] text-[#1F1D1B]" : "text-[#6B7280] hover:bg-[#F7F5F3]")
                      }
                    >
                      {g}
                    </button>
                  ))}
                </div>
                <div className="flex rounded-lg border border-[#E2DDD8] overflow-hidden">
                  {([
                    { k: "value", label: "RM Value" },
                    { k: "share", label: "% Share" },
                  ] as const).map((v) => (
                    <button
                      key={v.k}
                      type="button"
                      onClick={() => setAttrView(v.k)}
                      className={
                        "px-2.5 py-1 max-md:py-2.5 text-xs font-medium " +
                        (attrView === v.k ? "bg-[#F0ECE9] text-[#1F1D1B]" : "text-[#6B7280] hover:bg-[#F7F5F3]")
                      }
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div
              className="select-none [&_*]:outline-none"
              style={{ width: "100%", height: 300 }}
            >
              {attrChart.rows.length === 0 ? (
                <div className="flex items-center justify-center h-full text-xs" style={{ color: CHART_AXIS }}>
                  No dated orders.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  {attrView === "share" ? (
                    <LineChart data={attrChart.rows} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
                      <CartesianGrid vertical={false} stroke={CHART_AXIS} strokeOpacity={0.25} />
                      <XAxis
                        dataKey="bucket"
                        tick={{ fontSize: 10, fill: CHART_AXIS }}
                        axisLine={{ stroke: CARD_BORDER }}
                        tickLine={false}
                      />
                      <YAxis
                        domain={[0, 100]}
                        ticks={[0, 25, 50, 75, 100]}
                        tick={{ fontSize: 10, fill: CHART_AXIS }}
                        axisLine={false}
                        tickLine={false}
                        width={44}
                        tickFormatter={(v) => `${v}%`}
                      />
                      <Tooltip content={<AttrTooltip series={attrChart.series} />} />
                      <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" />
                      {attrChart.series.map((s, i) => (
                        <Line
                          key={s}
                          type="monotone"
                          dataKey={s}
                          stroke={ATTR_COLORS[i % ATTR_COLORS.length]}
                          strokeWidth={2}
                          isAnimationActive={false}
                          dot={{ r: 3, fill: "#FFFFFF", stroke: ATTR_COLORS[i % ATTR_COLORS.length], strokeWidth: 2 }}
                          activeDot={{ r: 5, fill: "#FFFFFF", stroke: ATTR_COLORS[i % ATTR_COLORS.length], strokeWidth: 2 }}
                        />
                      ))}
                    </LineChart>
                  ) : (
                    <BarChart data={attrChart.rows} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
                      <CartesianGrid vertical={false} stroke={CHART_AXIS} strokeOpacity={0.25} />
                      <XAxis
                        dataKey="bucket"
                        tick={{ fontSize: 10, fill: CHART_AXIS }}
                        axisLine={{ stroke: CARD_BORDER }}
                        tickLine={false}
                      />
                      <YAxis
                        tick={{ fontSize: 10, fill: CHART_AXIS }}
                        axisLine={false}
                        tickLine={false}
                        width={44}
                        tickFormatter={(v) => fmtN(Number(v))}
                      />
                      <Tooltip content={<AttrTooltip series={attrChart.series} />} />
                      <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" />
                      {attrChart.series.map((s, i) => (
                        <Bar
                          key={s}
                          dataKey={s}
                          stackId="attr"
                          fill={ATTR_COLORS[i % ATTR_COLORS.length]}
                          cursor="pointer"
                          isAnimationActive={false}
                          activeBar={{ fillOpacity: 1 }}
                          onClick={(d) => {
                            const row = (d as unknown as { payload?: { bucket?: string } })?.payload;
                            if (row?.bucket) onAttrBucketClick(row.bucket);
                          }}
                        />
                      ))}
                    </BarChart>
                  )}
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-white border-[#E5E0D8]">
          <CardHeader className="pb-3">
            <CardTitle>Sales forecast</CardTitle>
            <p className="text-xs" style={{ color: CHART_AXIS }}>
              Target is the 3-month rolling average of the preceding months —
              this book sets no explicit revenue target, so none is invented.
              Greyed months are projected and have no actual yet.
            </p>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-3 pb-2 text-[11px]" style={{ color: CHART_AXIS }}>
              {([
                { label: "Hit target", color: GREEN, line: false },
                { label: "Missed target", color: AMBER, line: false },
                { label: "Projected", color: "#E3DED5", line: false },
                { label: "Target", color: TEAL, line: true },
              ] as const).map((l) => (
                <span key={l.label} className="inline-flex items-center gap-1.5">
                  {l.line ? (
                    <span
                      className="inline-block w-4"
                      style={{ borderTop: `2px dashed ${l.color}` }}
                    />
                  ) : (
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-sm"
                      style={{ background: l.color }}
                    />
                  )}
                  {l.label}
                </span>
              ))}
            </div>
            <div style={{ width: "100%", height: 260 }}>
              {forecast.length === 0 ? (
                <div className="flex items-center justify-center h-full text-xs" style={{ color: CHART_AXIS }}>
                  No dated revenue.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={forecast} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
                    <CartesianGrid vertical={false} stroke={CHART_AXIS} strokeOpacity={0.25} />
                    <XAxis
                      dataKey="month"
                      tick={{ fontSize: 10, fill: CHART_AXIS }}
                      axisLine={{ stroke: CARD_BORDER }}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: CHART_AXIS }}
                      axisLine={false}
                      tickLine={false}
                      width={56}
                      tickFormatter={(v) => fmtRMAxis(Number(v))}
                    />
                    <Tooltip
                      contentStyle={{
                        background: CARD_BG,
                        border: `1px solid ${CARD_BORDER}`,
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      formatter={(value, name) => {
                        const n = typeof value === "number" ? value : Number(value);
                        return [formatCurrency(n * 100), name];
                      }}
                    />
                    <Bar
                      dataKey="Actual"
                      radius={[4, 4, 0, 0]}
                      maxBarSize={26}
                      isAnimationActive={false}
                      activeBar={{ fillOpacity: 1 }}
                    >
                      {forecast.map((r) => (
                        <Cell
                          key={r.iso}
                          fill={r.hit === null ? "#E3DED5" : r.hit ? GREEN : AMBER}
                        />
                      ))}
                    </Bar>
                    <Line
                      type="monotone"
                      dataKey="Target"
                      stroke={TEAL}
                      strokeWidth={2}
                      strokeDasharray="5 4"
                      connectNulls
                      isAnimationActive={false}
                      dot={{ r: 3, fill: "#FFFFFF", stroke: TEAL, strokeWidth: 2 }}
                      activeDot={{ r: 5, fill: "#FFFFFF", stroke: TEAL, strokeWidth: 2 }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Widgets ported from /dashboard (same URLs + formulas). */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <OrderPipelineCard period={period} />
        <RevenueTrendCard period={period} />
      </div>
      <CustomerRevenueCard period={period} />
      <TopSellersCard period={period} />

      {/* Fulfillment pipeline keeps its own row; the state/category donut
          and Top SKUs share one split, the way the design prototype pairs
          them — a donut beside the ranked table it filters. */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Fulfillment pipeline</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {pipeline.length === 0 && (
              <p className="text-xs text-[#6B7280]">No pipeline data.</p>
            )}
            {pipeline.map((p) => (
              <div key={p.status} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
                  <span className="text-[#1F1D1B] truncate">{p.status}</span>
                  <span className="tabular-nums text-[#6B7280] shrink-0">
                    {fmtN(p.count)} · {formatCurrency(p.valueSen)}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-[#F0ECE9] overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${(p.count / pipelineMax) * 100}%`, background: TAUPE }}
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="bg-white border-[#E5E0D8]">
          <CardHeader className="pb-3">
            <CardTitle>Sales by state &amp; category</CardTitle>
            <p className="text-xs" style={{ color: CHART_AXIS }}>
              Share of revenue · {selectedDetail ? selectedDetail.label : periodLabel(period)} · click a state to filter the SKU list
            </p>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 items-center">
            {/* Donut with outside labels + leader lines, and the leading share
                called out in the hole — the shape the design reference uses. */}
            <div
              className="relative select-none [&_*]:outline-none"
              style={{ width: "100%", height: 250 }}
            >
              {/* Centre stat renders BEFORE the chart on purpose: as a later
                  sibling it painted on top of the tooltip whenever the pointer
                  was near the middle of the donut. The hole is transparent, so
                  it still reads through. */}
              <div className="absolute inset-0 grid place-items-center pointer-events-none">
                <div className="text-center leading-tight">
                  <p className="text-[9px] uppercase tracking-wide" style={{ color: CHART_AXIS }}>
                    Largest state
                  </p>
                  <p className="text-2xl font-bold tabular-nums text-[#1F1D1B]">
                    {donutTop ? `${donutTop.pct.toFixed(1)}%` : "—"}
                  </p>
                  <p className="text-[9px]" style={{ color: CHART_AXIS }}>
                    of total revenue
                  </p>
                </div>
              </div>

              <ResponsiveContainer width="100%" height="100%">
                <PieChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                  <Pie
                    data={donutData}
                    dataKey="revenueSen"
                    nameKey="state"
                    innerRadius="58%"
                    outerRadius="88%"
                    paddingAngle={1}
                    stroke={CARD_BG}
                    strokeWidth={2}
                    isAnimationActive={false}
                    onClick={(d) => {
                      const row = (d as unknown as { payload?: { state?: string } })?.payload;
                      const name = row?.state;
                      if (name) setStateFilter((cur) => (cur === name ? null : name));
                    }}
                  >
                    {donutData.map((st, i) => (
                      <Cell
                        key={st.state}
                        cursor="pointer"
                        fill={CHART_SERIES[i % CHART_SERIES.length]}
                        opacity={stateFilter && stateFilter !== st.state ? 0.28 : 1}
                      />
                    ))}
                  </Pie>
                  <Tooltip
                    wrapperStyle={{ zIndex: 30, outline: "none" }}
                    contentStyle={{
                      background: "#FFFFFF",
                      opacity: 1,
                      border: "1px solid " + CARD_BORDER,
                      borderRadius: 8,
                      fontSize: 12,
                      boxShadow: "0 4px 14px rgba(42,39,35,0.18)",
                    }}
                    formatter={(value, name) => [formatCurrency(Number(value)), String(name)]}
                  />
                </PieChart>
              </ResponsiveContainer>

            </div>

            <div className="space-y-2">
              <div>
                <p className="text-lg font-bold tabular-nums text-[#1F1D1B]">
                  {formatCurrency(attribution.total)}
                </p>
                <p className="text-[10px] uppercase tracking-wide" style={{ color: CHART_AXIS }}>
                  Total sales · {selectedDetail ? selectedDetail.label : periodLabel(period)}
                </p>
              </div>
              {attribution.states.slice(0, 7).map((st, i) => {
                const pct = attribution.total > 0 ? (st.revenueSen / attribution.total) * 100 : 0;
                const on = !stateFilter || stateFilter === st.state;
                return (
                  <button
                    key={st.state}
                    type="button"
                    onClick={() => setStateFilter((cur) => (cur === st.state ? null : st.state))}
                    className="w-full flex items-center gap-2 text-[12.5px] text-left max-md:py-1.5"
                    style={{ opacity: on ? 1 : 0.45 }}
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-sm shrink-0"
                      style={{ background: CHART_SERIES[i % CHART_SERIES.length] }}
                    />
                    <span className="flex-1 truncate text-[#1F1D1B]">{st.state}</span>
                    <span className="tabular-nums shrink-0" style={{ color: CHART_AXIS }}>
                      {pct.toFixed(1)}%
                    </span>
                  </button>
                );
              })}
              <div className="pt-1 border-t border-[#E5E0D8] space-y-0.5">
                {attribution.categories.slice(0, 4).map((c) => (
                  <p key={c.category} className="text-[12px] flex justify-between gap-2">
                    <span style={{ color: CHART_AXIS }}>{c.category} sold</span>
                    <span className="tabular-nums text-[#1F1D1B]">{fmtN(c.qty)}</span>
                  </p>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-white border-[#E5E0D8]">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle>Top SKUs</CardTitle>
                <p className="text-xs" style={{ color: CHART_AXIS }}>
                  {selectedDetail ? selectedDetail.label : periodLabel(period)} · top {visibleSkus.length} · ranked by {skuSort === "revenue" ? "revenue" : "units"}
                  {stateFilter ? " · " + stateFilter + " only" : ""}
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                {["All", ...attribution.categories.map((c) => c.category)].slice(0, 5).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setSkuCat(c === "All" ? null : c)}
                    className={
                      "px-2 py-0.5 max-md:py-2 max-md:px-3 text-[11px] font-medium rounded-md border " +
                      ((c === "All" ? skuCat === null : skuCat === c)
                        ? "bg-[#2A2723] border-[#2A2723] text-white"
                        : "bg-white border-[#E5E0D8] text-[#6B7280] hover:bg-[#F7F5F3]")
                    }
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto" style={{ maxHeight: 300, overflowY: "auto" }}>
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-t border-b border-[#E5E0D8] sticky top-0 bg-white">
                    <th className="text-left px-3 py-2 font-semibold uppercase text-[10.5px] tracking-wide" style={{ color: CHART_AXIS }}>#</th>
                    <th className="text-left px-3 py-2 font-semibold uppercase text-[10.5px] tracking-wide" style={{ color: CHART_AXIS }}>SKU</th>
                    <th className="text-left px-3 py-2 font-semibold uppercase text-[10.5px] tracking-wide" style={{ color: CHART_AXIS }}>Category</th>
                    {([
                      { k: "units", label: "Units" },
                      { k: "revenue", label: "Revenue" },
                    ] as const).map((col) => (
                      <th
                        key={col.k}
                        className="text-right px-3 py-2 font-semibold uppercase text-[10.5px] tracking-wide cursor-pointer select-none whitespace-nowrap"
                        style={{ color: skuSort === col.k ? "#1F1D1B" : CHART_AXIS }}
                        onClick={() => setSkuSort(col.k)}
                      >
                        {col.label}
                        {skuSort === col.k ? " ▾" : ""}
                      </th>
                    ))}
                    <th className="text-right px-3 py-2 font-semibold uppercase text-[10.5px] tracking-wide" style={{ color: CHART_AXIS }}>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleSkus.map((s, i) => {
                    const pct = attribution.total > 0 ? (s.revenueSen / attribution.total) * 100 : 0;
                    return (
                      <tr key={s.sku} className="border-b border-[#E5E0D8]">
                        <td className="px-3 py-2 tabular-nums w-8" style={{ color: CHART_AXIS }}>{i + 1}</td>
                        <td className="px-3 py-2 font-mono text-[#1F1D1B] whitespace-nowrap">{s.sku}</td>
                        <td className="px-3 py-2 w-full" style={{ color: CHART_AXIS }}>{s.category}</td>
                        <td className="px-3 py-2 tabular-nums text-right text-[#1F1D1B] whitespace-nowrap">{fmtN(s.qty)}</td>
                        <td className="px-3 py-2 amount text-[#1F1D1B] whitespace-nowrap">{formatCurrency(s.revenueSen)}</td>
                        <td className="px-3 py-2 tabular-nums text-right whitespace-nowrap" style={{ color: CHART_AXIS }}>{pct.toFixed(1)}%</td>
                      </tr>
                    );
                  })}
                  {visibleSkus.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-6 text-center" style={{ color: CHART_AXIS }}>
                        No line items.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>

    </div>
  );
}
