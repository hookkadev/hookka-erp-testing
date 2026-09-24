import { useMemo, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { MUTED, inFocus, periodLabel, stepDay, ymd, type Period } from "./dashboard-shared-lib";
import type { EmployeeSlice } from "./EmployeesInsights";

// Attendance log: latest recorded day per employee inside the period (or the
// focused day), plus that person's day count.
//
// Clock in/out and the day count come from attendance_records. HOURS and
// EFFICIENCY do not: attendance_records.production_time_minutes is not what
// the office reads (the route's header says so, and it showed 0h for everyone),
// so they come from the house metric, performance.byDay[].workers, for that
// worker on that day:
//   Production time = clocked minutes in production depts
//   Prod hours      = earned standard minutes
//   Non-prod hours  = all-dept clocked − production-dept clocked
//   Efficiency      = Prod hours ÷ Production time
const hrs = (min: number) => `${Math.round(min / 6) / 10}h`;
const hhmm = (t: string | null) => t?.match(/\d{2}:\d{2}/)?.[0] ?? "—";
// Minutes after the 08:00 shift start; 0 when on time or unparseable.
const lateMin = (t: string | null) => {
  const m = t?.match(/(\d{2}):(\d{2})/);
  return m ? Math.max(0, Number(m[1]) * 60 + Number(m[2]) - 480) : 0;
};

// perDay is an explicit prop (set when the filter bar has ONE employee picked) rather than
// derived from "one distinct employee in the slice": a department that happens to have a
// single active worker should still read as the department view.
export function AttendanceLogCard({ employee, period: pagePeriod, perDay = false }: { employee: EmployeeSlice; period: Period; perDay?: boolean }) {
  // Today / Yesterday switch for THIS card only. "Today" is the browser's calendar day, the
  // same one resolvePeriod opens the page on. A pick remembers the page period it was made
  // against, so moving the page picker drops it (derived, no effect); pressing the lit chip
  // again also hands the card back to the page period.
  const today = ymd(new Date());
  const days = [["Today", today], ["Yesterday", stepDay(today, -1, today)!]] as const;
  const pageKey = JSON.stringify(pagePeriod);
  const [pick, setPick] = useState<{ day: string; pageKey: string } | null>(null);
  const override = pick?.pageKey === pageKey ? pick.day : undefined;
  const period = useMemo(() => (override ? { ...pagePeriod, day: override } : pagePeriod), [pagePeriod, override]);

  const log = useMemo(() => {
    const byId = new Set(employee.workers.map((w) => w.id));
    const byName = new Map(employee.workers.map((w) => [(w.name ?? "").trim().toLowerCase(), w.id]));
    const perf = new Map<string, { working: number; prod: number; all: number }>();
    for (const d of employee.performance.byDay) {
      for (const x of d.workers ?? []) {
        perf.set(`${d.date}|${x.workerId}`, { working: x.workingMinutes, prod: x.productionMinutes, all: x.allDeptMinutes ?? x.workingMinutes });
      }
    }

    const byEmp = new Map<string, { last: EmployeeSlice["attendance"][number]; workerId: string | null; days: number }>();
    for (const r of employee.attendance) {
      if (!r.date || !inFocus(period, r.date)) continue;
      const workerId = r.employeeId && byId.has(r.employeeId)
        ? r.employeeId
        : (byName.get((r.employeeName ?? "").trim().toLowerCase()) ?? null);
      const k = (workerId ?? r.employeeId ?? r.employeeName ?? "") + (perDay ? `|${r.date}` : "");
      const cur = byEmp.get(k);
      byEmp.set(k, { last: !cur || r.date >= (cur.last.date ?? "") ? r : cur.last, workerId, days: (cur?.days ?? 0) + 1 });
    }

    const rows = [...byEmp.entries()]
      .map(([key, { last, workerId, days }]) => {
        const p = workerId && last.date ? perf.get(`${last.date}|${workerId}`) : undefined;
        return {
          key, last, days,
          working: p?.working ?? null,
          prod: p?.prod ?? null,
          nonProd: p ? Math.max(0, p.all - p.working) : null,
          eff: p && p.working > 0 ? (p.prod / p.working) * 100 : null,
        };
      })
      .sort((a, b) => perDay
        ? (b.last.date ?? "").localeCompare(a.last.date ?? "")
        : (a.last.employeeName ?? "").localeCompare(b.last.employeeName ?? ""));

    const sum = (f: (r: (typeof rows)[number]) => number | null) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
    const working = sum((r) => r.working);
    const prod = sum((r) => r.prod);
    return { rows, working, prod, nonProd: sum((r) => r.nonProd), days: sum((r) => r.days), eff: working > 0 ? (prod / working) * 100 : null };
  }, [employee, period, perDay]);

  const H = ["Employee", "Date", "Clock in", "Clock out", "Production time", "Prod hours", "Non-prod hours", "Efficiency", ...(perDay ? [] : ["Total days"]), "Status"];
  const ncol = H.length;
  const who = log.rows[0]?.last.employeeName ?? "";
  const h = (v: number | null) => (v == null ? "—" : hrs(v));

  return (
    <Card>
      <CardHeader className="pb-3 flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <CardTitle>
          Attendance log{" "}
          <span className="ml-2 max-md:ml-0 max-md:block text-[11px] font-normal text-[#6B7280]">
            {perDay
              ? `${log.days} days · ${who} · ${periodLabel(period)}`
              : `${log.rows.length} employees · latest recorded day each · ${periodLabel(period)}`}
          </span>
        </CardTitle>
        {/* Same segmented look as the page's Day / Month / YTD toggle (PeriodPicker). */}
        <div role="group" aria-label="Attendance day" className="flex gap-0.5 rounded-lg border border-[#E2DDD8] bg-[#F7F5F3] p-0.5">
          {days.map(([label, d]) => {
            const on = period.day === d;
            return (
              <button
                key={label}
                type="button"
                aria-pressed={on}
                onClick={() => setPick(on ? null : { day: d, pageKey })}
                className={
                  "px-3 py-1 max-md:h-11 max-md:text-sm text-xs font-medium rounded-md border transition-colors " +
                  (on
                    ? "bg-white border-[#6B5C32] text-[#1F1D1B] shadow-sm"
                    : "bg-transparent border-transparent text-[#6B7280] hover:bg-white/60")
                }
              >
                {label}
              </button>
            );
          })}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto" style={{ maxHeight: 460, overflowY: "auto" }}>
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-t border-b border-[#E2DDD8] sticky top-0 bg-white">
                {H.map((t, i) => (
                  <th key={t} className={`px-3 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280] whitespace-nowrap ${i >= 4 && i <= 7 + (perDay ? 0 : 1) ? "text-right" : "text-left"}`}>{t}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {log.rows.map((r) => {
                const late = lateMin(r.last.clockIn);
                return (
                  <tr key={r.key} className="border-b border-[#E2DDD8]">
                    <td className="px-3 py-2 text-[#1F1D1B]">{r.last.employeeName ?? "—"}</td>
                    <td className="px-3 py-2 text-[#6B7280] whitespace-nowrap">
                      {r.last.date ? `${Number(r.last.date.slice(8))} ${new Date(r.last.date).toLocaleString("en", { month: "short" })}` : "—"}
                    </td>
                    <td className="px-3 py-2 font-mono">{hhmm(r.last.clockIn)}</td>
                    <td className="px-3 py-2 font-mono">{hhmm(r.last.clockOut)}</td>
                    <td className="px-3 py-2 text-right font-mono">{h(r.working)}</td>
                    <td className="px-3 py-2 text-right font-mono">{h(r.prod)}</td>
                    <td className={`px-3 py-2 text-right font-mono ${(r.nonProd ?? 0) > 90 ? "text-[#B5701A]" : "text-[#6B7280]"}`}>{h(r.nonProd)}</td>
                    <td className="px-3 py-2 text-right font-mono font-semibold" style={{ color: r.eff == null ? MUTED : r.eff >= 90 ? "#4F7C3A" : "#B5701A" }}>
                      {r.eff == null ? "—" : `${r.eff.toFixed(1)}%`}
                    </td>
                    {!perDay && <td className="px-3 py-2 text-right font-mono">{r.days}</td>}
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
              {log.rows.length === 0 && (
                <tr><td colSpan={ncol} className="px-4 py-6 text-center text-[#6B7280]">No attendance recorded in this period.</td></tr>
              )}
            </tbody>
            {log.rows.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-[#E2DDD8] font-mono font-semibold">
                  <td className="px-3 py-2" colSpan={4}>{perDay ? `Total (${log.days} days)` : "Listed rows"}</td>
                  <td className="px-3 py-2 text-right">{hrs(log.working)}</td>
                  <td className="px-3 py-2 text-right">{hrs(log.prod)}</td>
                  <td className="px-3 py-2 text-right">{hrs(log.nonProd)}</td>
                  <td className="px-3 py-2 text-right">{log.eff == null ? "—" : `${log.eff.toFixed(1)}%`}</td>
                  {!perDay && <td className="px-3 py-2 text-right">{log.days}</td>}
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <p className="px-3 py-2 text-[11px] text-[#6B7280]">
          "—" means no work-hour entry exists for that person on that day, so there is nothing to compute from.
        </p>
      </CardContent>
    </Card>
  );
}
