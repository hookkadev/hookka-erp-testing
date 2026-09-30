// ---------------------------------------------------------------------------
// ledger-drill.ts — pure helpers for the P&L inline drill (owner 2026-09-29
// 「我要点开看 detail，就是这样」, the Houzs P&L's click-a-line view): which
// document a ledger line belongs to, and what sits on the other side of it.
// ---------------------------------------------------------------------------

export type DrillLeg = { accountCode: string; debitSen: number; creditSen: number };

// Every posting writes its document number into the line description
// ("Sales · invoice INV-2609-011", "JV JE-2609-0001", "HPV-2609-016 · …",
// "Other creditor bill · OCB-2609-004 · …"). The first one found is the line's
// own document.
const DOC_NO = /\b[A-Z]{1,6}-\d{4}-\d{3,4}\b/;
export function docNoFromDescription(description: string | null | undefined): string | null {
  const m = DOC_NO.exec(description ?? "");
  return m ? m[0] : null;
}

// The other side of one ledger line: the accounts on the opposite side of the
// same entry (a credit's debits, a debit's credits), its own account left out,
// largest first. An entry with nothing on the opposite side falls back to every
// other leg, so the column is never empty when the entry has other accounts.
export function otherSideCodes(
  leg: DrillLeg,
  entryLegs: readonly DrillLeg[],
  resolve: (code: string) => string = (code) => code,
): string[] {
  const own = resolve(leg.accountCode);
  const isDebit = (Number(leg.debitSen) || 0) > 0;
  const size = (l: DrillLeg) => (Number(l.debitSen) || 0) + (Number(l.creditSen) || 0);
  const collect = (keep: (l: DrillLeg) => boolean): string[] => {
    const byCode = new Map<string, number>();
    for (const l of entryLegs) {
      if (!keep(l)) continue;
      const code = resolve(l.accountCode);
      if (code === own) continue;
      byCode.set(code, (byCode.get(code) ?? 0) + size(l));
    }
    return [...byCode.entries()].sort((a, b) => b[1] - a[1]).map(([code]) => code);
  };
  const opposite = collect((l) => (isDebit ? (Number(l.creditSen) || 0) > 0 : (Number(l.debitSen) || 0) > 0));
  return opposite.length ? opposite : collect(() => true);
}

// "2026-09" → "Sep'26" (how the P&L names a month).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function monthLabel(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  const idx = Number(m[2]) - 1;
  return idx >= 0 && idx < 12 ? `${MONTHS[idx]}'${m[1].slice(2)}` : ym;
}

// A ledger description with its own document number taken out — the number
// already has its own column (Ref. 1). "HPV-2608-030 · to ECMS" → "to ECMS";
// "Receipt HOR-2606-008 · Houzs Century" → "Receipt · Houzs Century".
export function withoutDocNo(description: string | null | undefined, docNo: string | null | undefined): string {
  const raw = (description ?? "").trim();
  if (!docNo) return raw;
  const s = raw.split(docNo).join(" ")
    .replace(/\s*·\s*(?:·\s*)+/g, " · ")
    .replace(/^[\s·:\-–]+/, "")
    .replace(/[\s·:\-–]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return s || raw;
}

// The short name of a money account for a narrow column: "CASH AT BANK -
// HLBB" → "HLBB", "CASH IN HAND" → "Cash", "TRADE FINANCE - HOUZS CENTURY SDN
// BHD" → "TF · HOUZS CENTURY". Anything else keeps its name.
export function shortBankName(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  const bank = /^CASH AT BANK\s*[-–]\s*(.+)$/i.exec(n);
  if (bank) return bank[1].trim();
  if (/^(CASH IN HAND|PETTY CASH)\b/i.test(n)) return "Cash";
  const tf = /^TRADE FINANCE\s*[-–]\s*(.+)$/i.exec(n);
  if (tf) return `TF · ${tf[1].replace(/\s+SDN\.?\s*BHD\.?$/i, "").trim()}`;
  return n;
}
