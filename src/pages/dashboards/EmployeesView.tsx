import { useMemo, useRef, useState } from "react";
import { ComposedChart, Area, Line, XAxis, YAxis, Tooltip, Legend, ReferenceLine, ResponsiveContainer } from "recharts";
import { useCachedJson } from "@/lib/cached-fetch";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TimeAttendancePanels, EfficiencyPanels, DailyEfficiencyCard, DailyWarningAudit, type EmployeeSlice } from "./EmployeesInsights";
import { DeptEfficiencyCard } from "./ProductionDailyPanels";
import { DepartmentsView } from "./DepartmentsView";
import { AttendanceLogCard } from "./AttendanceLogCard";
import { filterSlice } from "./employee-filter";
import { TAUPE, TEAL, MUTED, BORDER, fmtN, inPeriod, overallEfficiencyPct, periodLabel, dayLabel, type Period, type PeopleSub } from "./dashboard-shared-lib";
import { Kpi, LiveBadge, MissingNote } from "./dashboard-shared";

// Real data from GET /api/dashboard/prototype — the `employee` +
// `availability.employee` slices (workers + working_hour_entries +
// job_cards, src/api/routes/dashboard-prototype.ts). `performance` is the
// house workforce metric (working_hour_entries clocked + completed job_cards
// earned) — NOT attendance_records.efficiency_pct, which is a different,
// looser number that happens to share a name (see the route's own note).
type Feed = {
  success?: boolean;
  availability?: { employee?: { live: boolean; reason?: string; workers: number; attendanceRows: number; missing?: string[] } };
  meta?: { config?: { efficiencyTargetPct?: number; workingHoursPerDay?: number } };
  employee?: {
    workers: {
      id: string; empNo: string | null; name: string | null; dept: string | null; role: string | null;
      status: string | null; targetPct: number | null; hoursPerDay: number | null; countsToHeadcount: boolean;
    }[];
    attendance: EmployeeSlice["attendance"];
    performance: {
      byDay: { date: string; workingMinutes: number; productionMinutes: number; allDeptMinutes: number }[];
      cards: number;
      measuredCards: number;
    };
  };
};

