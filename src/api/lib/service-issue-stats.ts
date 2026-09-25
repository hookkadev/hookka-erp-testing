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
//  - ROOT CAUSE = category + the detail recorded under it on the case's
//    "Root Cause & Prevention" panel (department, supplier, 3PL, sub-reason…).
//    "Issues by category" tallies the category alone; "Root cause" tallies the
//    pair, so "Transport / 3PL — GDEX" and "Transport / 3PL — J&T" are two rows.
//  - "Other" is a catch-all, not an issue: it sorts below every real cause
//    (just above NONE) and never enters "Top 3 causes" (owner 2026-09-22:
//    the top issue on the dashboard read "Other · 2").
//  - Days to close = whole calendar days from created date to closed date,
//    averaged over CLOSED cases that have a closed date.
//  - Open = status OPEN or IN_PROGRESS.
// ---------------------------------------------------------------------------

export const NONE_KEY = "__NONE__";
export const OTHER_KEY = "OTHER";
/** Separates category from detail in a root-cause tally key. */
export const RC_SEP = "::";
/** Rows that never rank as a real issue: unanalysed first-from-bottom, then the Other catch-all. */
const catchAllRank = (k: string) => (k === NONE_KEY ? 2 : k.split(RC_SEP)[0] === OTHER_KEY ? 1 : 0);

export type RootCauseEntry = { category: string; detail: string };

export type IssueCase = {
  status: string;
  createdDate: string; // YYYY-MM-DD
  closedDate: string | null;
  causes?: string[] | null;
  /** category + detail per root-cause block; absent on a feed cached before it shipped. */
  rootCauses?: RootCauseEntry[] | null;
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

// Same wording as the case's Root Cause & Prevention picker (detail.tsx
// ROOT_CAUSE_LABELS), so the dashboard names a cause the way it was recorded.
const CAUSE_LABEL: Record<string, string> = {
  PRODUCTION: "Production / workmanship", DESIGN: "Design / R&D", MATERIAL: "Material / supplier",
  PROCESS: "Process / SOP gap", CUSTOMER: "Customer (not our fault)", TRANSPORT: "Transport / 3PL",
  SALES: "Sales / order-taking error", PICKING: "Picking / packing error", OTHER: "Other",
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

/** Root-cause keys ("CATEGORY::detail"), one per distinct block; NONE when it has none.
 *  Falls back to bare categories on a feed cached before `rootCauses` shipped. */
export const rootCauseKeys = (c: IssueCase): string[] => {
  const entries = c.rootCauses?.length
    ? c.rootCauses
    : (c.causes ?? []).map((category) => ({ category, detail: "" }));
  return entries.length ? [...new Set(entries.map((e) => `${e.category}${RC_SEP}${e.detail}`))] : [NONE_KEY];
};
export const rootCauseLabel = (k: string): string => {
  if (k === NONE_KEY) return "Not yet analysed";
  const i = k.indexOf(RC_SEP);
  const cat = i < 0 ? k : k.slice(0, i);
  const detail = i < 0 ? "" : k.slice(i + RC_SEP.length);
  return detail ? `${causeLabel(cat)} — ${detail}` : causeLabel(cat);
};

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
    catchAllRank(x.key) - catchAllRank(y.key) || y.count - x.count || x.label.localeCompare(y.label));
}

/** The real causes to chart as "Top N": catch-all rows (Other / unanalysed) and zero rows excluded. */
export const topCauses = (rows: TallyRow[], n = 3): TallyRow[] =>
  rows.filter((r) => catchAllRank(r.key) === 0 && r.count > 0).slice(0, n);

export const byCause = (cases: IssueCase[]) => tally(cases, causeKeys, causeLabel);
export const byRootCause = (cases: IssueCase[]) => tally(cases, rootCauseKeys, rootCauseLabel);
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

// ---- Lim's "Service" sub-tab: closing speed, opening backlog, prevention -----

/** Average days-to-close (1 dp) over the CLOSED cases in `cases`; n = how many contributed. */
export function avgClose(cases: IssueCase[]): { avg: number | null; n: number } {
  let sum = 0, n = 0;
  for (const c of cases) { const d = daysToClose(c); if (d !== null) { sum += d; n += 1; } }
  return { avg: n ? Math.round((sum / n) * 10) / 10 : null, n };
}

/** Avg close days + closed count per bucket of the CLOSED date. Pass only cases closed in the window. */
export function closeTrend(closed: IssueCase[], bucketOf: (date: string) => string): { bucket: string; avg: number | null; closed: number }[] {
  const m = new Map<string, IssueCase[]>();
  for (const c of closed) if (c.status === "CLOSED" && c.closedDate) { const b = bucketOf(c.closedDate); m.set(b, [...(m.get(b) ?? []), c]); }
  return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([bucket, cs]) => ({ bucket, avg: avgClose(cs).avg, closed: cs.length }));
}

