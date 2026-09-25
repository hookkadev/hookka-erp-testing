import { useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LineChart, Line, ReferenceLine,
} from "recharts";
import { useCachedJson } from "@/lib/cached-fetch";
import { formatCurrency } from "@/lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { TAUPE, TEAL, AMBER, MUTED, BORDER, fmtN, fmtRMAxis, inPeriod, inFocus, dayLabel, periodLabel, type Period, type OpsSub } from "./dashboard-shared-lib";
import { Kpi, LiveBadge } from "./dashboard-shared";
import { AttendanceLogCard } from "./AttendanceLogCard";
import { DueSoonWorklist, type ProdOrderSummary } from "./OverdueCards";
import type { EmployeeSlice } from "./EmployeesInsights";
import { ProductionDailyPanels } from "./ProductionDailyPanels";
import { CompletedCard, DeptBacklogCard, FabricUsageCard, PlantLoadCard, PurchasingCard } from "./DashboardWidgets";

// Operations tab: the shop-floor report checklist (handed over on paper,
// 2026-09-17), redesigned 2026-09-18 for density: a single KPI strip, a 2-column chart split
// (overdue-by-dept / daily output), and a full-width filterable worklist for
// the due-soon early-warning list — instead of stacked, mostly-empty cards.
// Everything still reads the SAME cached GET /api/dashboard/prototype feed
// every other tab reads; no tab has an endpoint of its own.
type Feed = {
  success?: boolean;
  availability?: {
    production?: { live: boolean; reason?: string; costError?: string };
    inventory?: { live: boolean; reason?: string };
    employee?: { live: boolean; reason?: string };
  };
  production?: {
    orders: ProdOrderSummary[];
    overdueByDept: { department: string; count: number }[];
    dueSoon3Days: ProdOrderSummary[];
    dailyOutput: { date: string; orders: number; units: number }[];
    planVsActual: {
      rows: { poNo: string | null; productName: string | null; plan: string; actual: string; varianceDays: number }[];
      onTime: number;
      late: number;
      withBothDates: number;
      completedTotal: number;
    };
    // Optional, not just possibly-missing-in-theory: this key was added after
    // dashboard:prototype:* was already cached at a 60s TTL, so the first
    // request after a deploy can genuinely serve an old payload without it.
    productionCost?: {
      byDay: { date: string; materialSen: number; laborSen: number; overheadSen: number; totalSen: number; batches: number }[];
      totalBatches: number;
      batchesWithCost: number;
    };
  };
  inventory?: {
    materialShortage: { code: string | null; description: string | null; group: string | null; balanceQty: number }[];
  };
  employee?: EmployeeSlice;
};


// Monthly/range -> one bar per day; YTD -> one bar per month.
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

