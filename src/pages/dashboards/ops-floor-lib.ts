// Operations > Overview department board + due-soon lanes. Pure (no React).
//
// The two feeds name departments differently: /api/dashboard/prototype
// (overdue, due-soon) keys by job-card departmentCode ("FAB_CUT"), while
// /api/dashboard/overview (backlog) keys by display name ("Fabric Cutting").
// This table mirrors DEPARTMENTS in src/api/routes/dashboard-overview.ts
// (~line 994) — same codes, same names, same floor order. A code not listed
// here is shown as-is, after the listed ones.
export const DEPT_FLOOR = [
  ["FAB_CUT", "Fabric Cutting"],
  ["FAB_SEW", "Fabric Sewing"],
  ["WOOD_CUT", "Wood Cutting"],
  ["FOAM", "Foam Bonding"],
  ["FRAMING", "Framing"],
  ["WEBBING", "Webbing"],
  ["UPHOLSTERY", "Upholstery"],
  ["PACKING", "Packing"],
] as const;

const NAME_BY_CODE = new Map<string, string>(DEPT_FLOOR);
const FLOOR_IDX = new Map<string, number>(DEPT_FLOOR.map(([, name], i) => [name, i]));

/** Display name for a department code (or a name / unknown code, as-is). */
export function deptName(codeOrName: string): string {
  return NAME_BY_CODE.get(codeOrName) ?? codeOrName;
}

/**
 * Severity of a department's queue, in days to clear. Same cut-offs as
 * plantLoad() in dashboard-widgets-lib.ts: red > 12d, amber > 7d. null =
 * stalled (no completions in the rolling window) → red.
 */
export function daysTone(days: number | null): "red" | "amber" | "green" {
  return days == null || days > 12 ? "red" : days > 7 ? "amber" : "green";
}

/**
 * One row per department, in floor order, joining the backlog rows
 * (deptBacklogRows(), keyed by name) with the live overdue and due-in-3-days
 * counts (keyed by code). A department present in only one feed still gets a
 * row; its missing side is undefined / 0 (overdue & due-soon feeds list only
 * departments that have orders, so an absent department really is 0).
 */
export function deptStatusRows<B extends { d: { dept: string } }>(
  backlog: B[],
  overdueByDept: { department: string; count: number }[],
  dueSoon: { currentDept: string | null }[],
) {
  const rows = new Map<string, { name: string; backlog?: B; overdue: number; dueSoon: number }>();
  const row = (name: string) => {
    let r = rows.get(name);
    if (!r) rows.set(name, (r = { name, overdue: 0, dueSoon: 0 }));
    return r;
  };
  for (const b of backlog) row(b.d.dept).backlog = b;
  for (const o of overdueByDept) row(deptName(o.department)).overdue += o.count;
  for (const o of dueSoon) row(deptName(o.currentDept || "(no dept)")).dueSoon += 1;
  const idx = (n: string) => FLOOR_IDX.get(n) ?? DEPT_FLOOR.length;
  return [...rows.values()].sort((a, b) => idx(a.name) - idx(b.name));
}
