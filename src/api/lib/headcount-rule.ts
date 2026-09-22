// Last verified: 2026-09-21 against src/api/routes/dashboard-prototype.ts (the
// `countsToHeadcount` flag it hands the Employees / Departments tabs).
//
// THE headcount rule, in one place: a worker counts when ACTIVE and not a TEST*
// account (owner 2026-07-11 — the same rule Payroll uses, so headcount tallies
// system-wide). The dashboard feed and the Finance tab both call this.
export function countsToHeadcount(status: string | null | undefined, empNo: string | null | undefined): boolean {
  return status === "ACTIVE" && !/^TEST/i.test(empNo ?? "");
}