export function OperationsView({
  period, sub, onPeriodChange,
}: { period: Period; sub: OpsSub; onPeriodChange: (p: Period) => void }) {
  const { data, loading, error } = useCachedJson<Feed>("/api/dashboard/prototype");

  const production = data?.production;
  const inventory = data?.inventory;
  const employee = data?.employee;
  const prodLive = data?.availability?.production?.live ?? false;
  const invLive = data?.availability?.inventory?.live ?? false;

  const totalOverdue = useMemo(
    () => (production?.overdueByDept ?? []).reduce((a, d) => a + d.count, 0),
    [production?.overdueByDept],
  );

  // Overall stage-completion progress across every OPEN order — the "Plan vs
  // Actual" headline. Sums fields every order in `production.orders` already
  // carries (stagesDone/stagesTotal), so no new data, just an aggregate.
  const stageCompletion = useMemo(() => {
    const orders = production?.orders ?? [];
    const done = orders.reduce((a, o) => a + o.stagesDone, 0);
    const total = orders.reduce((a, o) => a + o.stagesTotal, 0);
    return { done, total, pct: total > 0 ? (done / total) * 100 : null };
  }, [production?.orders]);

  // Follows the global period picker (top right): Monthly = that month by day,
  // YTD = the year by month.
  const outputChartData = useMemo(
    () =>
      bucket((production?.dailyOutput ?? []).filter((d) => inPeriod(period, d.date)), period,
        (a, b) => ({ ...a, units: a.units + b.units }))
        .map((d) => ({ iso: d.iso, date: d.key, Units: d.units })),
    [production?.dailyOutput, period],
  );
  // Click a bar: a month in YTD opens that month, a day anywhere else is
  // highlighted (period.day, same field the datepicker writes). Charts keep
  // drawing the whole period; the KPIs and attendance log narrow to the day.
  const pick = (rows: { key?: string; date: string; iso: string }[]) => (e: { activeLabel?: unknown } | null) => {
    const hit = rows.find((d) => d.date === e?.activeLabel);
    if (!hit) return;
    if (period.mode === "ytd") onPeriodChange({ mode: "monthly", month: hit.iso });
    else onPeriodChange({ ...period, day: period.day === hit.iso ? undefined : hit.iso });
  };
  const dayLine = period.day && period.mode !== "ytd" ? period.day.slice(5) : null;

  const outputAvg = useMemo(
    () => (outputChartData.length ? outputChartData.reduce((a, d) => a + d.Units, 0) / outputChartData.length : 0),
    [outputChartData],
  );

  const costChartData = useMemo(
    () =>
      bucket((production?.productionCost?.byDay ?? []).filter((d) => inPeriod(period, d.date)), period,
        (a, b) => ({ ...a, materialSen: a.materialSen + b.materialSen, laborSen: a.laborSen + b.laborSen }))
        .map((d) => ({ iso: d.iso, date: d.key, Material: Math.round(d.materialSen / 100), Labor: Math.round(d.laborSen / 100) })),
    [production?.productionCost?.byDay, period],
  );
  const totalCostSen = useMemo(
    () => (production?.productionCost?.byDay ?? []).filter((d) => inFocus(period, d.date)).reduce((a, d) => a + d.totalSen, 0),
    [production?.productionCost?.byDay, period],
  );

  // Attendance — the table only ever records a PRESENT row (no absence rows
  // exist, MEASURED — see dashboard-prototype.ts's own header comment), so
  // "has a row on the latest date" is the honest ceiling of what this data
  // can say, not a true present/absent split.
  const attendanceStat = useMemo(() => {
    const rows = employee?.attendance ?? [];
    const headcount = (employee?.workers ?? []).filter((w) => w.countsToHeadcount).length;
    const latest = rows.reduce((m, r) => (r.date && r.date > m ? r.date : m), "");
    if (!latest || headcount === 0) return { pct: null, present: 0, headcount };
    const present = new Set(rows.filter((r) => r.date === latest && r.employeeId).map((r) => r.employeeId)).size;
    return { pct: (present / headcount) * 100, present, headcount };
  }, [employee]);

  // Efficiency — production ÷ working minutes, whole-book overall plus a
  // 7-day sparkline. Same house metric the Employees tab uses (working_hour_
  // entries clocked ÷ completed job_cards earned), not attendance_records.
  const efficiencyStat = useMemo(() => {
    const days = (employee?.performance.byDay ?? []).filter((d) => inFocus(period, d.date));
    const totalWorking = days.reduce((a, d) => a + d.workingMinutes, 0);
    const totalProduction = days.reduce((a, d) => a + d.productionMinutes, 0);
    const last7 = [...days].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-7).map((d) => ({
      date: d.date,
      pct: d.workingMinutes > 0 ? (d.productionMinutes / d.workingMinutes) * 100 : 0,
    }));
    return {
      pct: totalWorking > 0 ? (totalProduction / totalWorking) * 100 : null,
      sparkline: last7,
    };
  }, [employee, period]);

  if (loading) {
    return <div className="py-16 text-center text-sm text-[#6B7280]">Loading…</div>;
  }
  if (error || !data?.success) {
    return (
      <Card className="border-[#F0D9AE] bg-[#FDF3E4]">
        <CardContent className="p-4 text-sm text-[#B5701A]">
          Couldn't load Operations: {error ?? "unknown error"}
        </CardContent>
      </Card>
    );
  }

  const pva = production?.planVsActual;

  return (
    <div className="space-y-5 max-md:space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Operations</h2>
        <LiveBadge live={prodLive && invLive} />
        {!period.day && <span className="text-xs text-[#6B7280]">{periodLabel(period)}</span>}
        {period.day && (
          <button
            type="button"
            onClick={() => onPeriodChange({ ...period, day: undefined })}
            className="text-xs rounded-md border border-[#E5E0D8] bg-[#F7F5F3] px-2 py-0.5 text-[#6B5C32] hover:bg-white max-md:min-h-10 max-md:px-3 max-md:text-left"
          >
            Showing: {dayLabel(period.day)} — click to go back
          </button>
        )}
      </div>

      {sub === "overview" && (
        <>
            {/* ---- KPI groups: Orders (3) on top, Materials & cost | People (2+2) below at xl ---- */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-5 gap-y-4">
             <div className="xl:col-span-2">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#6B7280]">Orders</p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <Kpi
                label="Overdue Orders"
                value={fmtN(totalOverdue)}
                sub="all departments"
                valueColorClass="text-[#9A3A2D]"
              />
              <Kpi
                label="Due Within 3 Days"
                value={fmtN((production?.dueSoon3Days ?? []).length)}
                sub="early warning"
                valueColorClass="text-[#9C6F1E]"
              />
              <div className="col-span-2 md:col-span-1">
                <Card>
                  <CardContent className="p-4">
                    <p className="text-xs text-[#6B7280] truncate">Plan vs Actual</p>
                    <p className="mt-1 font-bold truncate tabular-nums text-2xl text-[#1F1D1B]">
                      {stageCompletion.pct == null ? "—" : `${stageCompletion.pct.toFixed(1)}%`}
                    </p>
                    <div className="mt-2.5">
                      <div className="h-1.5 w-full rounded-full bg-[#E2DDD8] overflow-hidden">
                        <div
                          className="h-full rounded-full bg-[#4F7C3A]"
                          style={{ width: `${Math.min(100, stageCompletion.pct ?? 0)}%` }}
                        />
                      </div>
                      <p className="mt-1 text-[10.5px] text-[#6B7280] tabular-nums">
                        {fmtN(stageCompletion.done)} / {fmtN(stageCompletion.total)} stages
                      </p>
                    </div>
                  </CardContent>
                </Card>
              </div>
              </div>
             </div>
             <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#6B7280]">Materials &amp; cost</p>
              {/* Cost gets the wider slot so an RM figure doesn't truncate. */}
              <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3">
              <Kpi
                label="Material Shortage"
                value={fmtN((inventory?.materialShortage ?? []).length)}
                sub="at zero/negative stock"
              />
              <Kpi
                label="Production Cost"
                value={formatCurrency(totalCostSen)}
                sub={
                  production?.productionCost
                    ? `${production.productionCost.batchesWithCost}/${production.productionCost.totalBatches} batches costed`
                    : undefined
                }
                valueColorClass="text-[#3E6570]"
                valueSizeClass="text-xl"
              />
              </div>
             </div>
             <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#6B7280]">People</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Kpi
                label="Attendance"
                value={attendanceStat.pct == null ? "—" : `${attendanceStat.pct.toFixed(1)}%`}
                sub={`${fmtN(attendanceStat.present)} / ${fmtN(attendanceStat.headcount)} recorded, latest day`}
              />
              <div className="col-span-1">
                <Card>
                  <CardContent className="p-4">
                    <p className="text-xs text-[#6B7280] truncate">Efficiency (Prod ÷ Working)</p>
                    <p className="mt-1 font-bold truncate tabular-nums text-2xl text-[#3E6570]">
                      {efficiencyStat.pct == null ? "—" : `${efficiencyStat.pct.toFixed(1)}%`}
                    </p>
                    <div style={{ width: "100%", height: 32 }} className="mt-1.5">
                      {efficiencyStat.sparkline.length > 1 && (
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={efficiencyStat.sparkline} margin={{ top: 2, right: 2, bottom: 0, left: 2 }}>
                            <Line type="monotone" dataKey="pct" stroke={TEAL} strokeWidth={1.75} dot={false} />
                          </LineChart>
                        </ResponsiveContainer>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
              </div>
             </div>
            </div>

            {/* How loaded is the plant (dial) · where is it stuck (per-dept board:
                queue days + overdue + due-soon) · what's due next (lanes). */}
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 items-start">
              <div className="lg:col-span-2 min-w-0">
                <PlantLoadCard period={period} />
              </div>
              <div className="lg:col-span-3 min-w-0">
                <DeptBacklogCard
                  period={period}
                  overdueByDept={production?.overdueByDept ?? []}
                  dueSoon={production?.dueSoon3Days ?? []}
                />
              </div>
            </div>

            <DueSoonWorklist orders={production?.dueSoon3Days ?? []} />

            {employee && <AttendanceLogCard employee={employee} period={period} />}
        </>
      )}

      {sub === "production" && (
        <>
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle>{period.mode === "ytd" ? "Monthly" : "Daily"} Production Output</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="select-none [&_*]:outline-none [&_.recharts-wrapper]:outline-none" style={{ width: "100%", height: 260 }}>
                    {outputChartData.length === 0 ? (
                      <div className="flex items-center justify-center h-full text-xs text-[#6B7280]">No completions in range.</div>
                    ) : (
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={outputChartData} margin={{ top: 6, right: 6, bottom: 0, left: 0 }} style={{ cursor: "pointer" }} onClick={pick(outputChartData)}>
                          <XAxis dataKey="date" tick={{ fontSize: 10, fill: MUTED }} axisLine={{ stroke: BORDER }} tickLine={false} />
                          <YAxis tick={{ fontSize: 10, fill: MUTED }} axisLine={false} tickLine={false} width={32} allowDecimals={false} />
                          <Tooltip cursor={{ fill: "#F0ECE9" }} contentStyle={{ background: "#FFFFFF", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12 }} />
                          <Bar dataKey="Units" fill={TAUPE} radius={[3, 3, 0, 0]} />
                          {dayLine && <ReferenceLine x={dayLine} stroke={AMBER} strokeWidth={2} />}
                          <ReferenceLine y={outputAvg} stroke={AMBER} strokeDasharray="4 3" strokeWidth={1.5} />
                        </BarChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                  <p className="mt-2 text-xs text-[#6B7280]">
                    {periodLabel(period)}, by completion date. Dashed line is the {fmtN(Math.round(outputAvg))}-unit
                    average per bar — there's no configured target anywhere in the data, so this is a
                    baseline to compare against, not an owner-set target.
                  </p>
                </CardContent>
              </Card>

              <CompletedCard period={period} />

        </>
      )}

      {sub === "plan" && (
        <>
          <ProductionDailyPanels period={period} sub="plan" onPeriodChange={onPeriodChange} />
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle>On-time completion · by order</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto" style={{ maxHeight: 300, overflowY: "auto" }}>
                    <table className="w-full text-[12px]">
                      <thead>
                        <tr className="*:sticky *:top-0 *:z-10 *:bg-white *:shadow-[inset_0_1px_0_#E2DDD8,inset_0_-1px_0_#E2DDD8]">
                          {["PO No", "Plan", "Actual", "Variance"].map((h) => (
                            <th key={h} className="text-left px-3 py-1.5 font-semibold uppercase text-[10px] tracking-wide text-[#6B7280]">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(pva?.rows ?? []).slice(0, 100).map((r, i) => (
                          <tr key={r.poNo ?? i} className="border-b border-[#E2DDD8]">
                            <td className="px-3 py-1.5 font-mono text-[#1F1D1B]">{r.poNo ?? "—"}</td>
                            <td className="px-3 py-1.5 tabular-nums text-[#6B7280]">{r.plan}</td>
                            <td className="px-3 py-1.5 tabular-nums text-[#6B7280]">{r.actual}</td>
                            <td className={`px-3 py-1.5 tabular-nums font-semibold ${r.varianceDays > 0 ? "text-[#9A3A2D]" : "text-[#4F7C3A]"}`}>
                              {r.varianceDays > 0 ? `+${r.varianceDays}d` : r.varianceDays === 0 ? "on time" : `${-r.varianceDays}d early`}
                            </td>
                          </tr>
                        ))}
                        {(pva?.rows ?? []).length === 0 && (
                          <tr><td colSpan={4} className="px-3 py-5 text-center text-[#6B7280]">No completed order carries both dates.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  {pva && (
                    <p className="px-3 pb-2 pt-1.5 text-[11px] text-[#6B7280]">
                      {pva.onTime} / {pva.withBothDates} on time, of {pva.completedTotal} completed orders total.
                    </p>
                  )}
                </CardContent>
              </Card>
        </>
      )}

      {sub === "cost" && (
        <>
          <ProductionDailyPanels period={period} sub="revenue" onPeriodChange={onPeriodChange} />
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle>Production Cost trend · {periodLabel(period)}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="select-none [&_*]:outline-none [&_.recharts-wrapper]:outline-none" style={{ width: "100%", height: 200 }}>
                    {costChartData.length === 0 ? (
                      <div className="flex items-center justify-center h-full text-xs text-[#6B7280]">No costed batches.</div>
                    ) : (
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={costChartData} margin={{ top: 6, right: 6, bottom: 0, left: 0 }} style={{ cursor: "pointer" }} onClick={pick(costChartData)}>
                          <XAxis dataKey="date" tick={{ fontSize: 10, fill: MUTED }} axisLine={{ stroke: BORDER }} tickLine={false} />
                          <YAxis tick={{ fontSize: 10, fill: MUTED }} axisLine={false} tickLine={false} width={44} tickFormatter={(v) => fmtRMAxis(Number(v))} />
                          <Tooltip
                            formatter={(v) => formatCurrency(Math.round(Number(v) * 100))}
                            contentStyle={{ background: "#FFFFFF", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12 }}
                          />
                          <Bar dataKey="Material" stackId="cost" fill={TAUPE} />
                          <Bar dataKey="Labor" stackId="cost" fill={TEAL} radius={[3, 3, 0, 0]} />
                          {dayLine && <ReferenceLine x={dayLine} stroke={AMBER} strokeWidth={2} />}
                        </BarChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                  <p className="mt-2 text-[11px] text-[#6B7280]">
                    Reads <span className="font-mono">fg_batches</span>; most batches read RM 0 until{" "}
                    <span className="font-mono">po-cost-cascade.ts</span> settles their cost.
                  </p>
                </CardContent>
              </Card>
        </>
      )}

      {sub === "materials" && (
        <>
            <PurchasingCard period={period} />
            <FabricUsageCard period={period} />
            <Card>
              <CardHeader className="pb-3">
                <CardTitle>Material Shortage detail</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto" style={{ maxHeight: 260, overflowY: "auto" }}>
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr className="*:sticky *:top-0 *:z-10 *:bg-white *:shadow-[inset_0_1px_0_#E2DDD8,inset_0_-1px_0_#E2DDD8]">
                        {["Code", "Description", "Group", "Balance Qty"].map((h) => (
                          <th key={h} className="text-left px-4 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280]">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(inventory?.materialShortage ?? []).map((m, i) => (
                        <tr key={m.code ?? i} className="border-b border-[#E2DDD8]">
                          <td className="px-4 py-2 font-mono text-[#1F1D1B]">{m.code ?? "—"}</td>
                          <td className="px-4 py-2 text-[#6B7280]">{m.description ?? "—"}</td>
                          <td className="px-4 py-2 text-[#6B7280]">{m.group ?? "—"}</td>
                          <td className="px-4 py-2 tabular-nums text-[#9A3A2D] font-semibold">{m.balanceQty}</td>
                        </tr>
                      ))}
                      {(inventory?.materialShortage ?? []).length === 0 && (
                        <tr><td colSpan={4} className="px-4 py-6 text-center text-[#6B7280]">Nothing at zero or negative stock.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <p className="px-4 pb-3 pt-2 text-xs text-[#6B7280]">
                  Proxy, not a real reorder-point check: <span className="font-mono">min_stock</span> is 0 on every raw
                  material row, so this lists active items sitting at zero/negative balance instead.
                </p>
              </CardContent>
            </Card>
        </>
      )}
    </div>
  );
}
