import { useMemo } from "react";
import { PieChart, Pie, Cell, LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer } from "recharts";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { TAUPE, TEAL, MUTED, BORDER, AMBER, GREEN, fmtN, inPeriod, periodLabel, type Period } from "./dashboard-shared-lib";

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
  performance: { byDay: { date: string; workingMinutes: number; productionMinutes: number }[] };
};

const hrs = (min: number) => `${(min / 60).toLocaleString("en-MY", { maximumFractionDigits: 1 })}h`;
const pct1 = (v: number) => `${v.toFixed(1)}%`;
const TOOLTIP = { background: "#FFFFFF", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12 };

// Audit bands around the 100% baseline. The feed carries no configured warning
// threshold, so these are display choices, not policy.
const WARN_LOW = 90;
const WARN_HIGH = 110;

export function TimeAttendancePanels({
  employee, period, target,
}: { employee: EmployeeSlice; period: Period; target: number }) {
  const att = useMemo(() => employee.attendance.filter((r) => inPeriod(period, r.date)), [employee.attendance, period]);
  const t = useMemo(() => {
    const working = att.reduce((a, r) => a + r.workingMinutes, 0);
    const prod = att.reduce((a, r) => a + r.productionMinutes, 0);
    const ot = att.reduce((a, r) => a + Math.min(r.overtimeMinutes, r.workingMinutes), 0);
    const nonProd = att.reduce((a, r) => a + Math.max(0, r.workingMinutes - r.productionMinutes), 0);
    return { working, prod, ot, regular: working - ot, nonProd, days: att.length, people: new Set(att.map((r) => r.employeeId ?? r.employeeName)).size };
  }, [att]);

  const daily = useMemo(
    () => employee.performance.byDay
      .filter((d) => inPeriod(period, d.date) && d.workingMinutes > 0)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((d) => ({ date: d.date.slice(5), Efficiency: Math.round((d.productionMinutes / d.workingMinutes) * 1000) / 10 })),
    [employee.performance.byDay, period],
  );
  const below = daily.filter((d) => d.Efficiency < target).length;

  const donut = [
    { name: "Regular", value: t.regular, color: TAUPE },
    { name: "Overtime", value: t.ot, color: AMBER },
  ];
  const tiles: [string, string][] = [
    ["Production time", hrs(t.working)],
    ["Prod hours", hrs(t.prod)],
    ["Non-prod hours", hrs(t.nonProd)],
    ["Total days worked", fmtN(t.days)],
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Time &amp; attendance</CardTitle>
          <p className="text-xs text-[#6B7280]">
            {hrs(t.working)} clocked across {periodLabel(period)} · {t.people} employees combined
          </p>
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
            Pool (production ÷ working) per day against the {target}% target · {below} of {daily.length} days below
          </p>
        </CardHeader>
        <CardContent>
          <div style={{ width: "100%", height: 260 }}>
            {daily.length === 0 ? (
              <div className="flex items-center justify-center h-full text-xs text-[#6B7280]">No clocked hours in range.</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={daily} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: MUTED }} axisLine={{ stroke: BORDER }} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: MUTED }} axisLine={false} tickLine={false} width={38} unit="%" domain={[0, "auto"]} />
                  <Tooltip contentStyle={TOOLTIP} formatter={(v) => `${v}%`} />
                  <ReferenceLine y={target} stroke={MUTED} strokeDasharray="4 3" label={{ value: `${target}% target`, fontSize: 10, fill: MUTED, position: "insideTopRight" }} />
                  <Line type="monotone" dataKey="Efficiency" stroke={TEAL} strokeWidth={1.75} dot={{ r: 2.5 }} />
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

function RankCard({ title, hint, rows, total, fromTop, color }: {
  title: string; hint: string; rows: RankRow[]; total: number; fromTop: boolean; color: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>{title}</CardTitle>
        <p className="text-xs text-[#6B7280]">{hint}</p>
      </CardHeader>
      <CardContent className="space-y-3.5">
        {rows.map((r, i) => (
          <div key={r.key} className="flex items-center gap-3">
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
        {rows.length === 0 && <p className="py-4 text-center text-xs text-[#6B7280]">No efficiency readings in range.</p>}
      </CardContent>
    </Card>
  );
}

export function EfficiencyPanels({
  employee, period, target,
}: { employee: EmployeeSlice; period: Period; target: number }) {
  // Average of the RECORDED efficiency readings per person (attendance_records
  // carries one on only ~half of rows) — a missing reading is skipped, not
  // counted as 0.
  const people = useMemo(() => {
    const byId = new Map(employee.workers.map((w) => [w.id, w]));
    const m = new Map<string, { name: string; dept: string | null; role: string | null; sum: number; n: number }>();
    for (const r of employee.attendance) {
      if (r.efficiencyPct == null || !inPeriod(period, r.date)) continue;
      const k = r.employeeId ?? r.employeeName ?? "";
      const w = r.employeeId ? byId.get(r.employeeId) : undefined;
      const cur = m.get(k) ?? { name: w?.name ?? r.employeeName ?? "—", dept: w?.dept ?? r.dept, role: w?.role ?? null, sum: 0, n: 0 };
      cur.sum += r.efficiencyPct;
      cur.n += 1;
      m.set(k, cur);
    }
    return [...m.entries()]
      .map(([key, v]) => ({ key, name: v.name, sub: [v.role, v.dept].filter(Boolean).join(" · "), avg: v.sum / v.n }))
      .sort((a, b) => b.avg - a.avg);
  }, [employee.attendance, employee.workers, period]);

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
        <span className="rounded-full bg-[#F0ECE9] px-2 py-0.5 text-[11px] text-[#6B7280]">{people.length} ranked · {periodLabel(period)}</span>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <RankCard title="Top 5 performers" hint="Highest average efficiency in the period" rows={top} total={people.length} fromTop color={GREEN} />
        <RankCard title="Bottom 5 · needs attention" hint="Lowest average efficiency in the period" rows={bottom} total={people.length} fromTop={false} color={AMBER} />
      </div>

      <div className="flex items-center gap-2">
        <h3 className="text-base font-semibold text-[#1F1D1B]">Time audit warning tiers</h3>
        <span className="rounded-full bg-[#F0ECE9] px-2 py-0.5 text-[11px] text-[#6B7280]">{flagged.length} flagged · {periodLabel(period)}</span>
      </div>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Employee efficiency warning audit</CardTitle>
          <p className="text-xs text-[#6B7280]">
            Period average vs the {target}% baseline · flags under {WARN_LOW}% (under-performance) and over {WARN_HIGH}% (over-reporting)
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
                    <tr key={p.key} className="border-b border-[#E2DDD8]">
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
