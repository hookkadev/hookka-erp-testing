// ---------------------------------------------------------------------------
// Payment terms — owner rule: term is a fixed 1 MONTH, by calendar MONTH not
// by day. An invoice issued in month M is due "next month" (M+1) — the whole
// of next month is the payment window, so due date = last day of M+1. It is
// "current" through the end of M+1 for DUE-DATE purposes. AGING, however, is
// reported by CALENDAR month (owner rule 2026-06-30): this month = current,
// last month = 1 month, etc. — see monthsOverdue below. The same 1-month term
// governs the due date stamped on purchase invoices. Sales invoices follow
// the CUSTOMER's term instead (dueDateForTerms, BUG-34): same calendar-month
// rule, N months = COD 0 / NET30 1 / NET60 2 / NET90 3.
//
// Single source of truth — imported by invoices.ts / purchase-invoices.ts
// (stamp dueDate) and accounting.ts (aging buckets) so the rule can't drift.
// ---------------------------------------------------------------------------

/** Parse a YYYY-MM(-DD…) string → { y, m } (m is 1-based). null if unparseable. */
function ym(d: string | null | undefined): { y: number; m: number } | null {
  const s = String(d ?? "").slice(0, 7);
  const mt = s.match(/^(\d{4})-(\d{2})$/);
  if (!mt) return null;
  return { y: Number(mt[1]), m: Number(mt[2]) };
}

/**
 * Due date (YYYY-MM-DD) for an invoice = last calendar day of the month
 * AFTER the invoice's month. April invoice → 2026-05-31. Dec → next-Jan-31.
 * Falls back to today if the invoice date can't be parsed.
 */
export function nextMonthDueDate(invoiceDate: string | null | undefined): string {
  const p = ym(invoiceDate);
  if (!p) return new Date().toISOString().slice(0, 10);
  // Date.UTC(y, m, 0): m is the 0-based index of the month AFTER the
  // invoice month, day 0 = its last day → last day of (invoice month + 1).
  return new Date(Date.UTC(p.y, p.m + 1, 0)).toISOString().slice(0, 10);
}

/**
 * Customer credit term → months of payment window (BUG-34, 2026-09-28).
 * NET30 = 1, NET60 = 2, NET90 = 3 — by calendar MONTH, same as the owner rule
 * above. COD = 0 (due by the end of the invoice's own month). Anything else
 * (blank, free text) falls back to the house 1-month term.
 */
export function termMonths(creditTerms: string | null | undefined): number {
  const t = String(creditTerms ?? "").toUpperCase().replace(/[\s._-]/g, "");
  if (t === "COD") return 0;
  const days = t.match(/^NET(\d+)$/);
  if (days) return Math.max(0, Math.round(Number(days[1]) / 30));
  return 1;
}

/**
 * Due date for an invoice under the customer's term = last day of
 * (invoice month + termMonths). NET30 January → Feb 28/29 (block from Mar 1),
 * NET60 January → Mar 31. Falls back to today if the date can't be parsed.
 */
export function dueDateForTerms(
  invoiceDate: string | null | undefined,
  creditTerms: string | null | undefined,
): string {
  const p = ym(invoiceDate);
  if (!p) return new Date().toISOString().slice(0, 10);
  return new Date(Date.UTC(p.y, p.m + termMonths(creditTerms), 0))
    .toISOString()
    .slice(0, 10);
}

/**
 * Aging-bucket index by the invoice's CALENDAR month (owner rule, 2026-06-30):
 * THIS month = 0 (Current), last month = 1, two months ago = 2, … i.e. how many
 * whole calendar months ago the invoice was issued — the day is irrelevant.
 * The aging is independent of the payment term: the 1-month term still governs
 * the DUE DATE (nextMonthDueDate), but a last-month invoice ages into "1 month"
 * even though it is not yet past its due date.
 */
export function monthsOverdue(
  invoiceDate: string | null | undefined,
  now: Date = new Date(),
): number {
  const p = ym(invoiceDate);
  if (!p) return 0;
  const nowMonths = now.getFullYear() * 12 + (now.getMonth() + 1);
  const invMonths = p.y * 12 + p.m;
  return nowMonths - invMonths;
}
