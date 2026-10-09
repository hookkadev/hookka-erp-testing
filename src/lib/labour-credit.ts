// ---------------------------------------------------------------------------
// The month-end labour posting's CREDIT side (owner 2026-10-09 「epf, socso 那些
// 也要 accrual」→「EIS 单独记 0040」).
//
// The debit side is the full company cost: gross pay to each department's
// account plus the employer's EPF / SOCSO / EIS. It used to be credited in one
// line to 410-0010 ACCRUAL - SALARY, so the KWSP and PERKESO payments had
// nothing of their own to clear. Now each fund's share — the employer's plus
// what the payslip took from the employee — accrues to its own liability, and
// the rest of the cost (net pay, PCB, advance and other deductions) stays on
// the salary accrual. The lines sum to the debit side by construction: total
// cost = gross + employer shares, and the salary line is what the funds don't
// take.
// ---------------------------------------------------------------------------

export type LabourCreditInput = {
  costSen: number;
  epfSen: number;
  socsoSen: number;
  eisSen: number;
  epfEmployeeSen: number;
  socsoEmployeeSen: number;
  eisEmployeeSen: number;
};

export type LabourCreditAccounts = { salary: string; epf: string; socso: string; eis: string };

export type LabourCreditLine = { account: string; sen: number; label: string };

export function labourCreditLines(
  byDept: LabourCreditInput[],
  acct: LabourCreditAccounts,
): LabourCreditLine[] {
  const sum = (k: keyof LabourCreditInput) => byDept.reduce((s, d) => s + (Number(d[k]) || 0), 0);
  const epf = sum("epfSen") + sum("epfEmployeeSen");
  const socso = sum("socsoSen") + sum("socsoEmployeeSen");
  const eis = sum("eisSen") + sum("eisEmployeeSen");
  const parts: LabourCreditLine[] = [
    { account: acct.salary, sen: sum("costSen") - epf - socso - eis, label: "accrued wages payable" },
    { account: acct.epf, sen: epf, label: "EPF payable" },
    { account: acct.socso, sen: socso, label: "SOCSO payable" },
    { account: acct.eis, sen: eis, label: "EIS payable" },
  ];
  // Two parts mapped to one account (the owner's choice) post as one line.
  const out = new Map<string, LabourCreditLine>();
  for (const p of parts) {
    if (p.sen === 0) continue;
    const cur = out.get(p.account);
    if (cur) {
      cur.sen += p.sen;
      cur.label = `${cur.label} + ${p.label}`;
    } else out.set(p.account, { ...p });
  }
  return [...out.values()];
}
