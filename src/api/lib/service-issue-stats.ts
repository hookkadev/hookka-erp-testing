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

// ---- "Top issues" redesign (2026-09-22): meters, per-case close days, cause × day grid ----
// Four tables of the same bar answered four different questions with one picture.
// These feed the forms that fit each question: how far analysis has got (meters),
// open vs closed per cause (byCause already carries it), every case's days to
// close (dots, not one average over 1-5 cases), and cases per cause per DAY on a
// fixed grid (a heatmap keeps whole counts whole — the old smoothed line drew
// values between days that never happened).

export type ProgressStep = { key: string; label: string; done: number; total: number; pct: number };

/** How far the root-cause process has got: one ratio per step over every case given. */
export function analysisProgress(cases: IssueCase[]): ProgressStep[] {
  const total = cases.length;
  const step = (key: string, label: string, ok: (c: IssueCase) => boolean): ProgressStep => {
    const done = cases.filter(ok).length;
    return { key, label, done, total, pct: total ? Math.round((done / total) * 100) : 0 };
  };
  return [
    step("cause", "Root cause recorded", (c) => !!c.causes?.length),
    step("unit", "Responsible unit set", (c) => !!c.unit),
    step("prevention", "Prevention recorded", (c) => !!c.prevention),
    step("done", "Prevention done", (c) => c.prevention === "DONE" || c.prevention === "NOT_NEEDED"),
  ];
}

export type CloseDaysRow = { key: string; label: string; count: number; days: number[]; avg: number | null };

/** Days-to-close of every CLOSED case per cause (a multi-cause case appears under each). Same row order as byCause. */
export function closeDaysByCause(cases: IssueCase[]): CloseDaysRow[] {
  const m = new Map<string, number[]>();
  for (const c of cases) {
    const d = daysToClose(c);
    if (d === null) continue;
    for (const k of causeKeys(c)) m.set(k, [...(m.get(k) ?? []), d]);
  }
  return byCause(cases).map((r) => ({
    key: r.key, label: r.label, count: r.count, days: (m.get(r.key) ?? []).sort((a, b) => a - b), avg: r.avgCloseDays,
  }));
}

export type CauseGrid = {
  buckets: string[];
  rows: { key: string; label: string; cells: number[]; total: number }[];
  max: number;
};

/** Cases per cause per bucket over a FIXED bucket list (empty buckets stay visible). Rows: causes with a case, NONE last. */
export function causeGrid(cases: IssueCase[], buckets: string[], bucketOf: (createdDate: string) => string): CauseGrid {
  const idx = new Map(buckets.map((b, i) => [b, i]));
  const rows = byCause(cases)
    .filter((r) => r.count > 0)
    .map((r) => ({ key: r.key, label: r.label, cells: buckets.map(() => 0), total: r.count }));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const c of cases) {
    const i = idx.get(bucketOf(c.createdDate));
    if (i === undefined) continue;
    for (const k of causeKeys(c)) { const row = byKey.get(k); if (row) row.cells[i] += 1; }
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

/** The cause most often recorded on the cases that list each product (null = none analysed). */
export function topCauseByProduct(cases: IssueCase[]): Map<string, string | null> {
  const tallies = new Map<string, Map<string, number>>();
  for (const c of cases) {
    for (const p of new Set(c.products ?? [])) {
      const t = tallies.get(p) ?? new Map<string, number>();
      for (const k of c.causes?.length ? new Set(c.causes) : []) t.set(k, (t.get(k) ?? 0) + 1);
      tallies.set(p, t);
    }
  }
  const out = new Map<string, string | null>();
  for (const [p, t] of tallies) {
    const best = [...t.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    out.set(p, best ? best[0] : null);
  }
  return out;
}
