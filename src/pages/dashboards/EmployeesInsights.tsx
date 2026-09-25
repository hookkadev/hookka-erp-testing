import { useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Filter } from "lucide-react";
import { PieChart, Pie, Cell, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, Legend, ReferenceLine, ResponsiveContainer } from "recharts";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { TAUPE, TEAL, MUTED, BORDER, AMBER, GREEN, fmtN, inPeriod, inFocus, dayLabel, dayList, warnDays, workerDays, auditTier, OVER_TIERS, periodLabel, type AuditTier, type Period } from "./dashboard-shared-lib";

// The Employees tab's time/efficiency panels. Everything here is derived from
// the SAME cached /api/dashboard/prototype `employee` slice the rest of the
// tab reads — no endpoint of its own, and nothing seeded.
//
// NOT in the feed, so deliberately not drawn: leave/absent hours (attendance_
// records only holds PRESENT rows; leave lives in leave_records) and per-worker
// units (attendance_records has no unit count) — see the route's header.
export type EmployeeSlice = {
  workers: { id: string; name: string | null; dept: string | null; role: string | null; countsToHeadcount: boolean }[];
  attendance: {
    employeeId: string | null;
    employeeName: string | null;
    dept: string | null;
    date: string | null;
    clockIn: string | null;
    clockOut: string | null;
    workingMinutes: number;
    productionMinutes: number;
    overtimeMinutes: number;
    efficiencyPct: number | null;
  }[];
  performance: {
    byDay: {
      date: string;
      workingMinutes: number;
      productionMinutes: number;
      allDeptMinutes?: number;
      workers?: { workerId: string; workingMinutes: number; productionMinutes: number; allDeptMinutes?: number }[];
    }[];
  };
};

const hrs = (min: number) => `${(min / 60).toLocaleString("en-MY", { maximumFractionDigits: 1 })}h`;
const pct1 = (v: number) => `${v.toFixed(1)}%`;
const TOOLTIP = { background: "#FFFFFF", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12 };

// Audit bands around the 100% baseline. The feed carries no configured warning
// threshold, so these are display choices, not policy.
const WARN_LOW = 90;
const WARN_HIGH = 150;
// A person clocking under an hour in the window has no meaningful ratio.
const MIN_RANK_MINUTES = 60;

type Common = {
  employee: EmployeeSlice; period: Period; target: number;
  onPeriodChange: (p: Period) => void;
  onPickEmployee?: (workerId: string) => void;
};

// "Showing: 12 Aug — click to go back", same affordance as the Sales Orders tab.
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

