import { useMemo, useState } from "react";
import { ServiceApprovalsPanel } from "./ServiceApprovalsPanel";
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from "recharts";
import { useCachedJson } from "@/lib/cached-fetch";
import { formatCurrency } from "@/lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import { ClipboardList, Target, TrendingUp, Banknote, PackageCheck, AlertTriangle, Clock } from "lucide-react";
import {
  TAUPE, MUTED, BORDER, GREEN, AMBER, RED, CHART_GOLD, fmtN, fmtRMAxis, inPeriod, inFocus,
  dayLabel, periodLabel, type Period, type LimSub,
} from "./dashboard-shared-lib";
import { Kpi, LiveBadge, SnapshotNote } from "./dashboard-shared";
import { AttendanceLogCard } from "./AttendanceLogCard";
import { OverdueByDeptCard, DueSoonWorklist, type ProdOrderSummary } from "./OverdueCards";
import { TimeAttendancePanels, EfficiencyPanels, type EmployeeSlice } from "./EmployeesInsights";

// "Daily (Lim)" — the owner's daily report set for Lim, on ONE tab:
//   Efficiency       daily pool line + ranking (REUSED from Employees) plus a
//                    per-department breakdown for the focused day (new)
//   Plan vs Actual   NEW — definitions are stated in the card subtitles and
//                    mirrored in src/api/lib/dashboard-daily-slice.ts
//   Attendance       AttendanceLogCard, REUSED as is
//   Production revenue  NEW — value of production orders completed per day
//   Overdue          the Siti overdue cards, REUSED (OverdueCards.tsx)
// Everything reads the same cached GET /api/dashboard/prototype feed.
// `lim` is optional: a 60s-cached payload from before this slice existed has
// no such key and must render an explanation, not crash.
type LimSlice = {
  orders: {
    byDay: { date: string; planOrders: number; planUnits: number; actualOrders: number; actualUnits: number }[];
    withoutTarget: number;
    completedTotal: number;
  };
  stages: { byDay: { date: string; dept: string; plan: number; actual: number }[]; cardsWithoutDue: number };
  revenue: {
    byDay: { date: string; orders: number; unpricedOrders: number; revenueSen: number }[];
    unpricedOrders: number;
  } | null;
  revenueError?: string;
};
type Feed = {
  success?: boolean;
  availability?: {
    lim?: { live: boolean; reason?: string };
    employee?: { live: boolean; reason?: string };
    production?: { live: boolean; reason?: string };
  };
  meta?: { config?: { efficiencyTargetPct?: number } };
  production?: { overdueByDept: { department: string; count: number }[]; dueSoon3Days: ProdOrderSummary[] };
  employee?: EmployeeSlice;
  lim?: LimSlice | null;
};

const TOOLTIP = { background: "#FFFFFF", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12 };
const hrs = (min: number) => `${(min / 60).toLocaleString("en-MY", { maximumFractionDigits: 1 })}h`;
const CHART_WRAP = "select-none [&_*]:outline-none [&_.recharts-wrapper]:outline-none";

// Monthly/range -> one bar per day; YTD -> one bar per month (SitiOpsView's rule).
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

function DayChip({ period, onPeriodChange }: { period: Period; onPeriodChange: (p: Period) => void }) {
  if (!period.day) return null;
  return (
    <button
      type="button"
      onClick={() => onPeriodChange({ ...period, day: undefined })}
      className="text-xs rounded-md border border-[#E5E0D8] bg-[#F7F5F3] px-2 py-0.5 text-[#6B5C32] hover:bg-white max-md:min-h-10 max-md:px-3 max-md:text-left"
    >
      Showing: {dayLabel(period.day)} — click to go back
    </button>
  );
}

const th = (label: string, right: boolean) => (
  <th key={label} className={`px-4 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280] whitespace-nowrap ${right ? "text-right" : "text-left"}`}>{label}</th>
);

