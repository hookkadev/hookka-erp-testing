import { useMemo, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LineChart, Line, ReferenceLine, Cell,
} from "recharts";
import { useCachedJson } from "@/lib/cached-fetch";
import { formatCurrency } from "@/lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { AlertTriangle, Clock, CalendarClock, PackageX, DollarSign, UserCheck, Gauge, Search } from "lucide-react";
import { TAUPE, TEAL, RED, AMBER, MUTED, BORDER, fmtN, fmtRMAxis, inPeriod, periodLabel, type Period, type SitiSub } from "./dashboard-shared-lib";
import { Kpi, LiveBadge } from "./dashboard-shared";

// Siti's report checklist (handed over on paper, 2026-09-17), redesigned
// 2026-09-18 for density: a single KPI strip, a 2-column chart split
// (overdue-by-dept / daily output), and a full-width filterable worklist for
// the due-soon early-warning list — instead of stacked, mostly-empty cards.
// Everything still reads the SAME cached GET /api/dashboard/prototype feed
// every other tab reads; no tab has an endpoint of its own.
type ProdOrderSummary = {
  poNo: string | null;
  customer: string | null;
  productName: string | null;
  currentDept: string | null;
  daysToDD: number | null;
  stagesDone: number;
  stagesTotal: number;
};

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
  employee?: {
    workers: { id: string; countsToHeadcount: boolean }[];
    attendance: {
      employeeId: string | null;
      employeeName: string | null;
      date: string | null;
      clockIn: string | null;
      clockOut: string | null;
      workingMinutes: number;
      productionMinutes: number;
      efficiencyPct: number | null;
    }[];
    performance: { byDay: { date: string; workingMinutes: number; productionMinutes: number }[] };
  };
};


// Monthly/range -> one bar per day; YTD -> one bar per month.
function bucket<T extends { date: string }>(rows: T[], p: Period, add: (a: T, b: T) => T) {
  if (p.mode !== "ytd") return rows.map((r) => ({ ...r, key: r.date.slice(5) }));
  const m = new Map<string, T & { key: string }>();
  for (const r of rows) {
    const key = r.date.slice(0, 7);
    const cur = m.get(key);
    m.set(key, cur ? { ...add(cur, r), key } : { ...r, key });
  }
  return [...m.values()];
}

const hrs = (min: number) => `${Math.round(min / 6) / 10}h`;
const hhmm = (t: string | null) => t?.match(/\d{2}:\d{2}/)?.[0] ?? "—";
// Minutes after the 08:00 shift start; 0 when on time or unparseable.
const lateMin = (t: string | null) => {
  const m = t?.match(/(\d{2}):(\d{2})/);
  return m ? Math.max(0, Number(m[1]) * 60 + Number(m[2]) - 480) : 0;
};

const DEPT_ALL_TAB: TabItem<string>[] = [{ key: "ALL", label: "All" }];

function urgencyPill(daysLeft: number | null) {
  if (daysLeft == null) return { label: "—", bg: "#F0ECE9", fg: "#6B5C32" };
  if (daysLeft <= 1) return { label: daysLeft <= 0 ? "Overdue/1 Day" : "1 Day", bg: "#FBE7E3", fg: "#9A3A2D" };
  return { label: `${daysLeft} Days`, bg: "#FAEFCB", fg: "#9C6F1E" };
}

