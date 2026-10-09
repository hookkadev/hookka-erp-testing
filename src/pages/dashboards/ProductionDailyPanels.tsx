import { useMemo, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from "recharts";
import { useCachedJson } from "@/lib/cached-fetch";
import { formatCurrency } from "@/lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import {
  TAUPE, MUTED, BORDER, GREEN, AMBER, RED, CHART_GOLD, fmtN, fmtRMAxis, inPeriod, inFocus,
  dayLabel, periodLabel, type Period,
} from "./dashboard-shared-lib";
import { Kpi } from "./dashboard-shared";
import type { EmployeeSlice } from "./EmployeesInsights";

// The day-by-day production panels, mounted by the tab that owns each one:
//   plan      Operations > Plan vs Actual   (definitions are in the card
//             subtitles and mirrored in src/api/lib/dashboard-daily-slice.ts)
//   revenue   Operations > Revenue & Cost   (value of orders whose upholstery finished per day)
//   DeptEfficiencyCard   Employees > Efficiency
// Everything reads the same cached GET /api/dashboard/prototype feed. The
// slice is optional: a 60s-cached payload from before it existed has no such
// key and must render an explanation, not crash. `lim` is the feed's key for
// the daily slice (backend name, not shown anywhere).
type StageDay = {
  date: string; dept: string;
  plan: number; actual: number; planUnits: number; actualUnits: number; planMin: number; actualMin: number;
};
type DailySlice = {
  stages: { byDay: StageDay[]; cardsWithoutDue: number };
  revenue: {
    byDay: { date: string; orders: number; unpricedOrders: number; revenueSen: number }[];
    unpricedOrders: number;
  } | null;
  revenueError?: string;
};
type Feed = {
  success?: boolean;
  availability?: { lim?: { live: boolean; reason?: string } };
  lim?: DailySlice | null;
};

const TOOLTIP = { background: "#FFFFFF", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12 };
const hrs = (min: number) => `${(min / 60).toLocaleString("en-MY", { maximumFractionDigits: 1 })}h`;
const CHART_WRAP = "select-none [&_*]:outline-none [&_.recharts-wrapper]:outline-none";

const addStage = (a: StageDay, b: StageDay): StageDay => ({
  ...a, plan: a.plan + b.plan, actual: a.actual + b.actual,
  planUnits: a.planUnits + b.planUnits, actualUnits: a.actualUnits + b.actualUnits,
  planMin: a.planMin + b.planMin, actualMin: a.actualMin + b.actualMin,
});

// Monthly/range -> one bar per day; YTD -> one bar per month (OperationsView's rule).
function bucket<T extends { date: string }>(rows: T[], p: Period, add: (a: T, b: T) => T) {
  if (p.mode !== "ytd") return rows.map((r) => ({ ...r, key: r.date.slice(5), iso: r.date }));
  const m = new Map<string, T & { key: string; iso: string }>();
  for (const r of rows) {
    const key = r.date.slice(0, 7);
    const cur = m.get(key);
    m.set(key, cur ? { ...add(cur, r), key, iso: key } : { ...r, key, iso: key });
  }
  return [...m.values()];
}

const th = (label: string, right: boolean) => (
  <th key={label} className={`px-4 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280] whitespace-nowrap ${right ? "text-right" : "text-left"}`}>{label}</th>
);