export function TimeAttendancePanels({ employee, period, target, onPeriodChange }: Common) {
  const att = useMemo(() => employee.attendance.filter((r) => inFocus(period, r.date)), [employee.attendance, period]);
  const t = useMemo(() => {
    const working = att.reduce((a, r) => a + r.workingMinutes, 0);
    const ot = att.reduce((a, r) => a + Math.min(r.overtimeMinutes, r.workingMinutes), 0);
    return { working, ot, regular: working - ot, days: att.length, people: new Set(att.map((r) => r.employeeId ?? r.employeeName)).size };
  }, [att]);

  // Tiles read the HOUSE metric (performance.byDay), not attendance_records'
  // own production_time_minutes, which is not what the office reads and comes
  // through as 0h for everyone.
  const house = useMemo(() => {
    const days = employee.performance.byDay.filter((d) => inFocus(period, d.date));
    const w = days.reduce((a, d) => a + d.workingMinutes, 0);
    const p = days.reduce((a, d) => a + d.productionMinutes, 0);
    const all = days.reduce((a, d) => a + (d.allDeptMinutes ?? d.workingMinutes), 0);
    return { w, p, nonProd: Math.max(0, all - w) };
  }, [employee.performance.byDay, period]);

  const donut = [
    { name: "Regular", value: t.regular, color: TAUPE },
    { name: "Overtime", value: t.ot, color: AMBER },
  ];
  const tiles: [string, string][] = [
    ["Production time", hrs(house.w)],
    ["Prod hours", hrs(house.p)],
    ["Non-prod hours", hrs(house.nonProd)],
    ["Total days worked", fmtN(t.days)],
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Time &amp; attendance</CardTitle>
          <p className="text-xs text-[#6B7280]">
            {hrs(t.working)} clocked across {period.day ? dayLabel(period.day) : periodLabel(period)} · {t.people} employees combined
          </p>
          <DayChip period={period} onPeriodChange={onPeriodChange} />
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-6 flex-wrap">
            <div className="relative" style={{ width: 130, height: 130 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={donut} dataKey="value" innerRadius={44} outerRadius={62} stroke="none">
                    {donut.map((d) => <Cell key={d.name} fill={d.color} />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
                <span className="font-mono text-sm font-semibold text-[#1F1D1B]">{hrs(t.working)}</span>
                <span className="text-[10px] text-[#6B7280]">worked</span>
              </div>
            </div>
            <ul className="flex-1 min-w-[160px] space-y-2 text-sm">
              {donut.map((d) => (
                <li key={d.name} className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ background: d.color }} />
                  <span className="text-[#6B7280]">{d.name}</span>
                  <span className="ml-auto font-mono text-[#1F1D1B]">{hrs(d.value)}</span>
                  <span className="font-mono text-xs text-[#6B7280] w-14 text-right">
                    ({t.working > 0 ? pct1((d.value / t.working) * 100) : "—"})
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2.5">
            {tiles.map(([label, v]) => (
              <div key={label} className="rounded-lg bg-[#F0ECE9] px-3 py-2.5">
                <p className="text-[11px] text-[#6B7280]">{label}</p>
                <p className="font-mono text-base font-semibold text-[#1F1D1B]">{v}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-[#6B7280]">
            Leave / absent isn't shown: the attendance table only records days worked (leave lives in leave_records).
          </p>
        </CardContent>
      </Card>

      <DailyEfficiencyCard employee={employee} period={period} target={target} onPeriodChange={onPeriodChange} />
    </div>
  );
}

// Pool efficiency per day. With `workerId` set it drills into that one person:
// every day of the period on the x axis, their working vs production hours as
// bars (right axis) and their own efficiency as the line. `workerId` is
// EmployeesView's `emp` filter, so the filter bar, Reset, a picked row and the
// back button all move the same state.
export function DailyEfficiencyCard({ employee, period, target, onPeriodChange, workerId, onBack }: Common & {
  workerId?: string; onBack?: () => void;
}) {
  const worker = workerId ? employee.workers.find((w) => w.id === workerId) : undefined;
  const daily = useMemo(() => {
    const r1 = (v: number) => Math.round(v * 10) / 10;
    if (workerId) {
      return workerDays(employee.performance.byDay, workerId, period).map((d) => ({
        iso: d.date, date: d.date.slice(5),
        Efficiency: d.eff == null ? null : r1(d.eff),
        "Working hours": r1(d.workingMinutes / 60),
        "Production hours": r1(d.productionMinutes / 60),
      }));
    }
    return employee.performance.byDay
      .filter((d) => inPeriod(period, d.date) && d.workingMinutes > 0)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((d) => ({ iso: d.date, date: d.date.slice(5), Efficiency: r1((d.productionMinutes / d.workingMinutes) * 100) as number | null }));
  }, [employee.performance.byDay, period, workerId]);
  const measured = daily.filter((d) => d.Efficiency != null);
  const below = measured.filter((d) => d.Efficiency! < target).length;
  const month = periodLabel({ ...period, day: undefined });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{workerId ? `Daily efficiency · ${worker?.name ?? "Employee"}` : "Daily efficiency"}</CardTitle>
          {workerId && onBack && (
            <button
              type="button"
              onClick={onBack}
              className="ml-auto text-xs rounded-md border border-[#E5E0D8] bg-[#F7F5F3] px-2 py-0.5 font-medium text-[#6B5C32] hover:bg-white max-md:min-h-10 max-md:px-3"
            >
              ← All employees
            </button>
          )}
        </div>
        <p className="text-xs text-[#6B7280]">
          {workerId
            ? `Working vs production hours and efficiency for each day of ${month} against the ${target}% target · ${below} of ${measured.length} days worked below · click a day to focus it`
            : `Pool (production ÷ working) per day against the ${target}% target · ${below} of ${daily.length} days below · click a point to focus that day`}
        </p>
      </CardHeader>
      <CardContent>
        <div className="select-none [&_*]:outline-none [&_.recharts-wrapper]:outline-none" style={{ width: "100%", height: 260 }}>
          {measured.length === 0 ? (
            <div className="flex items-center justify-center h-full text-xs text-[#6B7280]">
              {workerId ? `No clocked hours for ${worker?.name ?? "this employee"} in ${month}.` : "No clocked hours in range."}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={daily}
                margin={{ top: 6, right: 8, bottom: 0, left: 0 }}
                style={{ cursor: "pointer" }}
                onClick={(e) => {
                  const hit = daily.find((d) => d.date === e?.activeLabel);
                  if (hit) onPeriodChange({ ...period, day: period.day === hit.iso ? undefined : hit.iso });
                }}
              >
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: MUTED }} axisLine={{ stroke: BORDER }} tickLine={false} />
                <YAxis yAxisId="pct" tick={{ fontSize: 10, fill: MUTED }} axisLine={false} tickLine={false} width={38} unit="%" domain={[0, "auto"]} />
                {workerId && <YAxis yAxisId="h" orientation="right" tick={{ fontSize: 10, fill: MUTED }} axisLine={false} tickLine={false} width={32} unit="h" />}
                <Tooltip cursor={{ stroke: BORDER }} contentStyle={TOOLTIP} formatter={(v, name) => (v == null ? "—" : name === "Efficiency" ? `${v}%` : `${v}h`)} />
                {workerId && <Legend wrapperStyle={{ fontSize: 11 }} />}
                {period.day && <ReferenceLine yAxisId="pct" x={period.day.slice(5)} stroke={TAUPE} strokeDasharray="3 3" />}
                <ReferenceLine yAxisId="pct" y={target} stroke={MUTED} strokeDasharray="4 3" label={{ value: `${target}% target`, fontSize: 10, fill: MUTED, position: "insideTopRight" }} />
                {/* activeBar off + pointer-events none: see SalesOrdersView, the
                    hovered bar would cover the line and swallow the day click. */}
                {workerId && <Bar yAxisId="h" dataKey="Working hours" fill={TAUPE} fillOpacity={0.35} radius={[3, 3, 0, 0]} maxBarSize={14} activeBar={false} isAnimationActive={false} style={{ pointerEvents: "none" }} />}
                {workerId && <Bar yAxisId="h" dataKey="Production hours" fill={TAUPE} radius={[3, 3, 0, 0]} maxBarSize={14} activeBar={false} isAnimationActive={false} style={{ pointerEvents: "none" }} />}
                <Line yAxisId="pct" type="monotone" dataKey="Efficiency" stroke={TEAL} strokeWidth={1.75} dot={{ r: 2.5 }} activeDot={{ r: 5.5, fill: "#FFFFFF", stroke: TEAL, strokeWidth: 2 }} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

type RankRow = { key: string; name: string; sub: string; avg: number };

// A row that opens that person's day-by-day chart: clickable, and reachable +
// operable from the keyboard (Tab, then Enter or Space).
const PICK_CLS = "cursor-pointer hover:bg-[#F7F5F3] focus-visible:bg-[#F7F5F3] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#6B5C32]";
function pickable(onPick: ((key: string) => void) | undefined, key: string, name: string) {
  if (!onPick) return {};
  return {
    role: "button",
    tabIndex: 0,
    "aria-label": `Show ${name} day by day`,
    onClick: () => onPick(key),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      onPick(key);
    },
  };
}

function RankCard({ title, hint, rows, total, fromTop, color, onPick }: {
  title: string; hint: string; rows: RankRow[]; total: number; fromTop: boolean; color: string;
  onPick?: (key: string) => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>{title}</CardTitle>
        <p className="text-xs text-[#6B7280]">{hint}</p>
      </CardHeader>
      <CardContent className="space-y-3.5">
        {rows.map((r, i) => (
          <div
            key={r.key}
            className={`flex items-center gap-3 ${onPick ? `rounded-md ${PICK_CLS}` : ""}`}
            {...pickable(onPick, r.key, r.name)}
          >
            <span className="w-5 font-mono text-xs text-[#6B7280]">{fromTop ? i + 1 : total - i}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-[#1F1D1B]">{r.name}</p>
              <p className="truncate text-[11px] uppercase text-[#6B7280]">{r.sub}</p>
            </div>
            <div className="h-1.5 w-24 sm:w-32 rounded-full bg-[#E2DDD8] overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${Math.min(100, r.avg)}%`, background: color }} />
            </div>
            <span className="w-14 text-right font-mono text-sm font-semibold" style={{ color }}>{pct1(r.avg)}</span>
          </div>
        ))}
        {rows.length === 0 && <p className="py-4 text-center text-xs text-[#6B7280]">Nobody clocked enough hours in range.</p>}
      </CardContent>
    </Card>
  );
}

// The HOUSE metric per person, shared by the ranking (Efficiency) and the
// warning audit (Time & attendance) so both read the same numbers.
function useRankedPeople(employee: EmployeeSlice, period: Period) {
  // The HOUSE metric, per person: earned production minutes ÷ clocked working
  // minutes (performance.byDay[].workers) — the same numbers the Employees
  // KPI and the pool line use, so the ranking reconciles with them. NOT
  // attendance_records.efficiency_pct, a looser number the route's own header
  // says reads ~94% where the office reads ~84%. Headcount workers only.
  return useMemo(() => {
    const byId = new Map(employee.workers.map((w) => [w.id, w]));
    const m = new Map<string, { w: number; p: number; days: { date: string; w: number; p: number }[] }>();
    for (const d of employee.performance.byDay) {
      if (!inFocus(period, d.date)) continue;
      for (const x of d.workers ?? []) {
        const cur = m.get(x.workerId) ?? { w: 0, p: 0, days: [] };
        cur.w += x.workingMinutes;
        cur.p += x.productionMinutes;
        cur.days.push({ date: d.date, w: x.workingMinutes, p: x.productionMinutes });
        m.set(x.workerId, cur);
      }
    }
    return [...m.entries()]
      .flatMap(([id, v]) => {
        const w = byId.get(id);
        if (!w || !w.countsToHeadcount || v.w < MIN_RANK_MINUTES) return [];
        return [{ key: id, name: w.name ?? "—", sub: [w.role, w.dept].filter(Boolean).join(" · "), avg: (v.p / v.w) * 100, days: v.days }];
      })
      .sort((a, b) => b.avg - a.avg);
  }, [employee.performance.byDay, employee.workers, period]);
}

export function EfficiencyPanels({ employee, period, target, onPeriodChange, onPickEmployee }: Common) {
  const people = useRankedPeople(employee, period);

  const top = people.slice(0, 5);
  const bottom = people.slice(-5).reverse();

  return (
    <div className="space-y-4 max-md:space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-base font-semibold text-[#1F1D1B]">Efficiency ranking</h3>
        <span className="rounded-full bg-[#F0ECE9] px-2 py-0.5 text-[11px] text-[#6B7280]">{people.length} ranked · {period.day ? dayLabel(period.day) : periodLabel(period)}</span>
        <DayChip period={period} onPeriodChange={onPeriodChange} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <RankCard title="Top 5 performers" hint="Highest efficiency in the period · click a row to see that person day by day" rows={top} total={people.length} fromTop color={GREEN} onPick={onPickEmployee} />
        <RankCard title="Bottom 5 · needs attention" hint="Lowest efficiency (production ÷ working) in the period" rows={bottom} total={people.length} fromTop={false} color={AMBER} onPick={onPickEmployee} />
      </div>

      <WarningAuditPanel employee={employee} period={period} target={target} onPickEmployee={onPickEmployee} />
    </div>
  );
}

// Efficiency: people whose period average sits outside the audit band (a
// click drills the Daily efficiency chart). Time & attendance lists the same
// band per day instead: DailyWarningAudit below.
function WarningAuditPanel({ employee, period, target, onPickEmployee }: Omit<Common, "onPeriodChange">) {
  const people = useRankedPeople(employee, period);
  const flagged = useMemo(
    () => people
      .filter((p) => p.avg < WARN_LOW || p.avg > WARN_HIGH)
      .map((p) => ({ ...p, dates: warnDays(p.days, p.avg > WARN_HIGH, WARN_LOW, WARN_HIGH) }))
      .sort((a, b) => a.avg - b.avg),
    [people],
  );

  return (
    <div className="space-y-4 max-md:space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-base font-semibold text-[#1F1D1B]">Time audit warning tiers</h3>
        <span className="rounded-full bg-[#F0ECE9] px-2 py-0.5 text-[11px] text-[#6B7280]">{flagged.length} flagged · {periodLabel(period)}</span>
      </div>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Employee efficiency warning audit</CardTitle>
          <p className="text-xs text-[#6B7280]">
            Efficiency vs the {target}% baseline · flags under {WARN_LOW}% (under-performance) and over {WARN_HIGH}% (over-reporting) · Dates are the days that person's own ratio was outside the band (hover for the full list) · click a row to see that person day by day
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-t border-b border-[#E2DDD8]">
                  {["Employee", "Role / Dept", "Actual", "Target", "Efficiency", "Dates", "Status"].map((h, i) => (
                    <th key={h} className={`px-4 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280] ${i === 2 || i === 3 ? "text-right" : "text-left"}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {flagged.map((p) => {
                  const over = p.avg > WARN_HIGH;
                  return (
                    <tr
                      key={p.key}
                      className={`border-b border-[#E2DDD8] ${onPickEmployee ? PICK_CLS : ""}`}
                      {...pickable(onPickEmployee, p.key, p.name)}
                    >
                      <td className="px-4 py-2.5 font-medium text-[#1F1D1B]">{p.name}</td>
                      <td className="px-4 py-2.5 text-[#6B7280]">{p.sub || "—"}</td>
                      <td className="px-4 py-2.5 text-right font-mono">{pct1(p.avg)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-[#6B7280]">{target}%</td>
                      <td className="px-4 py-2.5">
                        <div className="h-1.5 w-24 rounded-full bg-[#E2DDD8] overflow-hidden">
                          <div className="h-full rounded-full bg-[#8A5A14]" style={{ width: `${Math.min(100, (p.avg / target) * 100)}%` }} />
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-[#6B7280] whitespace-nowrap" title={p.dates.map(dayLabel).join(", ")}>
                        {dayList(p.dates)}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold" style={over ? { background: "#FBE7E3", color: "#9A3A2D" } : { background: "#FAEFCB", color: "#9C6F1E" }}>
                          {over ? `Over ${WARN_HIGH}%` : "Needs Attention"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {flagged.length === 0 && (
                  <tr><td colSpan={7}className="px-4 py-6 text-center text-[#6B7280]">Nobody is outside the {WARN_LOW}–{WARN_HIGH}% band.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// Time & attendance: the same band, but per person PER DAY. A person whose
// month averages inside the band can still have one wild day (e.g. 0.4h
// clocked, 2.3h earned = 583%); the per-person audit hides that, this lists it.
// Any clocked production time counts here (no MIN_RANK_MINUTES): the tiny
// denominators are exactly the days worth checking. Over-reporting is split
// into steps (auditTier), the menu filters by step, 10 rows a page.
const TIER_STYLE: Record<AuditTier, { background: string; color: string }> = {
  1000: { background: "#9A3A2D", color: "#FFFFFF" },
  500: { background: "#E9A89A", color: "#6E2418" },
  300: { background: "#F6CFC6", color: "#9A3A2D" },
  150: { background: "#FBE7E3", color: "#B3452F" },
  low: { background: "#FAEFCB", color: "#9C6F1E" },
};
const tierLabel = (t: AuditTier) => (t === "low" ? "Needs Attention" : `Over ${t}%`);
type AuditFilter = "all" | AuditTier;
const PAGE_SIZE = 10;

export function DailyWarningAudit({ employee, period, target, onPickEmployee, selectedId }: Omit<Common, "onPeriodChange"> & { selectedId?: string }) {
  const rows = useMemo(() => {
    const byId = new Map(employee.workers.map((w) => [w.id, w]));
    const out: { key: string; workerId: string; name: string; sub: string; date: string; w: number; p: number; eff: number; tier: AuditTier }[] = [];
    for (const d of employee.performance.byDay) {
      if (!inFocus(period, d.date)) continue;
      for (const x of d.workers ?? []) {
        const wk = byId.get(x.workerId);
        if (!wk?.countsToHeadcount || x.workingMinutes <= 0) continue;
        const eff = (x.productionMinutes / x.workingMinutes) * 100;
        const tier = auditTier(eff, WARN_LOW);
        if (!tier) continue;
        out.push({
          key: `${x.workerId}|${d.date}`, workerId: x.workerId, name: wk.name ?? "—",
          sub: [wk.role, wk.dept].filter(Boolean).join(" · "), date: d.date,
          w: x.workingMinutes, p: x.productionMinutes, eff, tier,
        });
      }
    }
    // Highest first: the over-reporting days lead, the weakest days close the list.
    return out.sort((a, b) => b.eff - a.eff);
  }, [employee, period]);

  // "Over N%" filters are cumulative (Over 300% includes the 500% and 1000%
  // days), matching the label; Needs Attention is the under-floor days.
  const [filter, setFilter] = useState<AuditFilter>("all");
  const [menuOpen, setMenuOpen] = useState(false);
  const [page, setPage] = useState(1);
  const matches = (f: AuditFilter, r: (typeof rows)[number]) =>
    f === "all" ? true : f === "low" ? r.tier === "low" : r.eff > f;
  const options: AuditFilter[] = ["all", ...OVER_TIERS, "low"];
  const shown = rows.filter((r) => matches(filter, r));
  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const cur = Math.min(page, pageCount); // a shorter list after a period change clamps, no effect needed
  const pageRows = shown.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE);
  const pick = (f: AuditFilter) => { setFilter(f); setPage(1); setMenuOpen(false); };
  const optLabel = (f: AuditFilter) => (f === "all" ? "All flagged days" : tierLabel(f));
  const pagerBtn = "h-8 max-md:h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-xs font-medium text-[#1F1D1B] hover:bg-[#F7F5F3] disabled:opacity-40 disabled:hover:bg-white";

  return (
    <div className="space-y-4 max-md:space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-base font-semibold text-[#1F1D1B]">Time audit warning tiers</h3>
        <span className="rounded-full bg-[#F0ECE9] px-2 py-0.5 text-[11px] text-[#6B7280]">{rows.length} flagged days · {rows.filter((r) => r.tier !== "low").length} over {WARN_HIGH}% · {periodLabel(period)}</span>
      </div>
      <Card>
        <CardHeader className="pb-3 flex-row flex-wrap items-start justify-between gap-2 space-y-0">
          <div className="min-w-0 flex-1 space-y-1.5">
            <CardTitle>Employee efficiency warning audit</CardTitle>
            <p className="text-xs text-[#6B7280]">
              Each person's efficiency ON EACH DAY vs the {target}% baseline · flags days under {WARN_LOW}% (under-performance) and over {WARN_HIGH}% (over-reporting, stepped at 300 / 500 / 1000%), highest first · click a row to open that person's attendance log above, click it again to go back
            </p>
          </div>
          {/* Status filter menu. The transparent backdrop closes it on any outside click. */}
          <div className="relative">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
              className="flex h-8 max-md:h-10 items-center gap-1.5 rounded-md border border-[#E2DDD8] bg-white px-3 text-xs font-medium text-[#1F1D1B] hover:bg-[#F7F5F3]"
            >
              <Filter className="h-3.5 w-3.5 text-[#6B7280]" />
              {optLabel(filter)}
              <ChevronDown className="h-3.5 w-3.5 text-[#6B7280]" />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div role="menu" className="absolute right-0 z-20 mt-1 w-52 rounded-md border border-[#E2DDD8] bg-white py-1 shadow-md">
                  {options.map((f) => (
                    <button
                      key={f}
                      type="button"
                      role="menuitemradio"
                      aria-checked={filter === f}
                      onClick={() => pick(f)}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 max-md:py-2.5 text-left text-xs hover:bg-[#F7F5F3] ${filter === f ? "font-semibold text-[#1F1D1B]" : "text-[#4B4540]"}`}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className="h-2 w-2 rounded-full"
                          style={f === "all" ? { background: MUTED } : { background: TIER_STYLE[f].background, boxShadow: `inset 0 0 0 1px ${TIER_STYLE[f].color}` }}
                        />
                        {optLabel(f)}
                      </span>
                      <span className="font-mono text-[#6B7280]">{rows.filter((r) => matches(f, r)).length}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-t border-b border-[#E2DDD8]">
                  {["Employee", "Role / Dept", "Date", "Production time", "Prod hours", "Efficiency", "Status"].map((h, i) => (
                    <th key={h} className={`px-4 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280] ${i >= 3 && i <= 5 ? "text-right" : "text-left"}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => (
                  <tr
                    key={r.key}
                    className={`border-b border-[#E2DDD8] ${onPickEmployee ? PICK_CLS : ""} ${r.workerId === selectedId ? "bg-[#F0ECE9]" : ""}`}
                    aria-pressed={onPickEmployee ? r.workerId === selectedId : undefined}
                    {...pickable(onPickEmployee, r.workerId, r.name)}
                  >
                    <td className="px-4 py-2.5 font-medium text-[#1F1D1B]">{r.name}</td>
                    <td className="px-4 py-2.5 text-[#6B7280]">{r.sub || "—"}</td>
                    <td className="px-4 py-2.5 text-[#6B7280] whitespace-nowrap">{dayLabel(r.date)}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{hrs(r.w)}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{hrs(r.p)}</td>
                    <td className="px-4 py-2.5 text-right font-mono font-semibold" style={{ color: r.tier === "low" ? "#9C6F1E" : "#9A3A2D" }}>{pct1(r.eff)}</td>
                    <td className="px-4 py-2.5">
                      <span className="inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold" style={TIER_STYLE[r.tier]}>
                        {tierLabel(r.tier)}
                      </span>
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-6 text-center text-[#6B7280]">
                    {rows.length === 0 ? `No day is outside the ${WARN_LOW}–${WARN_HIGH}% band.` : `No days match "${optLabel(filter)}".`}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          {shown.length > PAGE_SIZE && (
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs text-[#6B7280]">
              <span className="tabular-nums">
                {(cur - 1) * PAGE_SIZE + 1}–{Math.min(cur * PAGE_SIZE, shown.length)} of {shown.length}
              </span>
              <div className="flex items-center gap-2">
                <button type="button" className={pagerBtn} disabled={cur <= 1} onClick={() => setPage(cur - 1)} aria-label="Previous page">
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="tabular-nums">Page {cur} of {pageCount}</span>
                <button type="button" className={pagerBtn} disabled={cur >= pageCount} onClick={() => setPage(cur + 1)} aria-label="Next page">
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