export function EmployeesView({
  period, sub, onPeriodChange,
}: { period: Period; sub: PeopleSub; onPeriodChange: (p: Period) => void }) {
  const { data, loading, error } = useCachedJson<Feed>("/api/dashboard/prototype");

  const employee = data?.employee;
  const live = data?.availability?.employee?.live ?? false;
  const missing = data?.availability?.employee?.missing ?? [];
  const config = data?.meta?.config;
  const target = config?.efficiencyTargetPct;

  const headcount = useMemo(
    () => (employee?.workers ?? []).filter((w) => w.countsToHeadcount).length,
    [employee?.workers],
  );

  const workers = useMemo(
    () => [...(employee?.workers ?? [])].filter((w) => w.countsToHeadcount).slice(0, 60),
    [employee?.workers],
  );

  // Scoped to the global period picker, same as every other dated tab.
  // headcount/target/hours-per-day above stay book-wide (workers have no
  // date of their own), only the daily hours series is filtered.
  const chartData = useMemo(
    () => (employee?.performance.byDay ?? [])
      .filter((d) => inPeriod(period, d.date))
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((d) => ({
        iso: d.date,
        date: d.date.slice(5),
        "Working Hours": Math.round((d.workingMinutes / 60) * 10) / 10,
        "Production Hours": Math.round((d.productionMinutes / 60) * 10) / 10,
      })),
    [employee?.performance.byDay, period],
  );

  // Company-wide, narrowed to a focused day like every other total. Same
  // helper as the Operations overview card.
  const efficiencyPct = useMemo(
    () => overallEfficiencyPct(employee?.performance.byDay ?? [], period),
    [employee?.performance.byDay, period],
  );

  // The dash alone read as broken. The People tab opens on today, and today's
  // hours are entered after the day, so say why the figure is missing.
  const noHoursNote = efficiencyPct == null
    ? `No production hours clocked ${period.day ? `on ${dayLabel(period.day)}` : `in ${periodLabel(period)}`}`
    : null;

  // Department / employee filter (Time & attendance and Efficiency tabs). Every
  // panel downstream reads the filtered slice, so picking a person re-derives
  // the tiles, pool line, ranking and log for just them.
  const [dept, setDept] = useState("");
  const [emp, setEmp] = useState("");
  const headcountWorkers = useMemo(
    () => (employee?.workers ?? []).filter((w) => w.countsToHeadcount).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    [employee?.workers],
  );
  const depts = useMemo(() => [...new Set(headcountWorkers.map((w) => w.dept).filter((d): d is string => !!d))].sort(), [headcountWorkers]);
  const empOptions = useMemo(() => headcountWorkers.filter((w) => !dept || w.dept === dept), [headcountWorkers, dept]);
  const filtered = useMemo(() => (employee ? filterSlice(employee, dept, emp) : undefined), [employee, dept, emp]);
  // The Time & attendance warning audit ignores the employee pick, so the
  // flagged list stays whole while one person's log is open above it.
  const deptOnly = useMemo(() => (employee ? filterSlice(employee, dept, "") : undefined), [employee, dept]);
  const shownCount = emp ? 1 : empOptions.length;

  // Picking a person in the ranking or the warning audit drills the Daily
  // efficiency chart into them (same `emp` as the filter bar) and brings the
  // chart back into view, since those rows sit below it.
  const effChartRef = useRef<HTMLDivElement>(null);
  const pickEmployee = (id: string) => {
    setEmp(id);
    effChartRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  // Time & attendance: a warning-audit row opens that person's Attendance log
  // (just above the audit); clicking the same row again goes back to everyone.
  const logRef = useRef<HTMLDivElement>(null);
  const pickForLog = (id: string) => {
    setEmp(id === emp ? "" : id);
    logRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (loading) {
    return <div className="py-16 text-center text-sm text-[#6B7280]">Loading…</div>;
  }
  if (error || !data?.success) {
    return (
      <Card className="border-[#F0D9AE] bg-[#FDF3E4]">
        <CardContent className="p-3 text-sm text-[#B5701A]">
          Couldn't load Employees:{error ?? "unknown error"}
        </CardContent>
      </Card>
    );
  }

  const selectCls = "h-9 max-md:h-10 rounded-md border border-[#E2DDD8] bg-[#E8E1D6] px-3 text-sm text-[#1F1D1B] focus:outline-none";
  // Sticky under the dashboard header (--dash-sticky-top, dashboard-prototype.tsx)
  // so department / employee stay switchable while scrolling. md+ only: on a
  // phone the stacked filters would eat most of the screen.
  const filterBar = (
    <Card className="md:sticky md:top-[var(--dash-sticky-top,0px)] md:z-20">
      <CardContent className="p-3 flex flex-wrap items-end gap-3">
        <label className="text-[11px] text-[#6B7280] space-y-1 block max-md:w-full">
          Department
          <select className={`${selectCls} block min-w-[180px] max-md:w-full max-md:min-w-0`} value={dept} onChange={(e) => { setDept(e.target.value); setEmp(""); }}>
            <option value="">All departments</option>
            {depts.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <label className="text-[11px] text-[#6B7280] space-y-1 block max-md:w-full">
          Employee
          <select className={`${selectCls} block min-w-[200px] max-md:w-full max-md:min-w-0`} value={emp} onChange={(e) => setEmp(e.target.value)}>
            <option value="">All employees</option>
            {empOptions.map((w) => <option key={w.id} value={w.id}>{w.name ?? w.empNo ?? w.id}</option>)}
          </select>
        </label>
        <button
          type="button"
          onClick={() => { setDept(""); setEmp(""); }}
          className="h-9 max-md:h-10 max-md:w-full rounded-md border border-[#E2DDD8] bg-[#E8E1D6] px-3 text-sm font-medium text-[#1F1D1B] hover:bg-[#DDD5C7]"
        >
          Reset
        </button>
        <span className="ml-auto max-md:ml-0 text-xs text-[#6B7280]">
          {shownCount} employee{shownCount === 1 ? "" : "s"} · {dept || "all departments"}
        </span>
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-4 max-md:space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Employees</h2>
        <LiveBadge live={live} />
        <span className="text-xs text-[#6B7280]">{periodLabel(period)}</span>
      </div>
      <MissingNote fields={missing} />

      {sub === "overview" && (
        <>

      {/* Two real metrics; the config constants (target, working day) ride
          along as a baseline line and a subtitle instead of their own tiles. */}
      <div className="space-y-2">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi
          label="Headcount"
          value={fmtN(headcount)}
          hint="ACTIVE workers, excluding TEST accounts"
        />
        <Kpi
          label="Overall Efficiency"
          value={efficiencyPct == null ? "—" : `${efficiencyPct.toFixed(1)}%`}
          sub={[noHoursNote, target != null ? `Target: ${target}%` : null].filter(Boolean).join(" · ") || undefined}
          hint="Production ÷ working hours, all production staff"
          valueColorClass="text-[#3E6570]"
        >
          {efficiencyPct != null && target != null && target > 0 && (
            <div className="mt-2 h-1.5 w-full rounded-full bg-[#E2DDD8] overflow-hidden">
              <div
                className={`h-full rounded-full ${efficiencyPct >= target ? "bg-[#4F7C3A]" : "bg-[#9C6F1E]"}`}
                style={{ width: `${Math.min(100, (efficiencyPct / target) * 100)}%` }}
              />
            </div>
          )}
        </Kpi>
      </div>
      {config?.workingHoursPerDay != null && (
        <p className="text-xs text-[#6B7280]">Standard working day: {config.workingHoursPerDay}h</p>
      )}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Working vs production hours</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="select-none [&_*]:outline-none [&_.recharts-wrapper]:outline-none" style={{ width: "100%", height: 220 }}>
            {chartData.length === 0 ? (
              <div className="flex items-center justify-center h-full text-xs text-[#6B7280]">
                No clocked hours in range.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={chartData}
                  margin={{ top: 6, right: 6, bottom: 0, left: 0 }}
                  style={{ cursor: "pointer" }}
                  onClick={(e) => {
                    const hit = chartData.find((d) => d.date === e?.activeLabel);
                    if (hit) onPeriodChange({ ...period, day: period.day === hit.iso ? undefined : hit.iso });
                  }}
                >
                  <defs>
                    <linearGradient id="empWorkGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={TAUPE} stopOpacity={0.22} />
                      <stop offset="100%" stopColor={TAUPE} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: MUTED }} axisLine={{ stroke: BORDER }} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: MUTED }} axisLine={false} tickLine={false} width={32} />
                  <Tooltip cursor={{ stroke: BORDER }} contentStyle={{ background: "#FFFFFF", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12 }} />
                  {period.day && <ReferenceLine x={period.day.slice(5)} stroke={TAUPE} strokeDasharray="3 3" />}
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Area type="monotone" dataKey="Working Hours" stroke={TAUPE} fill="url(#empWorkGrad)" strokeWidth={2} />
                  <Line type="monotone" dataKey="Production Hours" stroke={TEAL} strokeWidth={1.5} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Workers</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto" style={{ maxHeight: 440, overflowY: "auto" }}>
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="*:sticky *:top-0 *:z-10 *:bg-white *:shadow-[inset_0_1px_0_#E2DDD8,inset_0_-1px_0_#E2DDD8]">
                  {["Emp No", "Name", "Department", "Role", "Status", "Target %", "Hours/Day"].map((h) => (
                    <th key={h} className="text-left px-4 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280]">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {workers.map((w) => (
                  <tr key={w.id} className="border-b border-[#E2DDD8]">
                    <td className="px-4 py-2 font-mono text-[#1F1D1B]">{w.empNo ?? "—"}</td>
                    <td className="px-4 py-2 text-[#1F1D1B]">{w.name ?? "—"}</td>
                    <td className="px-4 py-2 text-[#6B7280]">{w.dept ?? "—"}</td>
                    <td className="px-4 py-2 text-[#6B7280]">{w.role ?? "—"}</td>
                    <td className="px-4 py-2">
                      {w.status && <Badge variant="status" status={w.status} />}
                    </td>
                    <td className="px-4 py-2 tabular-nums text-[#1F1D1B]">{w.targetPct ?? "—"}</td>
                    <td className="px-4 py-2 tabular-nums text-[#1F1D1B]">{w.hoursPerDay ?? "—"}</td>
                  </tr>
                ))}
                {workers.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-6 text-center text-[#6B7280]">No workers.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
        </>
      )}

      {sub === "time" && employee && filtered && (
        <>
          {filterBar}
          <TimeAttendancePanels employee={filtered} period={period} onPeriodChange={onPeriodChange} target={config?.efficiencyTargetPct ?? 100} />

          {/* The audit rides inside the log's `below` slot so it follows the log's
              Today / Yesterday switch; the wrapper spaces the two like siblings. */}
          <div ref={logRef} className="space-y-4 max-md:space-y-3 scroll-mt-[var(--dash-sticky-top,0px)] md:scroll-mt-[calc(var(--dash-sticky-top,0px)+96px)]">
            <AttendanceLogCard
              employee={filtered ?? employee}
              period={period}
              perDay={!!emp}
              below={(logPeriod) => deptOnly && (
                <DailyWarningAudit
                  employee={deptOnly}
                  period={logPeriod}
                  target={config?.efficiencyTargetPct ?? 100}
                  onPickEmployee={pickForLog}
                  selectedId={emp || undefined}
                />
              )}
            />
          </div>
        </>
      )}

      {sub === "efficiency" && employee && filtered && (
        <>
          {filterBar}
          {/* scroll-margin clears the sticky page header, plus the sticky
              filter bar on md+ (~90px), so the card top lands in view. */}
          <div ref={effChartRef} className="scroll-mt-[var(--dash-sticky-top,0px)] md:scroll-mt-[calc(var(--dash-sticky-top,0px)+96px)]">
            <DailyEfficiencyCard employee={filtered} period={period} onPeriodChange={onPeriodChange} target={config?.efficiencyTargetPct ?? 100} workerId={emp || undefined} onBack={() => setEmp("")} />
          </div>
          <DeptEfficiencyCard employee={filtered} period={period} target={config?.efficiencyTargetPct ?? 100} />
          <DepartmentsView employee={filtered} period={period} />
          <EfficiencyPanels employee={filtered} period={period} onPeriodChange={onPeriodChange} onPickEmployee={pickEmployee} target={config?.efficiencyTargetPct ?? 100} />
        </>
      )}
    </div>
  );
}
