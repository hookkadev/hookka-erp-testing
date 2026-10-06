// ---------------------------------------------------------------------------
// Which floor workers belong to a Production time efficiency scope (DEV-36).
//
// The KPI Library lists only the workers of the departments ticked for the
// assignment. A scope is a list of "FAB_CUT" / "FAB_CUT:SOFA" entries (the
// same strings kpi_assignments.scope stores); an empty list is Overall, which
// means every active worker of any production department.
//
// A worker is in a scope entry when the department is one of theirs
// (departmentCodes, falling back to the single departmentCode) and, for a
// typed entry, they cover that type. A worker with no types listed covers
// every type, as on the Team dashboard.
// ---------------------------------------------------------------------------

export type ScopeWorker = {
  departmentCode?: string | null;
  departmentCodes?: string[] | null;
  categories?: string[] | null;
  status?: string | null;
};

export function workerDepts(w: ScopeWorker): string[] {
  const list = (w.departmentCodes ?? []).filter(Boolean);
  return list.length ? list : w.departmentCode ? [w.departmentCode] : [];
}

export function workerInScope(
  w: ScopeWorker,
  scope: string[],
  productionDepts: Set<string>,
): boolean {
  if ((w.status ?? "ACTIVE") !== "ACTIVE") return false;
  const depts = workerDepts(w);
  if (!scope.length) return depts.some((d) => productionDepts.has(d));
  const cats = (w.categories ?? []).filter(Boolean);
  return scope.some((entry) => {
    const [dept, cat] = entry.split(":");
    return depts.includes(dept) && (!cat || !cats.length || cats.includes(cat));
  });
}
