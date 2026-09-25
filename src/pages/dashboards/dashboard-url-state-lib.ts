import {
  PEOPLE_SUBS, OPS_SUBS, SERVICE_SUBS, FIN_SUBS,
  type Period,
} from "./dashboard-shared-lib";

// Pure URL <-> state mapping for the dashboard page (no React, so node --test
// can import it). The URL is the single source of truth; the hook in
// use-dashboard-url-state.ts only reads/writes it.
//
// Scheme (defaults are omitted so URLs stay clean):
//   tab=<key>            omitted when overview
//   sub=<key>            sub-tab OF THE CURRENT TAB, omitted when it is the first
//   mode=ytd|range       omitted when monthly
//   month=YYYY-MM        omitted when unset (resolves to newest month with sales)
//   from=YYYY-MM-DD&to=YYYY-MM-DD&lbl=<preset name>   range mode only
//   day=YYYY-MM-DD       highlighted day
// Only the current tab's sub-tab lives in the URL; other tabs' sub-tabs reset
// to their default when you leave (Back restores them via the old URL).

/**
 * Sub-tab registry: tab key -> its SUBS array. The FIRST entry is the default.
 * Adding a tab with sub-tabs = one line here; adding a sub-tab = append it to
 * that tab's SUBS array in dashboard-shared-lib.ts (no change here). Tabs with
 * no sub-tabs are simply absent.
 */
export const TAB_SUBS: Record<string, readonly { key: string; label: string }[]> = {
  operations: OPS_SUBS,
  people: PEOPLE_SUBS,
  service: SERVICE_SUBS,
  finance: FIN_SUBS,
};

// Links saved while tabs were named after staff (and Employees / Departments
// were separate tabs, later a Departments sub-tab, now inside Efficiency) still
// open the chart they pointed at. Keyed "tab:sub", then "tab"; a missing sub in
// the value keeps the sub from the URL.
export const LEGACY: Record<string, [tab: string, sub?: string]> = {
  siti: ["operations"],
  employee: ["people"],
  department: ["people", "efficiency"],
  "people:departments": ["people", "efficiency"],
  lim: ["people", "efficiency"],
  "lim:plan": ["operations", "plan"],
  "lim:revenue": ["operations", "cost"],
  "lim:overdue": ["operations", "overview"],
  "lim:attendance": ["people", "time"],
  "lim:service": ["service", "performance"],
};

export const DEFAULT_TAB = "overview";
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isYmd(s: string | null | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export const defaultSub = (tab: string): string => TAB_SUBS[tab]?.[0]?.key ?? "";

export type DashboardUrlState = { tab: string; sub: string; period: Period };

export function parseDashboardUrl(params: URLSearchParams, tabKeys: readonly string[]): DashboardUrlState {
  const legacy = LEGACY[`${params.get("tab")}:${params.get("sub")}`] ?? LEGACY[params.get("tab") ?? ""];
  const t = legacy?.[0] ?? params.get("tab");
  const tab = t && tabKeys.includes(t) ? t : DEFAULT_TAB;
  const s = legacy?.[1] ?? params.get("sub");
  const sub = s && TAB_SUBS[tab]?.some((x) => x.key === s) ? s : defaultSub(tab);

  const m = params.get("month");
  const month = m && MONTH_RE.test(m) ? m : "";
  const dayRaw = params.get("day");
  const day = isYmd(dayRaw) ? dayRaw : undefined;
  const from = params.get("from");
  const to = params.get("to");
  const mode = params.get("mode");

  let period: Period = { mode: "monthly", month };
  if (mode === "ytd") period = { mode: "ytd", month };
  else if (mode === "range" && isYmd(from) && isYmd(to) && from <= to) {
    period = { mode: "range", month, from, to, ...(params.get("lbl") ? { label: params.get("lbl")!.slice(0, 40) } : {}) };
  }
  if (day) period = { ...period, day };
  return { tab, sub, period };
}

const PERIOD_KEYS = ["mode", "month", "from", "to", "lbl", "day"];

/** Writes `state` onto a copy of `base`, preserving unrelated params. */
export function serializeDashboardUrl(state: DashboardUrlState, base: URLSearchParams = new URLSearchParams()): URLSearchParams {
  const out = new URLSearchParams(base);
  for (const k of ["tab", "sub", ...PERIOD_KEYS]) out.delete(k);
  const { tab, sub, period: p } = state;
  if (tab !== DEFAULT_TAB) out.set("tab", tab);
  if (sub && sub !== defaultSub(tab)) out.set("sub", sub);
  if (p.mode !== "monthly") out.set("mode", p.mode);
  if (p.month) out.set("month", p.month);
  if (p.mode === "range" && p.from && p.to) {
    out.set("from", p.from);
    out.set("to", p.to);
    if (p.label) out.set("lbl", p.label);
  }
  if (p.day) out.set("day", p.day);
  return out;
}
