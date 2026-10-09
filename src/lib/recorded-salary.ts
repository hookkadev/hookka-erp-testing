// ---------------------------------------------------------------------------
// recorded-salary.ts — which (month, account) pairs already carry the owner's
// salary figures in the GL, so the P&L's report-layer payroll (payslips, else
// a dry run) does not add them a second time.
//
// An entry that credits the salary accrual (410-0010 — a Labour-tab post or a
// manual JV) marks, for its month, the accounts its debit legs touched
// (account-level since BUG-2026-08-31-172).
//
// BUG-2026-10-09-275: a posting that was undone still counted. The Labour tab's
// Unpost appends a reversal (labor_post_reversal, same sourceId) instead of
// deleting, and the old rule only looked at the original legs — so a month
// that was posted and unposted showed NO direct labour at all: the ledger nets
// to zero and the payslip figures were skipped as "already recorded". A voided
// manual JV had the same flaw. The legs of one document — its posting, any
// reversal / void / restate of it — are now taken together, and an account
// counts only while its NET debit in that document is above zero.
// ---------------------------------------------------------------------------
import { stripLegSuffix, stripSourceIdSuffix } from "./doc-date";

export type SalaryLegIn = {
  sourceType: string;
  sourceId: string;
  /** Account code, already resolved through any rename alias. */
  accountCode: string;
  debitSen: number;
  creditSen: number;
  /** YYYY-MM by the document date; null = leave the leg out (pre-opening / opening). */
  ym: string | null;
};

/** One key per source document: a posting and its reversal / void / restate share it. */
export const salaryDocKey = (sourceType: string, sourceId: string) =>
  `${stripLegSuffix(sourceType)}::${stripSourceIdSuffix(sourceId)}`;

export function recordedSalaryAccounts(
  legs: SalaryLegIn[],
  accrualAccount: string,
): Map<string, Set<string>> {
  // The documents that credit the accrual, and the month they record.
  const docYm = new Map<string, string>();
  for (const l of legs) {
    if (!l.ym || l.accountCode !== accrualAccount || !((Number(l.creditSen) || 0) > 0)) continue;
    const k = salaryDocKey(l.sourceType, l.sourceId);
    if (!docYm.has(k)) docYm.set(k, l.ym);
  }
  // Net debit per account across every leg of those documents.
  const net = new Map<string, Map<string, number>>();
  for (const l of legs) {
    if (!l.ym) continue;
    const k = salaryDocKey(l.sourceType, l.sourceId);
    if (!docYm.has(k)) continue;
    let m = net.get(k);
    if (!m) { m = new Map(); net.set(k, m); }
    m.set(l.accountCode, (m.get(l.accountCode) ?? 0) + (Number(l.debitSen) || 0) - (Number(l.creditSen) || 0));
  }
  const out = new Map<string, Set<string>>();
  for (const [k, accts] of net) {
    const ym = docYm.get(k) as string;
    for (const [account, sen] of accts) {
      if (account === accrualAccount || !(sen > 0)) continue;
      let set = out.get(ym);
      if (!set) { set = new Set(); out.set(ym, set); }
      set.add(account);
    }
  }
  return out;
}