// ---- Efficiency: per-department breakdown for one day ---------------------
// Same maths as DepartmentsView (performance.byDay[].workers joined to the
// worker's department): production ÷ working minutes.
function DeptEfficiencyCard({ employee, period, target }: { employee: EmployeeSlice; period: Period; target: number }) {
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

export function LimDailyView({
  period, sub, onPeriodChange,
}: { period: Period; sub: LimSub; onPeriodChange: (p: Period) => void }) {
  const { data, loading, error } = useCachedJson<Feed>("/api/dashboard/prototype");
  const [metric, setMetric] = useState<"units" | "orders">("units");

  const lim = data?.lim ?? null;
  const employee = data?.employee;
  const target = data?.meta?.config?.efficiencyTargetPct ?? 100;

  // Click a bar: a month in YTD opens that month, a day anywhere else is
  // highlighted (period.day) — the same rule SitiOpsView uses.
  const pick = (rows: { date: string; iso: string }[]) => (e: { activeLabel?: unknown } | null) => {
    const hit = rows.find((d) => d.date === e?.activeLabel);
    if (!hit) return;
    if (period.mode === "ytd") onPeriodChange({ mode: "monthly", month: hit.iso });
    else onPeriodChange({ ...period, day: period.day === hit.iso ? undefined : hit.iso });
  };
  const dayLine = period.day && period.mode !== "ytd" ? period.day.slice(5) : null;

  // ---- Plan vs Actual -------------------------------------------------------
  const planChart = useMemo(
    () =>
      bucket((lim?.orders.byDay ?? []).filter((d) => inPeriod(period, d.date)), period, (a, b) => ({
        ...a, planOrders: a.planOrders + b.planOrders, planUnits: a.planUnits + b.planUnits,
        actualOrders: a.actualOrders + b.actualOrders, actualUnits: a.actualUnits + b.actualUnits,
      })).map((d) => ({
        iso: d.iso, date: d.key,
        Plan: metric === "units" ? d.planUnits : d.planOrders,
        Actual: metric === "units" ? d.actualUnits : d.actualOrders,
      })),
    [lim, period, metric],
  );
  const planTotals = useMemo(() => {
    const rows = (lim?.orders.byDay ?? []).filter((d) => inFocus(period, d.date));
    return rows.reduce(
      (a, d) => ({ po: a.po + d.planOrders, pu: a.pu + d.planUnits, ao: a.ao + d.actualOrders, au: a.au + d.actualUnits }),
      { po: 0, pu: 0, ao: 0, au: 0 },
    );
  }, [lim, period]);
  const stageRows = useMemo(() => {
    const m = new Map<string, { dept: string; plan: number; actual: number }>();
    for (const r of lim?.stages.byDay ?? []) {
      if (!inFocus(period, r.date)) continue;
      const e = m.get(r.dept) ?? { dept: r.dept, plan: 0, actual: 0 };
      e.plan += r.plan;
      e.actual += r.actual;
      m.set(r.dept, e);
    }
    return [...m.values()].sort((a, b) => a.dept.localeCompare(b.dept));
  }, [lim, period]);

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
        <CardContent className="p-4 text-sm text-[#B5701A]">Couldn't load Daily (Lim): {error ?? "unknown error"}</CardContent>
      </Card>
    );
  }

  const missingSlice = (what: string) => (
    <Card className="border-[#F0D9AE] bg-[#FDF3E4]">
      <CardContent className="p-4 text-sm text-[#B5701A]">
        {what} isn't available: {data.availability?.lim?.reason ?? "the feed carries no daily production slice (it may be an older cached response — reload in a minute, or you may lack production-orders access)"}.
      </CardContent>
    </Card>
  );

  const variance = (plan: number, actual: number) => {
    const v = actual - plan;
    return (
      <span className="font-semibold" style={{ color: v >= 0 ? GREEN : RED }}>{v > 0 ? `+${fmtN(v)}` : fmtN(v)}</span>
    );
  };
  const barChart = (
    rows: { iso: string; date: string }[],
    body: React.ReactNode,
    yWidth = 36,
    fmt?: (v: number) => string,
  ) => (
    <div className={CHART_WRAP} style={{ width: "100%", height: 260 }}>
      {rows.length === 0 ? (
        <div className="flex items-center justify-center h-full text-xs text-[#6B7280]">Nothing recorded in this period.</div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 6, right: 6, bottom: 0, left: 0 }} style={{ cursor: "pointer" }} onClick={pick(rows)}>
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: MUTED }} axisLine={{ stroke: BORDER }} tickLine={false} />
            <YAxis tick={{ fontSize: 10, fill: MUTED }} axisLine={false} tickLine={false} width={yWidth} allowDecimals={false} tickFormatter={fmt} />
            <Tooltip cursor={{ fill: "#F0ECE9" }} contentStyle={TOOLTIP} />
            {dayLine && <ReferenceLine x={dayLine} stroke={AMBER} strokeWidth={2} />}
            {body}
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
  const unit = period.mode === "ytd" ? "month" : "day";

  return (
    <div className="space-y-5 max-md:space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Daily (Lim)</h2>
        <LiveBadge live={(data.availability?.employee?.live ?? false) && (data.availability?.production?.live ?? false)} />
        <DayChip period={period} onPeriodChange={onPeriodChange} />
      </div>

      {sub === "efficiency" && (
        employee ? (
          <>
            <DeptEfficiencyCard employee={employee} period={period} target={target} />
            <TimeAttendancePanels employee={employee} period={period} target={target} onPeriodChange={onPeriodChange} />
            <EfficiencyPanels employee={employee} period={period} target={target} onPeriodChange={onPeriodChange} />
          </>
        ) : (
          <Card className="border-[#F0D9AE] bg-[#FDF3E4]">
            <CardContent className="p-4 text-sm text-[#B5701A]">
              Efficiency isn't available: {data.availability?.employee?.reason ?? "no workforce data (workers:read is required)"}.
            </CardContent>
          </Card>
        )
      )}

      {sub === "plan" && (!lim ? missingSlice("Plan vs Actual") : (
        <>
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            <Kpi label="Planned (orders)" value={fmtN(planTotals.po)} sub={`${fmtN(planTotals.pu)} units`} icon={Target} iconBgClass="bg-[#F0ECE9]" iconColorClass="text-[#6B5C32]" />
            <Kpi label="Completed (orders)" value={fmtN(planTotals.ao)} sub={`${fmtN(planTotals.au)} units`} icon={PackageCheck} iconBgClass="bg-[#EEF3E4]" iconColorClass="text-[#4F7C3A]" valueColorClass="text-[#4F7C3A]" />
            <Kpi label="Variance (orders)" value={`${planTotals.ao - planTotals.po > 0 ? "+" : ""}${fmtN(planTotals.ao - planTotals.po)}`} sub="completed − planned" icon={TrendingUp} iconBgClass="bg-[#E6F0F3]" iconColorClass="text-[#3E6570]" valueColorClass={planTotals.ao >= planTotals.po ? "text-[#4F7C3A]" : "text-[#9A3A2D]"} />
            <Kpi label="Variance (units)" value={`${planTotals.au - planTotals.pu > 0 ? "+" : ""}${fmtN(planTotals.au - planTotals.pu)}`} sub="completed − planned" icon={ClipboardList} iconBgClass="bg-[#E6F0F3]" iconColorClass="text-[#3E6570]" valueColorClass={planTotals.au >= planTotals.pu ? "text-[#4F7C3A]" : "text-[#9A3A2D]"} />
          </div>

          <Card>
            <CardHeader className="pb-3 flex flex-row items-start justify-between gap-3 flex-wrap">
              <div>
                <CardTitle>Production plan vs actual · by {unit}</CardTitle>
                <p className="text-xs text-[#6B7280] mt-1 max-w-3xl">
                  {periodLabel(period)}. <b>Plan</b> = production orders whose target end date falls on the {unit};{" "}
                  <b>Actual</b> = orders marked COMPLETED with that completion date. Two separate tallies by date — an order
                  finished late counts as actual on the day it finished and as plan on the day it was due. Cancelled orders excluded.
                </p>
              </div>
              <Tabs tabs={[{ key: "units", label: "Units" }, { key: "orders", label: "Orders" }]} value={metric} onChange={setMetric} variant="pill" scrollable />
            </CardHeader>
            <CardContent>
              {barChart(planChart, (
                <>
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="Plan" fill={CHART_GOLD} radius={[3, 3, 0, 0]} />
                  <Bar dataKey="Actual" fill={TAUPE} radius={[3, 3, 0, 0]} />
                </>
              ))}
              <p className="mt-2 text-[11px] text-[#6B7280]">
                Click a bar to focus that {unit === "month" ? "month" : "day"}. {fmtN(lim.orders.withoutTarget)} non-cancelled orders
                have no target end date and cannot appear in Plan; {fmtN(lim.orders.completedTotal)} orders are COMPLETED in total.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>By department (stage) · {period.day ? dayLabel(period.day) : periodLabel(period)}</CardTitle>
              <p className="text-xs text-[#6B7280] max-w-3xl">
                Counted in job cards (one card = one department stage of one order; cards carry no unit count in the feed).
                <b> Plan</b> = cards due in the window, <b>Actual</b> = cards completed/transferred in the window. A day with 0 actual
                can mean nothing was recorded rather than nothing was done; {fmtN(lim.stages.cardsWithoutDue)} cards have no due date and are not in Plan.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead><tr className="border-t border-b border-[#E2DDD8]">{th("Department", false)}{th("Plan", true)}{th("Actual", true)}{th("Variance", true)}</tr></thead>
                  <tbody>
                    {stageRows.map((r) => (
                      <tr key={r.dept} className="border-b border-[#E2DDD8]">
                        <td className="px-4 py-2.5 font-medium text-[#1F1D1B]">{r.dept}</td>
                        <td className="px-4 py-2.5 text-right font-mono">{fmtN(r.plan)}</td>
                        <td className="px-4 py-2.5 text-right font-mono">{fmtN(r.actual)}</td>
                        <td className="px-4 py-2.5 text-right font-mono">{variance(r.plan, r.actual)}</td>
                      </tr>
                    ))}
                    {stageRows.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-[#6B7280]">No stage plan or completion in this window.</td></tr>}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      ))}

      {sub === "attendance" && (employee ? (
        <AttendanceLogCard employee={employee} period={period} />
      ) : (
        <Card className="border-[#F0D9AE] bg-[#FDF3E4]">
          <CardContent className="p-4 text-sm text-[#B5701A]">Attendance isn't available: {data.availability?.employee?.reason ?? "workers:read is required"}.</CardContent>
        </Card>
      ))}

      {sub === "revenue" && (!lim ? missingSlice("Production revenue") : !lim.revenue ? (
        <Card className="border-[#F0D9AE] bg-[#FDF3E4]">
          <CardContent className="p-4 text-sm text-[#B5701A]">Production revenue isn't available: order values could not be loaded ({lim.revenueError ?? "unknown error"}).</CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
            <Kpi label="Production revenue" value={formatCurrency(revTotals.sen)} sub={period.day ? dayLabel(period.day) : periodLabel(period)} icon={Banknote} iconBgClass="bg-[#E6F0F3]" iconColorClass="text-[#3E6570]" valueColorClass="text-[#3E6570]" valueSizeClass="text-xl" />
            <Kpi label="Orders completed" value={fmtN(revTotals.orders)} icon={PackageCheck} iconBgClass="bg-[#EEF3E4]" iconColorClass="text-[#4F7C3A]" />
            <Kpi label="Completed with no price" value={fmtN(revTotals.unpriced)} sub="value could not be resolved (counted as RM 0)" icon={AlertTriangle} iconBgClass="bg-[#FAEFCB]" iconColorClass="text-[#9C6F1E]" valueColorClass={revTotals.unpriced ? "text-[#9C6F1E]" : undefined} />
          </div>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Production revenue · by {unit}</CardTitle>
              <p className="text-xs text-[#6B7280] max-w-3xl">
                {periodLabel(period)}. Value of production orders that <b>completed</b> on the {unit}: order quantity × the unit price of
                its own sales-order line (the same resolver Delivery uses). It is the value of what production finished — not invoiced
                or delivered revenue, and not the sales figure on the Sales Orders tab.
              </p>
            </CardHeader>
            <CardContent>
              {barChart(revChart, (
                <Bar dataKey="Revenue" fill={TAUPE} radius={[3, 3, 0, 0]} />
              ), 48, (v) => fmtRMAxis(v * 100))}
              <p className="mt-2 text-[11px] text-[#6B7280]">Click a bar to focus that {unit === "month" ? "month" : "day"}.</p>
            </CardContent>
          </Card>
        </>
      ))}

      {sub === "overdue" && (
        <>
          <SnapshotNote what="Overdue" />
          <div className="grid grid-cols-2 gap-3">
            <Kpi label="Overdue orders" value={fmtN((data.production?.overdueByDept ?? []).reduce((a, d) => a + d.count, 0))} sub="open, past customer date" icon={AlertTriangle} iconBgClass="bg-[#FBE7E3]" iconColorClass="text-[#9A3A2D]" valueColorClass="text-[#9A3A2D]" />
            <Kpi label="Due within 3 days" value={fmtN((data.production?.dueSoon3Days ?? []).length)} sub="early warning" icon={Clock} iconBgClass="bg-[#FAEFCB]" iconColorClass="text-[#9C6F1E]" valueColorClass="text-[#9C6F1E]" />
          </div>
          {data.production ? (
            <>
              <OverdueByDeptCard overdueByDept={data.production.overdueByDept} />
              <DueSoonWorklist orders={data.production.dueSoon3Days} />
            </>
          ) : (
            <Card className="border-[#F0D9AE] bg-[#FDF3E4]">
              <CardContent className="p-4 text-sm text-[#B5701A]">Overdue isn't available: {data.availability?.production?.reason ?? "production-orders:read is required"}.</CardContent>
            </Card>
          )}
          <ServiceApprovalsPanel title="Service case approvals" />
        </>
      )}
    </div>
  );
}
