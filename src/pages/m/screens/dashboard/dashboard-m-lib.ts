// Pure logic for the /m mobile dashboard (no React, so node --test imports it:
// tests/dashboard-m-lib.test.mjs). Period math itself is NOT redefined here —
// it reuses the desktop model (dashboards/dashboard-shared-lib.ts) and the
// desktop URL scheme (dashboards/dashboard-url-state-lib.ts) so a desktop link
// and a phone link describe the same window.
import type { Period } from "../../../dashboards/dashboard-shared-lib";
import {
  DEFAULT_TAB,
  parseDashboardUrl,
  serializeDashboardUrl,
} from "../../../dashboards/dashboard-url-state-lib";
import type { TrendPoint } from "../../../dashboards/dashboard-sales-lib";

/**
 * The desktop sidebar href this dashboard mirrors. Access is decided by the
 * server (`navHidden` in /api/auth/me/permissions); the phone asks
 * isNavAllowed(DASHBOARD_NAV_HREF) for both the More-menu row and the screen.
 */
export const DASHBOARD_NAV_HREF = "/dashboard-experimental";

/** Tab strip order. Keys are the URL segment: /m/dashboard/<key>. */
export const MOBILE_TABS = [
  { key: "overview", label: "Overview" },
  { key: "sales", label: "Sales" },
  { key: "operations", label: "Operations" },
  { key: "people", label: "People" },
  { key: "service", label: "Service" },
  { key: "finance", label: "Finance" },
] as const;
export type MobileTabKey = (typeof MOBILE_TABS)[number]["key"];

export const isMobileTab = (k: string | undefined): k is MobileTabKey =>
  MOBILE_TABS.some((t) => t.key === k);

/** Period portion of the query string (mode / month / from / to / day). */
export function readPeriod(params: URLSearchParams): Period {
  return parseDashboardUrl(params, []).period;
}

/**
 * Writes `period` onto a copy of `prev`, keeping unrelated params. The desktop
 * serializer owns `tab`/`sub`; the phone keeps the tab in the path, but `sub`
 * is preserved so a later tab can keep a sub-tab in the URL.
 */
export function writePeriod(prev: URLSearchParams, period: Period): URLSearchParams {
  const out = serializeDashboardUrl({ tab: DEFAULT_TAB, sub: "", period }, prev);
  const sub = prev.get("sub");
  if (sub) out.set("sub", sub);
  return out;
}

/** Until a month is picked (or when it is not in the book) use the newest one. */
export function resolvePeriod(period: Period, months: string[]): Period {
  const month =
    period.month && months.includes(period.month) ? period.month : (months[months.length - 1] ?? "");
  return { ...period, month };
}

/** Sheet list: newest first. Monthly lists months; YTD lists years. */
export function periodChoices(months: string[], mode: "monthly" | "ytd"): { value: string; label: string }[] {
  if (mode === "monthly") return [...months].reverse().map((m) => ({ value: m, label: m }));
  const years = [...new Set(months.map((m) => m.slice(0, 4)))].sort().reverse();
  // A YTD period carries the newest month of that year: the window is the year.
  return years.map((y) => ({
    value: [...months].filter((m) => m.startsWith(y)).pop() ?? `${y}-01`,
    label: y,
  }));
}

/**
 * Tap on a chart bucket (axis label). YTD: the bucket is a month, open it.
 * Otherwise toggle the highlighted day. Same rule as the desktop Sales view.
 */
export function tapBucket(period: Period, chart: Pick<TrendPoint, "date" | "iso">[], label: string): Period {
  const hit = chart.find((d) => d.date === label);
  if (!hit) return period;
  if (period.mode === "ytd") return { mode: "monthly", month: hit.iso };
  return { ...period, day: period.day === hit.iso ? undefined : hit.iso };
}

/** Money for a narrow tile: RM 1.23M / RM 456.7k above RM 100k, else full. */
export function compactSen(sen: number, full: (sen: number) => string): string {
  const rm = sen / 100;
  const v = Math.abs(rm);
  if (v >= 1_000_000) return `RM ${(rm / 1_000_000).toFixed(2)}M`;
  if (v >= 100_000) return `RM ${(rm / 1_000).toFixed(1)}k`;
  return full(sen);
}
