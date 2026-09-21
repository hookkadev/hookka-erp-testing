// ---------------------------------------------------------------------------
// service-issue-stats.ts — pure aggregation behind the dashboard's Service
// "Top issues" sub-tab. No imports, so the worker (slice) and the browser
// (ServiceView) share ONE definition.
//
// DEFINITIONS
//  - A case with several root causes counts ONCE PER DISTINCT CAUSE, so the
//    per-cause counts can add up to more than the number of cases; each % is
//    "share of cases", not share of causes.
//  - A case with no root cause / unit / prevention recorded lands in the
//    NONE row ("Not yet analysed" etc.) — always present, even at 0.
//  - Days to close = whole calendar days from created date to closed date,
//    averaged over CLOSED cases that have a closed date.
//  - Open = status OPEN or IN_PROGRESS.
// ---------------------------------------------------------------------------

export const NONE_KEY = "__NONE__";

export type IssueCase = {
  status: string;
  createdDate: string; // YYYY-MM-DD
  closedDate: string | null;
  causes?: string[] | null;
  unit?: string | null;
  prevention?: string | null;
  products?: string[] | null;
};

export type TallyRow = {
  key: string;
  label: string;
  count: number;
  pct: number; // 0-100, share of cases
  open: number;
  avgCloseDays: number | null;
};

const DAY_MS = 86_400_000;
const OPEN = new Set(["OPEN", "IN_PROGRESS"]);

const CAUSE_LABEL: Record<string, string> = {
  PRODUCTION: "Production", DESIGN: "Design", MATERIAL: "Material", PROCESS: "Process",
  CUSTOMER: "Customer", TRANSPORT: "Transport", SALES: "Sales", PICKING: "Picking", OTHER: "Other",
};
const UNIT_LABEL: Record<string, string> = {
  PRODUCTION: "Production", QC: "QC", R_AND_D: "R&D", OFFICE: "Office", TRANSPORT: "Transport",
};
const PREVENTION_LABEL: Record<string, string> = {
  PENDING: "Planned", IN_PROGRESS: "In progress", DONE: "Done", NOT_NEEDED: "Not needed",
};
const titleCase = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export const causeLabel = (k: string) => (k === NONE_KEY ? "Not yet analysed" : CAUSE_LABEL[k] ?? titleCase(k));
export const unitLabel = (k: string) => (k === NONE_KEY ? "No unit assigned" : UNIT_LABEL[k] ?? titleCase(k));
export const preventionLabel = (k: string) => (k === NONE_KEY ? "No prevention recorded" : PREVENTION_LABEL[k] ?? titleCase(k));

export function daysToClose(c: IssueCase): number | null {
  if (c.status !== "CLOSED" || !c.closedDate) return null;
  const d = Math.round((Date.parse(c.closedDate) - Date.parse(c.createdDate)) / DAY_MS);
  return Number.isFinite(d) ? Math.max(0, d) : null;
}

/** Keys a case counts under for the cause dimension (NONE when it has none). */
export const causeKeys = (c: IssueCase): string[] => (c.causes?.length ? [...new Set(c.causes)] : [NONE_KEY]);

/** Count cases per key. Highest first; the NONE row is always last and always present. */
export function tally(
  cases: IssueCase[],
  keysOf: (c: IssueCase) => string[],
  label: (k: string) => string,
): TallyRow[] {
  const acc = new Map<string, { count: number; open: number; sum: number; n: number }>();
  acc.set(NONE_KEY, { count: 0, open: 0, sum: 0, n: 0 });
  for (const c of cases) {
    const dtc = daysToClose(c);
    for (const k of keysOf(c)) {
      const a = acc.get(k) ?? { count: 0, open: 0, sum: 0, n: 0 };
      a.count += 1;
      if (OPEN.has(c.status)) a.open += 1;
      if (dtc !== null) { a.sum += dtc; a.n += 1; }
      acc.set(k, a);
    }
  }
  const total = cases.length;
  const rows = [...acc.entries()].map(([key, a]): TallyRow => ({
    key,
    label: label(key),
    count: a.count,
    pct: total ? Math.round((a.count / total) * 1000) / 10 : 0,
    open: a.open,
    avgCloseDays: a.n ? Math.round((a.sum / a.n) * 10) / 10 : null,
  }));
  return rows.sort((x, y) =>
    x.key === NONE_KEY ? 1 : y.key === NONE_KEY ? -1 : y.count - x.count || x.label.localeCompare(y.label));
}

export const byCause = (cases: IssueCase[]) => tally(cases, causeKeys, causeLabel);
export const byUnit = (cases: IssueCase[]) => tally(cases, (c) => [c.unit || NONE_KEY], unitLabel);
export const byPrevention = (cases: IssueCase[]) => tally(cases, (c) => [c.prevention || NONE_KEY], preventionLabel);

/** Most affected products (a case counts once per distinct product). */
export function topProducts(cases: IssueCase[], limit = 10): { label: string; count: number }[] {
  const m = new Map<string, number>();
  for (const c of cases) for (const p of new Set(c.products ?? [])) m.set(p, (m.get(p) ?? 0) + 1);
  return [...m.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

/** Cases per bucket (e.g. day or month of creation) for each of the given cause keys. */
export function causeTrend(
  cases: IssueCase[],
  keys: string[],
  bucketOf: (createdDate: string) => string,
): Array<Record<string, string | number>> {
  const m = new Map<string, Record<string, string | number>>();
  for (const c of cases) {
    const b = bucketOf(c.createdDate);
    const row = m.get(b) ?? { bucket: b, ...Object.fromEntries(keys.map((k) => [k, 0])) };
    for (const k of causeKeys(c)) if (keys.includes(k)) row[k] = Number(row[k]) + 1;
    m.set(b, row);
  }
  return [...m.values()].sort((a, b) => (String(a.bucket) < String(b.bucket) ? -1 : 1));
}

const parseJson = (raw: unknown): unknown => {
  if (typeof raw !== "string" || !raw.trim()) return raw ?? null;
  try { return JSON.parse(raw); } catch { return null; }
};

/** Distinct root-cause categories of a case: the multi `rootcauses` JSON array, else the legacy single column. */
export function parseCauses(rootcauses: unknown, legacyCategory: unknown): string[] {
  const arr = parseJson(rootcauses);
  const out = new Set<string>();
  if (Array.isArray(arr)) {
    for (const e of arr) {
      const c = e && typeof e === "object" ? (e as { category?: unknown }).category : null;
      if (typeof c === "string" && c.trim()) out.add(c.trim());
    }
  }
  if (!out.size && typeof legacyCategory === "string" && legacyCategory.trim()) out.add(legacyCategory.trim());
  return [...out];
}

/** Product labels ("CODE — name") from the affected-products JSON ({productId, code, name} entries; bare strings tolerated). */
export function parseProductLabels(raw: unknown, max = 10): string[] {
  const arr = parseJson(raw);
  if (!Array.isArray(arr)) return [];
  const out = new Set<string>();
  for (const e of arr) {
    if (typeof e === "string" && e.trim()) { out.add(e.trim()); continue; }
    if (!e || typeof e !== "object") continue;
    const { code, name, productId } = e as Record<string, unknown>;
    const c = typeof code === "string" ? code.trim() : "";
    const n = typeof name === "string" ? name.trim() : "";
    const label = c && n ? `${c} — ${n}` : c || n || (typeof productId === "string" ? productId : "");
    if (label) out.add(label);
  }
  return [...out].slice(0, max);
}