export function SitiOpsView({ period, sub }: { period: Period; sub: SitiSub }) {
  const { data, loading, error } = useCachedJson<Feed>("/api/dashboard/prototype");
  const [deptFilter, setDeptFilter] = useState("ALL");
  const [search, setSearch] = useState("");

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

  const deptChartData = useMemo(
    () => [...(production?.overdueByDept ?? [])].sort((a, b) => a.count - b.count),
    [production?.overdueByDept],
  );

  // Follows the global period picker (top right): Monthly = that month by day,
  // YTD = the year by month.
  const outputChartData = useMemo(
    () =>
      bucket((production?.dailyOutput ?? []).filter((d) => inPeriod(period, d.date)), period,
        (a, b) => ({ ...a, units: a.units + b.units }))
        .map((d) => ({ date: d.key, Units: d.units })),
    [production?.dailyOutput, period],
  );
  const outputAvg = useMemo(
    () => (outputChartData.length ? outputChartData.reduce((a, d) => a + d.Units, 0) / outputChartData.length : 0),
    [outputChartData],
  );

  const costChartData = useMemo(
    () =>
      bucket((production?.productionCost?.byDay ?? []).filter((d) => inPeriod(period, d.date)), period,
        (a, b) => ({ ...a, materialSen: a.materialSen + b.materialSen, laborSen: a.laborSen + b.laborSen }))
        .map((d) => ({ date: d.key, Material: Math.round(d.materialSen / 100), Labor: Math.round(d.laborSen / 100) })),
    [production?.productionCost?.byDay, period],
  );
  const totalCostSen = useMemo(
    () => (production?.productionCost?.byDay ?? []).filter((d) => inPeriod(period, d.date)).reduce((a, d) => a + d.totalSen, 0),
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
    const days = (employee?.performance.byDay ?? []).filter((d) => inPeriod(period, d.date));
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

  // Attendance log: latest recorded day per employee inside the period, plus
  // that employee's day count in the period.
  const attendanceLog = useMemo(() => {
    const byEmp = new Map<string, { last: NonNullable<Feed["employee"]>["attendance"][number]; days: number }>();
    for (const r of employee?.attendance ?? []) {
      if (!r.date || !inPeriod(period, r.date)) continue;
      const k = r.employeeId ?? r.employeeName ?? "";
      const cur = byEmp.get(k);
      byEmp.set(k, { last: !cur || r.date >= (cur.last.date ?? "") ? r : cur.last, days: (cur?.days ?? 0) + 1 });
    }
    const rows = [...byEmp.values()]
      .map(({ last, days }) => ({ ...last, days, nonProd: Math.max(0, last.workingMinutes - last.productionMinutes) }))
      .sort((a, b) => (a.employeeName ?? "").localeCompare(b.employeeName ?? ""));
    const effs = rows.map((r) => r.efficiencyPct).filter((v): v is number => v != null);
    return {
      rows,
      working: rows.reduce((a, r) => a + r.workingMinutes, 0),
      prod: rows.reduce((a, r) => a + r.productionMinutes, 0),
      nonProd: rows.reduce((a, r) => a + r.nonProd, 0),
      days: rows.reduce((a, r) => a + r.days, 0),
      eff: effs.length ? effs.reduce((a, v) => a + v, 0) / effs.length : null,
    };
  }, [employee?.attendance, period]);

  // Bottom worklist — the due-within-3-days early warning list, filterable
  // by department and free-text search over PO/customer/product.
  const dueSoonDepts = useMemo(
    () => [...new Set((production?.dueSoon3Days ?? []).map((o) => o.currentDept || "(no dept)"))].sort(),
    [production?.dueSoon3Days],
  );
  const worklistTabs: TabItem<string>[] = useMemo(
    () => [...DEPT_ALL_TAB, ...dueSoonDepts.map((d) => ({ key: d, label: d }))],
    [dueSoonDepts],
  );
  const worklistRows = useMemo(() => {
    const rows = production?.dueSoon3Days ?? [];
    const q = search.trim().toLowerCase();
    return rows
      .filter((o) => deptFilter === "ALL" || (o.currentDept || "(no dept)") === deptFilter)
      .filter((o) => !q || [o.poNo, o.customer, o.productName].some((v) => (v ?? "").toLowerCase().includes(q)))
      .sort((a, b) => (a.daysToDD ?? 0) - (b.daysToDD ?? 0));
  }, [production?.dueSoon3Days, deptFilter, search]);

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
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Operations (Siti's list)</h2>
        <LiveBadge live={prodLive && invLive} />
      </div>

      {sub === "overview" && (
        <>
            {/* ---- KPI strip: 7 cards, one row on desktop ------------------------ */}
            <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-3">
              <Kpi
                label="Overdue Orders"
                value={fmtN(totalOverdue)}
                sub="all departments"
                icon={AlertTriangle}
                iconBgClass="bg-[#FBE7E3]"
                iconColorClass="text-[#9A3A2D]"
                valueColorClass="text-[#9A3A2D]"
              />
              <Kpi
                label="Due Within 3 Days"
                value={fmtN((production?.dueSoon3Days ?? []).length)}
                sub="early warning"
                icon={Clock}
                iconBgClass="bg-[#FAEFCB]"
                iconColorClass="text-[#9C6F1E]"
                valueColorClass="text-[#9C6F1E]"
              />
              <div className="col-span-1">
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="rounded-lg p-2.5 shrink-0 bg-[#EEF3E4]">
                        <CalendarClock className="h-5 w-5 text-[#4F7C3A]" />
                      </div>
                      <div className="min-w-0">
                        <p className="font-bold truncate tabular-nums text-2xl text-[#1F1D1B]">
                          {stageCompletion.pct == null ? "—" : `${stageCompletion.pct.toFixed(1)}%`}
                        </p>
                        <p className="text-xs text-[#6B7280]">Plan vs Actual</p>
                      </div>
                    </div>
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
              <Kpi
                label="Material Shortage"
                value={fmtN((inventory?.materialShortage ?? []).length)}
                sub="at zero/negative stock"
                icon={PackageX}
                iconBgClass="bg-[#F0ECE9]"
                iconColorClass="text-[#6B5C32]"
              />
              <Kpi
                label="Production Cost"
                value={formatCurrency(totalCostSen)}
                sub={
                  production?.productionCost
                    ? `${production.productionCost.batchesWithCost}/${production.productionCost.totalBatches} batches costed`
                    : undefined
                }
                icon={DollarSign}
                iconBgClass="bg-[#E6F0F3]"
                iconColorClass="text-[#3E6570]"
                valueColorClass="text-[#3E6570]"
                valueSizeClass="text-xl"
              />
              <Kpi
                label="Attendance"
                value={attendanceStat.pct == null ? "—" : `${attendanceStat.pct.toFixed(1)}%`}
                sub={`${fmtN(attendanceStat.present)} / ${fmtN(attendanceStat.headcount)} recorded, latest day`}
                icon={UserCheck}
                iconBgClass="bg-[#E6F0F3]"
                iconColorClass="text-[#3E6570]"
              />
              <div className="col-span-1">
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="rounded-lg p-2.5 shrink-0 bg-[#E6F0F3]">
                        <Gauge className="h-5 w-5 text-[#3E6570]" />
                      </div>
                      <div className="min-w-0">
                        <p className="font-bold truncate tabular-nums text-2xl text-[#3E6570]">
                          {efficiencyStat.pct == null ? "—" : `${efficiencyStat.pct.toFixed(1)}%`}
                        </p>
                        <p className="text-xs text-[#6B7280]">Efficiency (Prod ÷ Working)</p>
                      </div>
                    </div>
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

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle>Overdue by department</CardTitle>
                </CardHeader>
                <CardContent>
                  <div style={{ width: "100%", height: Math.max(160, deptChartData.length * 34) }}>
                    {deptChartData.length === 0 ? (
                      <div className="flex items-center justify-center h-full text-xs text-[#6B7280]">No overdue orders.</div>
                    ) : (
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={deptChartData} layout="vertical" margin={{ top: 4, right: 20, bottom: 0, left: 4 }}>
                          <XAxis type="number" tick={{ fontSize: 10, fill: MUTED }} axisLine={false} tickLine={false} allowDecimals={false} />
                          <YAxis type="category" dataKey="department" width={90} tick={{ fontSize: 11, fill: "#1F1D1B" }} axisLine={false} tickLine={false} />
                          <Tooltip contentStyle={{ background: "#FFFFFF", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12 }} />
                          <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                            {deptChartData.map((d) => (
                              <Cell key={d.department} fill={d.count >= 10 ? RED : d.count >= 4 ? AMBER : TAUPE} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </CardContent>
              </Card>

            {/* ---- Bottom: due-within-3-days worklist ---------------------------- */}
            <Card>
              <CardHeader className="pb-3 flex flex-row items-center justify-between gap-3 flex-wrap">
                <CardTitle>Due within 3 Days — Early Warning Worklist</CardTitle>
                <div className="relative w-full max-w-[220px]">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#9CA3AF]" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search PO, customer, product…"
                    className="h-8 pl-8 text-xs"
                  />
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <div className="px-4 pb-3">
                  <Tabs tabs={worklistTabs} value={deptFilter} onChange={setDeptFilter} variant="pill" />
                </div>
                <div className="overflow-x-auto" style={{ maxHeight: 420, overflowY: "auto" }}>
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr className="border-t border-b border-[#E2DDD8] sticky top-0 bg-white">
                        {["PO Number", "Customer", "Product Description", "Department", "Urgency / Days Left"].map((h) => (
                          <th key={h} className="text-left px-3 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280]">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {worklistRows.map((o, i) => {
                        const pill = urgencyPill(o.daysToDD);
                        return (
                          <tr key={o.poNo ?? i} className="border-b border-[#E2DDD8]">
                            <td className="px-3 py-2 font-mono text-[#1F1D1B] whitespace-nowrap">{o.poNo ?? "—"}</td>
                            <td className="px-3 py-2 text-[#1F1D1B]">{o.customer ?? "—"}</td>
                            <td className="px-3 py-2 text-[#6B7280]">{o.productName ?? "—"}</td>
                            <td className="px-3 py-2 text-[#6B7280] whitespace-nowrap">{o.currentDept ?? "—"}</td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              <span
                                className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
                                style={{ background: pill.bg, color: pill.fg }}
                              >
                                {pill.label}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                      {worklistRows.length === 0 && (
                        <tr><td colSpan={5} className="px-4 py-6 text-center text-[#6B7280]">Nothing matches this filter.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            {/* ---- Attendance log: latest recorded day per employee -------------- */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle>
                  Attendance log{" "}
                  <span className="ml-2 text-[11px] font-normal text-[#6B7280]">
                    {attendanceLog.rows.length} employees · latest recorded day each · {periodLabel(period)}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto" style={{ maxHeight: 460, overflowY: "auto" }}>
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr className="border-t border-b border-[#E2DDD8] sticky top-0 bg-white">
                        {["Employee", "Date", "Clock in", "Clock out", "Production time", "Prod hours", "Non-prod hours", "Efficiency", "Total days", "Status"].map((h, i) => (
                          <th key={h} className={`px-3 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280] whitespace-nowrap ${i >= 4 && i <= 8 ? "text-right" : "text-left"}`}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {attendanceLog.rows.map((r, i) => {
                        const late = lateMin(r.clockIn);
                        const eff = r.efficiencyPct;
                        return (
                          <tr key={r.employeeId ?? i} className="border-b border-[#E2DDD8]">
                            <td className="px-3 py-2 text-[#1F1D1B]">{r.employeeName ?? "—"}</td>
                            <td className="px-3 py-2 text-[#6B7280] whitespace-nowrap">{r.date ? `${Number(r.date.slice(8))} ${new Date(r.date).toLocaleString("en", { month: "short" })}` : "—"}</td>
                            <td className="px-3 py-2 font-mono">{hhmm(r.clockIn)}</td>
                            <td className="px-3 py-2 font-mono">{hhmm(r.clockOut)}</td>
                            <td className="px-3 py-2 text-right font-mono">{hrs(r.workingMinutes)}</td>
                            <td className="px-3 py-2 text-right font-mono">{hrs(r.productionMinutes)}</td>
                            <td className={`px-3 py-2 text-right font-mono ${r.nonProd > 90 ? "text-[#B5701A]" : "text-[#6B7280]"}`}>{hrs(r.nonProd)}</td>
                            <td className="px-3 py-2 text-right font-mono font-semibold" style={{ color: eff == null ? MUTED : eff >= 90 ? "#4F7C3A" : "#B5701A" }}>
                              {eff == null ? "—" : `${eff.toFixed(1)}%`}
                            </td>
                            <td className="px-3 py-2 text-right font-mono">{r.days}</td>
                            <td className="px-3 py-2">
                              <span
                                className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold"
                                style={late ? { background: "#F0ECE9", color: "#6B5C32" } : { background: "#EEF3E4", color: "#4F7C3A" }}
                              >
                                {late ? `Late ${late}m` : "On time"}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                      {attendanceLog.rows.length === 0 && (
                        <tr><td colSpan={10} className="px-4 py-6 text-center text-[#6B7280]">No attendance recorded in this period.</td></tr>
                      )}
                    </tbody>
                    {attendanceLog.rows.length > 0 && (
                      <tfoot>
                        <tr className="border-t-2 border-[#E2DDD8] font-mono font-semibold">
                          <td className="px-3 py-2" colSpan={4}>Listed rows</td>
                          <td className="px-3 py-2 text-right">{hrs(attendanceLog.working)}</td>
                          <td className="px-3 py-2 text-right">{hrs(attendanceLog.prod)}</td>
                          <td className="px-3 py-2 text-right">{hrs(attendanceLog.nonProd)}</td>
                          <td className="px-3 py-2 text-right">{attendanceLog.eff == null ? "—" : `${attendanceLog.eff.toFixed(1)}%`}</td>
                          <td className="px-3 py-2 text-right">{attendanceLog.days}</td>
                          <td />
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </CardContent>
            </Card>
        </>
      )}

      {sub === "production" && (
        <>
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle>{period.mode === "ytd" ? "Monthly" : "Daily"} Production Output</CardTitle>
                </CardHeader>
                <CardContent>
                  <div style={{ width: "100%", height: 260 }}>
                    {outputChartData.length === 0 ? (
                      <div className="flex items-center justify-center h-full text-xs text-[#6B7280]">No completions in range.</div>
                    ) : (
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={outputChartData} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
                          <XAxis dataKey="date" tick={{ fontSize: 10, fill: MUTED }} axisLine={{ stroke: BORDER }} tickLine={false} />
                          <YAxis tick={{ fontSize: 10, fill: MUTED }} axisLine={false} tickLine={false} width={32} allowDecimals={false} />
                          <Tooltip contentStyle={{ background: "#FFFFFF", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12 }} />
                          <Bar dataKey="Units" fill={TAUPE} radius={[3, 3, 0, 0]} />
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

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle>On-Time Completion (Plan vs Actual detail)</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto" style={{ maxHeight: 300, overflowY: "auto" }}>
                    <table className="w-full text-[12px]">
                      <thead>
                        <tr className="border-t border-b border-[#E2DDD8] sticky top-0 bg-white">
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
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle>Production Cost trend · {periodLabel(period)}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div style={{ width: "100%", height: 200 }}>
                    {costChartData.length === 0 ? (
                      <div className="flex items-center justify-center h-full text-xs text-[#6B7280]">No costed batches.</div>
                    ) : (
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={costChartData} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
                          <XAxis dataKey="date" tick={{ fontSize: 10, fill: MUTED }} axisLine={{ stroke: BORDER }} tickLine={false} />
                          <YAxis tick={{ fontSize: 10, fill: MUTED }} axisLine={false} tickLine={false} width={44} tickFormatter={(v) => fmtRMAxis(Number(v) * 100)} />
                          <Tooltip
                            formatter={(v) => formatCurrency(Math.round(Number(v) * 100))}
                            contentStyle={{ background: "#FFFFFF", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12 }}
                          />
                          <Bar dataKey="Material" stackId="cost" fill={TAUPE} />
                          <Bar dataKey="Labor" stackId="cost" fill={TEAL} radius={[3, 3, 0, 0]} />
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
            <Card>
              <CardHeader className="pb-3">
                <CardTitle>Material Shortage detail</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto" style={{ maxHeight: 260, overflowY: "auto" }}>
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr className="border-t border-b border-[#E2DDD8] sticky top-0 bg-white">
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
