// ---------------------------------------------------------------------------
// Leadership allowance — a flat, per-worker monthly bonus (migration 0233,
// DEV-06). Pro-rated by attendance exactly like the Efficiency Allowance
// (efficiency-allowance.ts) but with NO threshold / performance gate — owner
// decision (2026-09): "不设门槛,只按出勤比例" (no threshold, attendance ratio
// only). A configured amount always pays out; it is scaled down only by days
// actually worked.
//
// Pure non-statutory bonus, same convention as the efficiency allowance:
// every caller adds it to gross pay AFTER calcStatutory, so it never moves
// EPF / SOCSO / EIS / PCB — extra money on top.
// ---------------------------------------------------------------------------

/**
 * How much leadership allowance (in sen) a worker earns for the month, given
 * their configured flat amount and (optionally) their attendance.
 *
 * Unlike resolveEfficiencyAllowanceSen there is no eligibility gate — a
 * configured amount > 0 always pays, pro-rated by worked/workingDays.
 *
 * No attendance passed ⇒ the full configured amount, so a live pre-payslip
 * estimate (attendance not final yet) shows the un-prorated figure — mirrors
 * resolveEfficiencyAllowanceSen's same fallback.
 */
export function resolveLeadershipAllowanceSen(
  allowanceSen: number | null | undefined,
  attendance?: { workingDays: number; absentDays: number },
): number {
  const allow = Math.round(Number(allowanceSen) || 0);
  if (allow <= 0) return 0;
  if (!attendance) return allow;
  const workingDays = Math.max(0, Math.round(Number(attendance.workingDays) || 0));
  const absentDays = Math.max(0, Math.round(Number(attendance.absentDays) || 0));
  if (workingDays <= 0) return allow;
  const worked = Math.max(0, workingDays - absentDays);
  return Math.round((allow * worked) / workingDays);
}
