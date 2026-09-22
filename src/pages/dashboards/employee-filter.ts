import type { EmployeeSlice } from "./EmployeesInsights";

// Narrow the employee slice to one department and/or one person, so every
// panel downstream (tiles, pool line, ranking, log) recomputes for just them.
// The pool per-day totals are rebuilt from the kept workers — filtering only the
// worker list would leave the day totals still summing the whole factory.
export function filterSlice(e: EmployeeSlice, dept: string, empId: string): EmployeeSlice {
  if (!dept && !empId) return e;
  const workers = e.workers.filter((w) => (!dept || w.dept === dept) && (!empId || w.id === empId));
  const ids = new Set(workers.map((w) => w.id));
  const names = new Set(workers.map((w) => (w.name ?? "").trim().toLowerCase()));
  const attendance = e.attendance.filter(
    (r) => (r.employeeId != null && ids.has(r.employeeId)) || names.has((r.employeeName ?? "").trim().toLowerCase()),
  );
  const byDay = e.performance.byDay
    .map((d) => {
      const ws = (d.workers ?? []).filter((x) => ids.has(x.workerId));
      const sum = (f: (x: (typeof ws)[number]) => number) => ws.reduce((a, x) => a + f(x), 0);
      return {
        ...d,
        workers: ws,
        workingMinutes: sum((x) => x.workingMinutes),
        productionMinutes: sum((x) => x.productionMinutes),
        allDeptMinutes: sum((x) => x.allDeptMinutes ?? x.workingMinutes),
      };
    })
    .filter((d) => d.workers.length > 0);
  return { workers, attendance, performance: { byDay } };
}
