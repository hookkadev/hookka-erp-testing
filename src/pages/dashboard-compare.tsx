// ============================================================
// /dashboard/compare: Plant Load on a 7-day vs a 14-day capacity window,
// side by side, to judge the 2026-10-08 switch to 14 days.
//
// STAGING ONLY: lives on the `staging` branch, never PR this into main.
// Both panels read /api/dashboard/overview (All-time); the 7-day one adds
// capacityWindow=7, which the route answers without touching any stored copy.
// Both charts of a kind share one scale so the bars can be compared by eye.
// ============================================================
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { useCachedJson } from "@/lib/cached-fetch";

type DeptRow = { dept: string; totalMin: number; dailyCapMin: number; backlogDays: number | null };
type Overview = {
  production?: {
    dailyCapacityMin: number;
    backlogDays: number;
    backlogGrandMin: number;
    capacityDays: { date: string; minutes: number; workers?: number }[];
    backlogByDept: DeptRow[];
  };
};

const h = (min: number | null | undefined) => `${Math.round((min ?? 0) / 60).toLocaleString()}h`;
const INK = "#6B5C32";
const GOLD = "#C5A85C";

function Panel({
  label,
  prod,
  loading,
  dayMax,
  deptMax,
}: {
  label: string;
  prod: Overview["production"] | undefined;
  loading: boolean;
  dayMax: number;
  deptMax: number;
}) {
  if (!prod) {
    return (
      <Card className="min-w-0">
        <CardContent className="p-5 text-sm text-[#6B7280]">{loading ? "Loading…" : "Could not load the dashboard data."}</CardContent>
      </Card>
    );
  }
  const days = [...prod.capacityDays]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ day: d.date.slice(5), hours: Math.round(d.minutes / 60) }));
  const depts = prod.backlogByDept.map((d) => ({ dept: d.dept, days: d.backlogDays ?? 0, stalled: d.backlogDays == null }));
  return (
    <Card className="min-w-0">
      <CardContent className="p-4 sm:p-5 space-y-5">
        <h2 className="text-base font-bold text-[#1F1D1B]">{label}</h2>
        <div className="grid grid-cols-3 gap-2 sm:gap-3 text-center">
          {[
            ["Daily capacity", h(prod.dailyCapacityMin)],
            ["Queue", `${prod.backlogDays.toLocaleString()}d`],
            ["Backlog", h(prod.backlogGrandMin)],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg bg-[#F7F4EF] px-2 py-2 min-w-0">
              <p className="text-[10px] uppercase tracking-wider text-[#9CA3AF] truncate">{k}</p>
              <p className="text-base sm:text-lg font-bold tabular-nums text-[#1F1D1B]">{v}</p>
            </div>
          ))}
        </div>
        <div>
          <p className="text-xs font-semibold text-[#5A5550] mb-1">Production hours per working day</p>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={days} margin={{ top: 16, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E5E0D8" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#A39E93" }} interval="preserveStartEnd" />
                <YAxis domain={[0, dayMax]} tick={{ fontSize: 10, fill: "#A39E93" }} />
                <Tooltip formatter={(v) => [`${v}h`, "Production"]} />
                <ReferenceLine
                  y={Math.round(prod.dailyCapacityMin / 60)}
                  stroke={GOLD}
                  strokeDasharray="4 3"
                  label={{ value: `avg ${h(prod.dailyCapacityMin)}`, position: "insideTopRight", fontSize: 10, fill: INK }}
                />
                <Bar dataKey="hours" fill={INK} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div>
          <p className="text-xs font-semibold text-[#5A5550] mb-1">Queue days by department</p>
          <div style={{ height: Math.max(160, depts.length * 26) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={depts} layout="vertical" margin={{ top: 0, right: 16, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E5E0D8" horizontal={false} />
                <XAxis type="number" domain={[0, deptMax]} tick={{ fontSize: 10, fill: "#A39E93" }} />
                <YAxis type="category" dataKey="dept" width={96} tick={{ fontSize: 10, fill: "#5A5550" }} />
                <Tooltip formatter={(v, _n, item) => [item.payload.stalled ? "stalled (no output)" : `${v}d`, "Queue"]} />
                <Bar dataKey="days" fill={GOLD} radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function DashboardCompare() {
  const r7 = useCachedJson<Overview>("/api/dashboard/overview?period=all&capacityWindow=7", 60);
  const r14 = useCachedJson<Overview>("/api/dashboard/overview?period=all", 60);
  const p7 = r7.data?.production;
  const p14 = r14.data?.production;

  const allDays = [...(p7?.capacityDays ?? []), ...(p14?.capacityDays ?? [])].map((d) => d.minutes / 60);
  const dayMax = Math.ceil(Math.max(50, ...allDays) / 50) * 50;
  const allDept = [...(p7?.backlogByDept ?? []), ...(p14?.backlogByDept ?? [])].map((d) => d.backlogDays ?? 0);
  const deptMax = Math.ceil(Math.max(5, ...allDept) / 5) * 5;

  const by14 = new Map((p14?.backlogByDept ?? []).map((d) => [d.dept, d]));
  const rows = (p7?.backlogByDept ?? [])
    .map((d7) => ({ d7, d14: by14.get(d7.dept) }))
    .sort((a, b) => (b.d14?.backlogDays ?? Infinity) - (a.d14?.backlogDays ?? Infinity));
  const fmtDays = (d: number | null | undefined) => (d == null ? "stalled" : `${d.toFixed(1)}d`);
  const diff = (a: number | null | undefined, b: number | null | undefined) =>
    a == null || b == null ? "—" : `${b - a >= 0 ? "+" : "−"}${Math.abs(b - a).toFixed(1)}d`;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Dashboard Compare"
        subtitle="Plant Load with capacity averaged over the last 7 vs the last 14 working days (All-time view). Staging only."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel label="Last 7 working days" prod={p7} loading={r7.loading} dayMax={dayMax} deptMax={deptMax} />
        <Panel label="Last 14 working days (live)" prod={p14} loading={r14.loading} dayMax={dayMax} deptMax={deptMax} />
      </div>
      {p7 && p14 && (
        <Card>
          <CardContent className="p-4 sm:p-5">
            <h2 className="text-base font-bold text-[#1F1D1B] mb-3">Difference</h2>
            <p className="text-sm text-[#5A5550] mb-3">
              Plant: daily capacity {h(p7.dailyCapacityMin)} → {h(p14.dailyCapacityMin)}, queue{" "}
              {fmtDays(p7.backlogDays)} → {fmtDays(p14.backlogDays)} ({diff(p7.backlogDays, p14.backlogDays)}). The backlog is
              the same in both; only the daily capacity it is divided by changes.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm tabular-nums">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-[#9CA3AF]">
                    <th className="text-left py-2 pr-2">Department</th>
                    <th className="text-right py-2 px-2">Backlog</th>
                    <th className="text-right py-2 px-2">Per day, 7d</th>
                    <th className="text-right py-2 px-2">Per day, 14d</th>
                    <th className="text-right py-2 px-2">Queue, 7d</th>
                    <th className="text-right py-2 px-2">Queue, 14d</th>
                    <th className="text-right py-2 pl-2">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ d7, d14 }) => (
                    <tr key={d7.dept} className="border-t border-[#F0ECE6]">
                      <td className="py-2 pr-2 text-[#1F1D1B]">{d7.dept}</td>
                      <td className="text-right py-2 px-2">{h(d7.totalMin)}</td>
                      <td className="text-right py-2 px-2">{h(d7.dailyCapMin)}</td>
                      <td className="text-right py-2 px-2">{h(d14?.dailyCapMin)}</td>
                      <td className="text-right py-2 px-2">{fmtDays(d7.backlogDays)}</td>
                      <td className="text-right py-2 px-2">{fmtDays(d14?.backlogDays)}</td>
                      <td className="text-right py-2 pl-2 font-semibold">{diff(d7.backlogDays, d14?.backlogDays)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
