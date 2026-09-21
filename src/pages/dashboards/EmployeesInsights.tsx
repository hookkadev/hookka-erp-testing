import { useMemo } from "react";
import { PieChart, Pie, Cell, LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer } from "recharts";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { TAUPE, TEAL, MUTED, BORDER, AMBER, GREEN, fmtN, inPeriod, inFocus, dayLabel, periodLabel, type Period } from "./dashboard-shared-lib";

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
const WARN_HIGH = 110;
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
      className="text-xs rounded-md border border-[#E5E0D8] bg-[#F7F5F3] px-2 py-0.5 text-[#6B5C32] hover:bg-white"
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

  const daily = useMemo(
    () => employee.performance.byDay
      .filter((d) => inPeriod(period, d.date) && d.workingMinutes > 0)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((d) => ({ iso: d.date, date: d.date.slice(5), Efficiency: Math.round((d.productionMinutes / d.workingMinutes) * 1000) / 10 })),
    [employee.performance.byDay, period],
  );
  const below = daily.filter((d) => d.Efficiency < target).length;

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
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
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

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Daily efficiency</CardTitle>
          <p className="text-xs text-[#6B7280]">
            Pool (production ÷ working) per day against the {target}% target · {below} of {daily.length} days below · click a point to focus that day
          </p>
        </CardHeader>
        <CardContent>
          <div className="select-none [&_*]:outline-none [&_.recharts-wrapper]:outline-none" style={{ width: "100%", height: 260 }}>
            {daily.length === 0 ? (
              <div className="flex items-center justify-center h-full text-xs text-[#6B7280]">No clocked hours in range.</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={daily}
                  margin={{ top: 6, right: 8, bottom: 0, left: 0 }}
                  style={{ cursor: "pointer" }}
                  onClick={(e) => {
                    const hit = daily.find((d) => d.date === e?.activeLabel);
                    if (hit) onPeriodChange({ ...period, day: period.day === hit.iso ? undefined : hit.iso });
                  }}
                >
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: MUTED }} axisLine={{ stroke: BORDER }} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: MUTED }} axisLine={false} tickLine={false} width={38} unit="%" domain={[0, "auto"]} />
                  <Tooltip cursor={{ stroke: BORDER }} contentStyle={TOOLTIP} formatter={(v) => `${v}%`} />
                  {period.day && <ReferenceLine x={period.day.slice(5)} stroke={TAUPE} strokeDasharray="3 3" />}
                  <ReferenceLine y={target} stroke={MUTED} strokeDasharray="4 3" label={{ value: `${target}% target`, fontSize: 10, fill: MUTED, position: "insideTopRight" }} />
                  <Line type="monotone" dataKey="Efficiency" stroke={TEAL} strokeWidth={1.75} dot={{ r: 2.5 }} activeDot={{ r: 5.5, fill: "#FFFFFF", stroke: TEAL, strokeWidth: 2 }} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

type RankRow = { key: string; name: string; sub: string; avg: number };

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
            className={`flex items-center gap-3 ${onPick ? "cursor-pointer rounded-md hover:bg-[#F7F5F3]" : ""}`}
            onClick={() => onPick?.(r.key)}
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

export function EfficiencyPanels({ employee, period, target, onPeriodChange, onPickEmployee }: Common) {
  // The HOUSE metric, per person: earned production minutes ÷ clocked working
  // minutes (performance.byDay[].workers) — the same numbers the Employees
  // KPI and the pool line use, so the ranking reconciles with them. NOT
  // attendance_records.efficiency_pct, a looser number the route's own header
  // says reads ~94% where the office reads ~84%. Headcount workers only.
  const people = useMemo(() => {
    const byId = new Map(employee.workers.map((w) => [w.id, w]));
    const m = new Map<string, { w: number; p: number }>();
    for (const d of employee.performance.byDay) {
      if (!inFocus(period, d.date)) continue;
      for (const x of d.workers ?? []) {
        const cur = m.get(x.workerId) ?? { w: 0, p: 0 };
        cur.w += x.workingMinutes;
        cur.p += x.productionMinutes;
        m.set(x.workerId, cur);
      }
    }
    return [...m.entries()]
      .flatMap(([id, v]) => {
        const w = byId.get(id);
        if (!w || !w.countsToHeadcount || v.w < MIN_RANK_MINUTES) return [];
        return [{ key: id, name: w.name ?? "—", sub: [w.role, w.dept].filter(Boolean).join(" · "), avg: (v.p / v.w) * 100 }];
      })
      .sort((a, b) => b.avg - a.avg);
  }, [employee.performance.byDay, employee.workers, period]);

  const top = people.slice(0, 5);
  const bottom = people.slice(-5).reverse();
  const flagged = useMemo(
    () => people.filter((p) => p.avg < WARN_LOW || p.avg > WARN_HIGH).sort((a, b) => a.avg - b.avg),
    [people],
  );

  return (
    <div className="space-y-5 max-md:space-y-4">
      <div className="flex items-center gap-2">
        <h3 className="text-base font-semibold text-[#1F1D1B]">Efficiency ranking</h3>
        <span className="rounded-full bg-[#F0ECE9] px-2 py-0.5 text-[11px] text-[#6B7280]">{people.length} ranked · {period.day ? dayLabel(period.day) : periodLabel(period)}</span>
        <DayChip period={period} onPeriodChange={onPeriodChange} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <RankCard title="Top 5 performers" hint="Highest efficiency in the period · click a row to filter to that person" rows={top} total={people.length} fromTop color={GREEN} onPick={onPickEmployee} />
        <RankCard title="Bottom 5 · needs attention" hint="Lowest efficiency (production ÷ working) in the period" rows={bottom} total={people.length} fromTop={false} color={AMBER} onPick={onPickEmployee} />
      </div>

      <div className="flex items-center gap-2">
        <h3 className="text-base font-semibold text-[#1F1D1B]">Time audit warning tiers</h3>
        <span className="rounded-full bg-[#F0ECE9] px-2 py-0.5 text-[11px] text-[#6B7280]">{flagged.length} flagged · {periodLabel(period)}</span>
      </div>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Employee efficiency warning audit</CardTitle>
          <p className="text-xs text-[#6B7280]">
            Efficiency vs the {target}% baseline · flags under {WARN_LOW}% (under-performance) and over {WARN_HIGH}% (over-reporting)
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-t border-b border-[#E2DDD8]">
                  {["Employee", "Role / Dept", "Actual", "Target", "Efficiency", "Status"].map((h, i) => (
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
                      className={`border-b border-[#E2DDD8] ${onPickEmployee ? "cursor-pointer hover:bg-[#F7F5F3]" : ""}`}
                      onClick={() => onPickEmployee?.(p.key)}
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
                      <td className="px-4 py-2.5">
                        <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold" style={over ? { background: "#FBE7E3", color: "#9A3A2D" } : { background: "#FAEFCB", color: "#9C6F1E" }}>
                          {over ? "Over-reporting" : "Needs Attention"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {flagged.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-6 text-center text-[#6B7280]">Nobody is outside the {WARN_LOW}–{WARN_HIGH}% band.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