/** Opened (by created date) vs closed (by closed date) per bucket, for dates accepted by `inRange`. */
export function openedVsClosed(cases: IssueCase[], inRange: (date: string) => boolean, bucketOf: (date: string) => string) {
  const m = new Map<string, { bucket: string; opened: number; closed: number }>();
  const bump = (date: string, k: "opened" | "closed") => {
    const b = bucketOf(date);
    const r = m.get(b) ?? { bucket: b, opened: 0, closed: 0 };
    r[k] += 1;
    m.set(b, r);
  };
  for (const c of cases) {
    if (inRange(c.createdDate)) bump(c.createdDate, "opened");
    if (c.status === "CLOSED" && c.closedDate && inRange(c.closedDate)) bump(c.closedDate, "closed");
  }
  return [...m.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
}

/**
 * Aging of the still-open cases (ageDays = whole days since logged). With overdue
 * threshold T: 0..T, T+1..2T+1, 2T+2+ (T=3 -> 0-3 / 4-7 / 8+).
 */
export function agingSplit(cases: { status: string; ageDays?: number | null }[], threshold: number) {
  const rows = [
    { label: `0–${threshold} days`, count: 0 },
    { label: `${threshold + 1}–${2 * threshold + 1} days`, count: 0 },
    { label: `${2 * threshold + 2}+ days`, count: 0 },
  ];
  for (const c of cases) {
    if (!OPEN.has(c.status) || c.ageDays == null) continue;
    rows[c.ageDays <= threshold ? 0 : c.ageDays <= 2 * threshold + 1 ? 1 : 2].count += 1;
  }
  return rows;
}

/**
 * Cases whose prevention is not yet done, oldest first. In: not cancelled, prevention
 * PENDING / IN_PROGRESS, or none recorded once the case is analysed (has a root cause) or closed.
 * DONE and NOT_NEEDED are out. daysOpen = age while open, else days-to-close.
 */
export function preventionNotDone<T extends IssueCase & { ageDays?: number | null }>(cases: T[]): (T & { daysOpen: number | null })[] {
  return cases
    .filter((c) => {
      if (c.status === "CANCELLED") return false;
      if (c.prevention === "DONE" || c.prevention === "NOT_NEEDED") return false;
      return !!c.prevention || !!c.causes?.length || c.status === "CLOSED";
    })
    .map((c) => ({ ...c, daysOpen: OPEN.has(c.status) ? c.ageDays ?? null : daysToClose(c) }))
    .sort((a, b) => (a.createdDate < b.createdDate ? -1 : a.createdDate > b.createdDate ? 1 : 0));
}
const parseJson = (raw: unknown): unknown => {
  if (typeof raw !== "string" || !raw.trim()) return raw ?? null;
  try { return JSON.parse(raw); } catch { return null; }
};

// The one field per category that names the root cause, in the order the
// detail form writes them (detail.tsx CategoryDetailsForm): dept for
// PRODUCTION / PROCESS / PICKING / DESIGN, supplier for MATERIAL, 3PL or driver
// for TRANSPORT, salesperson for SALES, SOP / suggested fix, and the free-text
// sub-reason (CUSTOMER, and the fallback for every category).
const DETAIL_KEYS = [
  "departmentName", "designDeptName", "supplierName", "threePlCompany", "driverName",
  "salesPerson", "sopName", "suggestedFix", "notes",
];
const DETAIL_MAX = 60;

/** Short label for a root-cause block's structured details ('' when nothing usable was recorded). */
export function rootCauseDetail(details: unknown): string {
  const d = parseJson(details);
  if (!d || typeof d !== "object" || Array.isArray(d)) return "";
  for (const k of DETAIL_KEYS) {
    const v = (d as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) {
      const t = v.trim().replace(/\s+/g, " ");
      return t.length > DETAIL_MAX ? t.slice(0, DETAIL_MAX - 1) + "…" : t;
    }
  }
  return "";
}

/** Root-cause blocks of a case (category + detail label): the multi `rootcauses` JSON array, else the legacy single columns. */
export function parseRootCauses(rootcauses: unknown, legacyCategory: unknown, legacyDetails?: unknown): RootCauseEntry[] {
  const arr = parseJson(rootcauses);
  const out: RootCauseEntry[] = [];
  const seen = new Set<string>();
  const push = (category: unknown, details: unknown) => {
    if (typeof category !== "string" || !category.trim()) return;
    const e = { category: category.trim(), detail: rootCauseDetail(details) };
    const k = `${e.category}${RC_SEP}${e.detail}`;
    if (!seen.has(k)) { seen.add(k); out.push(e); }
  };
  if (Array.isArray(arr)) {
    for (const e of arr) {
      if (e && typeof e === "object") push((e as { category?: unknown }).category, (e as { details?: unknown }).details);
    }
  }
  if (!out.length) push(legacyCategory, legacyDetails);
  return out;
}

/** Distinct root-cause categories of a case: the multi `rootcauses` JSON array, else the legacy single column. */
export function parseCauses(rootcauses: unknown, legacyCategory: unknown): string[] {
  return [...new Set(parseRootCauses(rootcauses, legacyCategory).map((e) => e.category))];
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

export type CauseGrid = {
  buckets: string[];
  rows: { key: string; label: string; cells: number[]; total: number }[];
  max: number;
};

/** Cases per root cause (category + detail) per bucket over a FIXED bucket list, so empty buckets stay visible. Rows: root causes with a case, NONE last. */
export function rootCauseGrid(cases: IssueCase[], buckets: string[], bucketOf: (createdDate: string) => string): CauseGrid {
  const idx = new Map(buckets.map((b, i) => [b, i]));
  const rows = byRootCause(cases)
    .filter((r) => r.count > 0)
    .map((r) => ({ key: r.key, label: r.label, cells: buckets.map(() => 0), total: r.count }));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const c of cases) {
    const i = idx.get(bucketOf(c.createdDate));
    if (i === undefined) continue;
    for (const k of rootCauseKeys(c)) { const row = byKey.get(k); if (row) row.cells[i] += 1; }
  }
  return { buckets, rows, max: Math.max(0, ...rows.flatMap((r) => r.cells)) };
}

/** Every YYYY-MM-DD from `from` to `to` inclusive (UTC arithmetic; inputs are plain dates). */
export function dayBuckets(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(from + "T00:00:00Z"), end = Date.parse(to + "T00:00:00Z"); t <= end; t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Every YYYY-MM of `year` from January through `throughMonth` (1-12). */
export function monthBuckets(year: number, throughMonth: number): string[] {
  return Array.from({ length: Math.max(1, Math.min(12, throughMonth)) }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
}