// ---- Efficiency: per-department breakdown for one day ---------------------
// Same maths as DepartmentsView (performance.byDay[].workers joined to the
// worker's department): production ÷ working minutes.
export function DeptEfficiencyCard({ employee, period, target }: { employee: EmployeeSlice; period: Period; target: number }) {
  // The focused day, else the latest day inside the period that has clocked hours.
  const { day, isLatest, rows } = useMemo(() => {
    const days = employee.performance.byDay.filter((d) => d.workingMinutes > 0);
    const latest = days.filter((d) => inPeriod(period, d.date)).reduce((m, d) => (d.date > m ? d.date : m), "");
    const day = period.day ?? latest;
    const deptOf = new Map(employee.workers.map((w) => [w.id, w.dept]));
    const m = new Map<string, { dept: string; people: Set<string>; working: number; prod: number }>();
    for (const d of employee.performance.byDay) {
      if (d.date !== day) continue;
      for (const x of d.workers ?? []) {
        const k = deptOf.get(x.workerId) || "(no dept)";
        let e = m.get(k);
        if (!e) m.set(k, (e = { dept: k, people: new Set(), working: 0, prod: 0 }));
        e.people.add(x.workerId);
        e.working += x.workingMinutes;
        e.prod += x.productionMinutes;
      }
    }
    return {
      day, isLatest: !period.day,
      rows: [...m.values()].sort((a, b) => a.dept.localeCompare(b.dept)),
    };
  }, [employee, period]);
  const total = rows.reduce((a, r) => ({ w: a.w + r.working, p: a.p + r.prod, n: a.n + r.people.size }), { w: 0, p: 0, n: 0 });
  const eff = (w: number, p: number) => (w > 0 ? (p / w) * 100 : null);
  const cell = (v: number | null) => (
    <span className="font-semibold" style={{ color: v == null ? MUTED : v >= target ? GREEN : AMBER }}>{v == null ? "—" : `${v.toFixed(1)}%`}</span>
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Daily efficiency by department</CardTitle>
        <p className="text-xs text-[#6B7280]">
          {day ? `${dayLabel(day)}${isLatest ? " (latest day with clocked hours in the period)" : ""}` : "No clocked hours in this period"}
          {" "}· efficiency = prod hours ÷ production time (clocked), against the {target}% target
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-t border-b border-[#E2DDD8]">
                {th("Department", false)}{th("People", true)}{th("Production time", true)}{th("Prod hours", true)}{th("Efficiency", true)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.dept} className="border-b border-[#E2DDD8]">
                  <td className="px-4 py-2.5 font-medium text-[#1F1D1B]">{r.dept}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{fmtN(r.people.size)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{hrs(r.working)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{hrs(r.prod)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{cell(eff(r.working, r.prod))}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-[#6B7280]">No per-worker hours for this day.</td></tr>
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-[#E2DDD8] font-semibold">
                  <td className="px-4 py-2.5">Factory</td>
                  <td className="px-4 py-2.5 text-right font-mono">{fmtN(total.n)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{hrs(total.w)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{hrs(total.p)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{cell(eff(total.w, total.p))}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export function ProductionDailyPanels({
  period, sub, onPeriodChange,
}: { period: Period; sub: "plan" | "revenue"; onPeriodChange: (p: Period) => void }) {
  const { data, loading, error } = useCachedJson<Feed>("/api/dashboard/prototype");
  const [metric, setMetric] = useState<"cards" | "units" | "minutes">("cards");

  const lim = data?.lim ?? null;

  // Click a bar: a month in YTD opens that month, a day anywhere else is
  // highlighted (period.day) — the same rule OperationsView uses.
  const pick = (rows: { date: string; iso: string }[]) => (e: { activeLabel?: unknown } | null) => {
    const hit = rows.find((d) => d.date === e?.activeLabel);
    if (!hit) return;
    if (period.mode === "ytd") onPeriodChange({ mode: "monthly", month: hit.iso });
    else onPeriodChange({ ...period, day: period.day === hit.iso ? undefined : hit.iso });
  };
  const dayLine = period.day && period.mode !== "ytd" ? period.day.slice(5) : null;

  // ---- Plan vs Actual -------------------------------------------------------
  // Job cards, units and planned time: the Schedule email's three measures.
  const planChart = useMemo(() => {
    const perDay = new Map<string, StageDay>();
    for (const r of lim?.stages.byDay ?? []) {
      if (!inPeriod(period, r.date)) continue;
      const cur = perDay.get(r.date);
      perDay.set(r.date, cur ? addStage(cur, r) : r);
    }
    return bucket([...perDay.values()], period, addStage).map((d) => ({
      iso: d.iso, date: d.key,
      Plan: metric === "units" ? d.planUnits : metric === "minutes" ? Math.round(d.planMin) : d.plan,
      Actual: metric === "units" ? d.actualUnits : metric === "minutes" ? Math.round(d.actualMin) : d.actual,
    }));
  }, [lim, period, metric]);
  const stageRows = useMemo(() => {
    const m = new Map<string, StageDay>();
    for (const r of lim?.stages.byDay ?? []) {
      if (!inFocus(period, r.date)) continue;
      const cur = m.get(r.dept);
      m.set(r.dept, cur ? addStage(cur, r) : r);
    }
    return [...m.values()].sort((a, b) => a.dept.localeCompare(b.dept));
  }, [lim, period]);
  const planTotals = useMemo(
    () => stageRows.reduce(addStage, { date: "", dept: "", plan: 0, actual: 0, planUnits: 0, actualUnits: 0, planMin: 0, actualMin: 0 }),
    [stageRows],
  );

  // ---- Production revenue ---------------------------------------------------
  const revChart = useMemo(
    () =>
      bucket((lim?.revenue?.byDay ?? []).filter((d) => inPeriod(period, d.date)), period, (a, b) => ({
        ...a, orders: a.orders + b.orders, unpricedOrders: a.unpricedOrders + b.unpricedOrders, revenueSen: a.revenueSen + b.revenueSen,
      })).map((d) => ({ iso: d.iso, date: d.key, sen: d.revenueSen, Revenue: Math.round(d.revenueSen / 100) })),
    [lim, period],
  );
  const revTotals = useMemo(() => {
    const rows = (lim?.revenue?.byDay ?? []).filter((d) => inFocus(period, d.date));
    return rows.reduce(
      (a, d) => ({ sen: a.sen + d.revenueSen, orders: a.orders + d.orders, unpriced: a.unpriced + d.unpricedOrders }),
      { sen: 0, orders: 0, unpriced: 0 },
    );
  }, [lim, period]);

  if (loading) return <div className="py-16 text-center text-sm text-[#6B7280]">Loading…</div>;
  if (error || !data?.success) {
    return (
      <Card className="border-[#F0D9AE] bg-[#FDF3E4]">
        <CardContent className="p-3 text-sm text-[#B5701A]">Couldn't load daily production: {error ?? "unknown error"}</CardContent>
      </Card>
    );
  }

  const missingSlice = (what: string) => (
    <Card className="border-[#F0D9AE] bg-[#FDF3E4]">
      <CardContent className="p-3 text-sm text-[#B5701A]">
        {what} isn't available: {data.availability?.lim?.reason ?? "the feed carries no daily production slice (it may be an older cached response — reload in a minute, or you may lack production-orders access)"}.
      </CardContent>
    </Card>
  );

  const signed = (v: number, fmt: (n: number) => string = fmtN) => (v > 0 ? `+${fmt(v)}` : v < 0 ? `−${fmt(-v)}` : fmt(0));
  const variance = (plan: number, actual: number, fmt?: (n: number) => string) => {
    const v = actual - plan;
    return <span className="font-semibold" style={{ color: v >= 0 ? GREEN : RED }}>{signed(v, fmt)}</span>;
  };
  const planKpi = (label: string, plan: number, actual: number, fmt: (n: number) => string = fmtN) => (
    <Kpi
      label={label}
      value={`${fmt(actual)} / ${fmt(plan)}`}
      sub={`actual / plan · ${signed(actual - plan, fmt)}`}
      valueColorClass={actual >= plan ? "text-[#4F7C3A]" : "text-[#9A3A2D]"}
    />
  );
  const barChart = (
    rows: { iso: string; date: string }[],
    body: React.ReactNode,
    yWidth = 36,
    fmt?: (v: number) => string,
    tip?: (v: number) => string,
  ) => (
    <div className={CHART_WRAP} style={{ width: "100%", height: 260 }}>
      {rows.length === 0 ? (
        <div className="flex items-center justify-center h-full text-xs text-[#6B7280]">Nothing recorded in this period.</div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 6, right: 6, bottom: 0, left: 0 }} style={{ cursor: "pointer" }} onClick={pick(rows)}>
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: MUTED }} axisLine={{ stroke: BORDER }} tickLine={false} />
            <YAxis tick={{ fontSize: 10, fill: MUTED }} axisLine={false} tickLine={false} width={yWidth} allowDecimals={false} tickFormatter={fmt} />
            <Tooltip cursor={{ fill: "#F0ECE9" }} contentStyle={TOOLTIP} formatter={tip ? (v) => tip(Number(v)) : undefined} />
            {dayLine && <ReferenceLine x={dayLine} stroke={AMBER} strokeWidth={2} />}
            {body}
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
  const unit = period.mode === "ytd" ? "month" : "day";

  return (
    <>
      {sub === "plan" && (!lim ? missingSlice("Plan vs Actual") : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {planKpi("Job cards", planTotals.plan, planTotals.actual)}
            {planKpi("Units", planTotals.planUnits, planTotals.actualUnits)}
            {planKpi("Planned time", planTotals.planMin, planTotals.actualMin, hrs)}
          </div>

          <Card>
            <CardHeader className="pb-3 flex flex-row items-start justify-between gap-3 flex-wrap">
              <div>
                <CardTitle>Production plan vs actual · by {unit}</CardTitle>
                <p className="text-xs text-[#6B7280] mt-1 max-w-3xl">
                  {periodLabel(period)}. Same measures as the Schedule email. <b>Plan</b> = job cards due on the {unit};{" "}
                  <b>Actual</b> = job cards completed or transferred on the {unit}. Units = each card's order quantity;
                  planned time = each card's estimated minutes (so actual is the planned time of the work that finished).
                  Two separate tallies by date — a card finished late counts as actual on the day it finished and as plan on
                  the day it was due. Cancelled cards and orders excluded.
                </p>
              </div>
              <Tabs tabs={[{ key: "cards", label: "Job cards" }, { key: "units", label: "Units" }, { key: "minutes", label: "Planned time" }]} value={metric} onChange={setMetric} variant="pill" scrollable />
            </CardHeader>
            <CardContent>
              {barChart(planChart, (
                <>
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="Plan" fill={CHART_GOLD} radius={[3, 3, 0, 0]} />
                  <Bar dataKey="Actual" fill={TAUPE} radius={[3, 3, 0, 0]} />
                </>
              ), metric === "minutes" ? 44 : 36, metric === "minutes" ? hrs : undefined, metric === "minutes" ? hrs : undefined)}
              <p className="mt-2 text-[11px] text-[#6B7280]">
                Click a bar to focus that {unit === "month" ? "month" : "day"}. {fmtN(lim.stages.cardsWithoutDue)} non-cancelled
                job cards have no due date and cannot appear in Plan.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>By department (stage) · {period.day ? dayLabel(period.day) : periodLabel(period)}</CardTitle>
              <p className="text-xs text-[#6B7280] max-w-3xl">
                One card = one department stage of one order. <b>Plan</b> = cards due in the window, <b>Actual</b> = cards
                completed/transferred in the window. A day with 0 actual can mean nothing was recorded rather than nothing was done.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead><tr className="border-t border-b border-[#E2DDD8]">
                    {th("Department", false)}
                    {th("Job cards plan", true)}{th("Actual", true)}{th("Var", true)}
                    {th("Units plan", true)}{th("Actual", true)}{th("Var", true)}
                    {th("Planned time plan", true)}{th("Actual", true)}{th("Var", true)}
                  </tr></thead>
                  <tbody>
                    {stageRows.map((r) => (
                      <tr key={r.dept} className="border-b border-[#E2DDD8]">
                        <td className="px-4 py-2.5 font-medium text-[#1F1D1B]">{r.dept}</td>
                        <td className="px-4 py-2.5 text-right font-mono">{fmtN(r.plan)}</td>
                        <td className="px-4 py-2.5 text-right font-mono">{fmtN(r.actual)}</td>
                        <td className="px-4 py-2.5 text-right font-mono">{variance(r.plan, r.actual)}</td>
                        <td className="px-4 py-2.5 text-right font-mono">{fmtN(r.planUnits)}</td>
                        <td className="px-4 py-2.5 text-right font-mono">{fmtN(r.actualUnits)}</td>
                        <td className="px-4 py-2.5 text-right font-mono">{variance(r.planUnits, r.actualUnits)}</td>
                        <td className="px-4 py-2.5 text-right font-mono">{hrs(r.planMin)}</td>
                        <td className="px-4 py-2.5 text-right font-mono">{hrs(r.actualMin)}</td>
                        <td className="px-4 py-2.5 text-right font-mono">{variance(r.planMin, r.actualMin, hrs)}</td>
                      </tr>
                    ))}
                    {stageRows.length === 0 && <tr><td colSpan={10} className="px-4 py-6 text-center text-[#6B7280]">No stage plan or completion in this window.</td></tr>}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      ))}

      {sub === "revenue" && (!lim ? missingSlice("Production revenue") : !lim.revenue ? (
        <Card className="border-[#F0D9AE] bg-[#FDF3E4]">
          <CardContent className="p-3 text-sm text-[#B5701A]">Production revenue isn't available: order values could not be loaded ({lim.revenueError ?? "unknown error"}).</CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
            <Kpi label="Production revenue" value={formatCurrency(revTotals.sen)} sub={period.day ? dayLabel(period.day) : periodLabel(period)} valueColorClass="text-[#3E6570]" />
            <Kpi label="Orders upholstered" value={fmtN(revTotals.orders)} />
            <Kpi label="Completed with no price" value={fmtN(revTotals.unpriced)} sub="value could not be resolved (counted as RM 0)" valueColorClass={revTotals.unpriced ? "text-[#9C6F1E]" : undefined} />
          </div>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Production revenue · by {unit}</CardTitle>
              <p className="text-xs text-[#6B7280] max-w-3xl">
                {periodLabel(period)}. Value of production orders whose <b>last upholstery job card</b> completed on the {unit}: order
                quantity × its sales-order line price (consignment line, then product list price, as fallbacks). Sofa, bedframe and
                accessory only — the same figure as the Production line on the main Dashboard. Not invoiced or delivered revenue.
              </p>
            </CardHeader>
            <CardContent>
              {barChart(revChart, (
                <Bar dataKey="Revenue" fill={TAUPE} radius={[3, 3, 0, 0]} />
              ), 48, fmtRMAxis)}
              <p className="mt-2 text-[11px] text-[#6B7280]">Click a bar to focus that {unit === "month" ? "month" : "day"}.</p>
            </CardContent>
          </Card>
        </>
      ))}

    </>
  );
}
