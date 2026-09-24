import { useMemo } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { fmtN, inFocus, periodLabel, type Period } from "./dashboard-shared-lib";
import type { EmployeeSlice } from "./EmployeesInsights";

// Department ledger card — rendered inside Employees > Efficiency (it used to
// be its own "departments" sub-tab). Takes the slice EmployeesView already
// holds, so it follows that tab's department / employee filter and shares its
// loading / error / live state. Headcount, hours and efficiency are real (workers +
// attendance_records via the shared cached feed). REVENUE and LABOR COST per
// department are NOT in the feed: revenue has no per-department source (the
// design mock's figures were a seeded attribution, flagged SAMPLE), and labor
// cost would need a payroll aggregate added to the route. Not drawn until a
// real source exists — the note under the table says so.
const h = (min: number) => `${(min / 60).toLocaleString("en-MY", { maximumFractionDigits: 1 })}h`;

export function DepartmentsView({ employee, period }: { employee: EmployeeSlice; period: Period }) {
  const { rows, total } = useMemo(() => {
    const m = new Map<string, { dept: string; headcount: number; working: number; prod: number; days: number }>();
    const get = (d: string | null) => {
      const k = d || "(no dept)";
      let e = m.get(k);
      if (!e) m.set(k, (e = { dept: k, headcount: 0, working: 0, prod: 0, days: 0 }));
      return e;
    };
    for (const w of employee?.workers ?? []) if (w.countsToHeadcount) get(w.dept).headcount++;
    // Hours + efficiency are the HOUSE metric (performance.byDay[].workers,
    // joined to the worker's department) so they reconcile with the Employees
    // tab; attendance_records only supplies days worked.
    const deptOf = new Map((employee?.workers ?? []).map((w) => [w.id, w.dept]));
    for (const d of employee?.performance.byDay ?? []) {
      if (!inFocus(period, d.date)) continue;
      for (const x of d.workers ?? []) {
        const e = get(deptOf.get(x.workerId) ?? null);
        e.working += x.workingMinutes;
        e.prod += x.productionMinutes;
      }
    }
    for (const r of employee?.attendance ?? []) {
      if (inFocus(period, r.date)) get(r.dept).days += 1;
    }
    const rows = [...m.values()].sort((a, b) => b.headcount - a.headcount || a.dept.localeCompare(b.dept));
    const total = rows.reduce(
      (a, r) => ({ headcount: a.headcount + r.headcount, working: a.working + r.working, prod: a.prod + r.prod, days: a.days + r.days }),
      { headcount: 0, working: 0, prod: 0, days: 0 },
    );
    return { rows, total };
  }, [employee, period]);

  const eff = (w: number, p: number) => (w > 0 ? `${((p / w) * 100).toFixed(1)}%` : "—");
  const th = (label: string, right: boolean) => (
    <th key={label} className={`px-4 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280] whitespace-nowrap ${right ? "text-right" : "text-left"}`}>{label}</th>
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Department ledger</CardTitle>
        <p className="text-xs text-[#6B7280]">
          {rows.length} departments · {periodLabel(period)} · headcount is current; hours and efficiency follow the period picker
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-t border-b border-[#E2DDD8]">
                {th("Department", false)}{th("Headcount", true)}{th("Working hours", true)}
                {th("Prod hours", true)}{th("Efficiency", true)}{th("Days worked", true)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.dept} className="border-b border-[#E2DDD8]">
                  <td className="px-4 py-2.5 font-medium text-[#1F1D1B]">{r.dept}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{fmtN(r.headcount)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{h(r.working)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{h(r.prod)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{eff(r.working, r.prod)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{fmtN(r.days)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-[#6B7280]">No departments.</td></tr>
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-[#E2DDD8] font-semibold">
                  <td className="px-4 py-2.5">Factory total</td>
                  <td className="px-4 py-2.5 text-right font-mono">{fmtN(total.headcount)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{h(total.working)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{h(total.prod)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{eff(total.working, total.prod)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{fmtN(total.days)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <p className="px-4 py-3 text-[11px] text-[#6B7280]">
          Revenue, labor cost and labor ÷ revenue per department aren't shown yet: there is no per-department
          revenue source, and labor cost needs a payroll aggregate added to the feed. They'll be added once real
          figures exist rather than drawn from seeded numbers.
        </p>
      </CardContent>
    </Card>
  );
}
