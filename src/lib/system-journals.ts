// ---------------------------------------------------------------------------
// System postings on Journal Entries (owner 2026-10-09 「post to GL 我在 journal
// 看没有」→「journal 也要显示」).
//
// Some postings go straight to the GL with no journal document of their own —
// the labour month-end posting and its undo, closing stock, depreciation, the
// year-end close, the opening balance — so the Journal Entries list never
// showed them. GET /api/accounting/system-journals turns their ledger legs into
// journal-shaped entries the list shows beside the manual ones, read-only:
// each is redone or undone on the tab that made it. One entry per posting —
// the legs one transaction wrote share sourceType, sourceId and postedAt.
// ---------------------------------------------------------------------------

export type SystemPosting = { family: string; label: string; tab: string; undo: boolean };

// sourceType → what the list calls it and the accounting tab that made it.
export const SYSTEM_JOURNAL_FAMILIES: Record<string, { label: string; tab: string }> = {
  labor_post: { label: "Labour posting", tab: "labor" },
  labor_post_reversal: { label: "Labour posting undone", tab: "labor" },
  closing_stock: { label: "Closing stock", tab: "stock" },
  closing_stock_reversal: { label: "Closing stock reversed", tab: "stock" },
  depreciation: { label: "Depreciation", tab: "assets" },
  year_close: { label: "Year-end close", tab: "bs" },
  opening_balance: { label: "Opening balance", tab: "opening" },
  opening_balance_reversal: { label: "Opening balance reversed", tab: "opening" },
};

export type SystemLeg = {
  sourceType: string;
  sourceId: string;
  postedAt: string | null;
  accountCode: string;
  debitSen: number;
  creditSen: number;
  description: string | null;
};

export type SystemJournal = {
  id: string;
  entryNo: string;
  date: string;
  description: string;
  status: "POSTED";
  lifecycleState: null;
  createdBy: string;
  createdAt: string;
  system: SystemPosting;
  lines: { accountCode: string; accountName: string; debitSen: number; creditSen: number; description: string }[];
};

// `legs` in posting order (postedAt, legNo); `docDate` is the reports' own
// document-date rule, so an entry lands on the date the GL reports it under.
export function buildSystemJournals(
  legs: SystemLeg[],
  accountName: (code: string) => string,
  docDate: (sourceType: string, sourceId: string, postedAt: string) => string,
): SystemJournal[] {
  const byKey = new Map<string, SystemJournal>();
  for (const l of legs) {
    const fam = SYSTEM_JOURNAL_FAMILIES[l.sourceType];
    if (!fam) continue;
    const postedAt = String(l.postedAt ?? "");
    const key = `sys:${l.sourceType}:${l.sourceId}:${postedAt}`;
    let e = byKey.get(key);
    if (!e) {
      e = {
        id: key,
        entryNo: l.sourceId,
        date: docDate(l.sourceType, l.sourceId, postedAt).slice(0, 10),
        description: fam.label,
        status: "POSTED",
        lifecycleState: null,
        createdBy: "System",
        createdAt: postedAt,
        system: { family: l.sourceType, label: fam.label, tab: fam.tab, undo: /_reversal$/.test(l.sourceType) },
        lines: [],
      };
      byKey.set(key, e);
    }
    e.lines.push({
      accountCode: l.accountCode,
      accountName: accountName(l.accountCode),
      debitSen: Number(l.debitSen) || 0,
      creditSen: Number(l.creditSen) || 0,
      description: String(l.description ?? ""),
    });
  }
  // The posting's own words (its first leg's) say what it was, after the label.
  const out = [...byKey.values()].map((e) => ({
    ...e,
    description: e.lines[0]?.description ? `${e.system.label} · ${e.lines[0].description}` : e.system.label,
  }));
  // Newest first, like the manual journals.
  out.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  return out;
}
