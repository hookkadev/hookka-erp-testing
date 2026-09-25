// Shared constants/helpers for the dashboard-prototype tabs — split out of
// dashboard-shared.tsx because a file mixing component exports with
// constant/function exports breaks Vite Fast Refresh (react-refresh/only-
// export-components).
import { formatCurrency } from "../../lib/utils";

export const TAUPE = "#6B5C32";
export const TEAL = "#3E6570";
export const MUTED = "#6B7280";
export const BORDER = "#E2DDD8";
export const GREEN = "#4F7C3A";
export const AMBER = "#9C6F1E";
export const RED = "#9A3A2D";

// Mirrors the route's own predicate (dashboard-prototype.ts) and the house
// Command Center's `status NOT IN ('DRAFT','CANCELLED','ON_HOLD')`. A DRAFT is
// not a sale yet; a cancelled or held order is not one any more. Kept in one
// place so the KPI count and the KPI money cannot drift apart.
const NON_REVENUE_STATUSES = new Set(["DRAFT", "CANCELLED", "ON_HOLD"]);
export function isConfirmedOrder(status: string | null | undefined): boolean {
  return !NON_REVENUE_STATUSES.has((status ?? "").toUpperCase());
}

export function fmtN(n: number): string {
  return n.toLocaleString("en-MY");
}

// Compact money for chart axes: "RM 15k", "RM 1.2m". A full "RM 15,000" is
// wide enough that Recharts wraps the tick onto two lines and drops the space
// between them ("RM" / "15,000"), which reads as broken.
export function fmtRMAxis(n: number): string {
  const v = Math.abs(n);
  if (v >= 1_000_000) return `RM ${(n / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}m`;
  if (v >= 1_000) return `RM ${Math.round(n / 1_000)}k`;
  return `RM ${n}`;
}

// ---------------------------------------------------------------------------
// DashboardWidgets.tsx formatters — owner rule 2026-09-23: no
// rounding, TRUNCATE to 2 decimals (0.299 -> 0.29, -0.001 -> 0.00).
// toPrecision(15) first so a float like 0.29*100 = 28.999999999999996 is read
// as the 29 it means before the cut; `|| 0` turns -0 (and NaN) into 0.
// ---------------------------------------------------------------------------
export function truncDp(n: number, dp = 2): number {
  return Math.trunc(Number((n * 10 ** dp).toPrecision(15))) / 10 ** dp || 0;
}
export function fmtDec2(n: number): string {
  return truncDp(n).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function fmtPct2(n: number | null | undefined): string {
  return n == null ? "—" : `${fmtDec2(n)}%`;
}
/** Integer sen, truncated (never rounded) — formatCurrency prints 2dp. */
export function fmtRM2(sen: number | null | undefined): string {
  return formatCurrency(Math.trunc(sen ?? 0) || 0);
}
/** Minutes as "Xh Ym", truncated to the whole minute. */
export function fmtHM(min: number | null | undefined): string {
  const m = Math.max(0, Math.trunc(min ?? 0));
  return `${Math.floor(m / 60).toLocaleString("en-MY")}h ${m % 60}m`;
}
/** /dashboard's `period` query value: YTD reads all-time, else the month. */
export function widgetPeriod(p: Period): string {
  return p.mode === "ytd" ? "all" : p.month;
}
export function widgetPeriodLabel(p: Period): string {
  return widgetPeriod(p) === "all" ? "All-time" : monthLabel(p.month);
}

// ---------------------------------------------------------------------------
// Chart theme — warm industrial. Owner-specified 2026-09-15.
//
// CHART_INK is the bar/solid tone, CHART_GOLD the line/accent. Kept here rather
// than inline so every chart on the dashboard reads as one system, and so the
// legend swatch and the series it labels can never drift apart (pass CHART_INK
// as the Bar's own `fill` even when per-point <Cell> colours are used — the
// legend reads the series fill, not the cells).
// ---------------------------------------------------------------------------
// Revenue (bars) carries the DEEP tone and Orders (line) the lighter one, so
// the bars hold the weight and the line reads as an overlay on top of them.
//
// The line cannot go as light as the bars are dark: it crosses BOTH the deep
// bars and the white card background, and a sand tone (#D9C79A) disappeared
// completely against the white wherever it rose above the bars. Brass is the
// lightest tone that stays legible on both grounds.
export const CHART_INK = "#6B5C32";   // Revenue bars — deep taupe
export const CHART_GOLD = "#C5A85C";  // Orders line — brass (legible on white AND on the bars)
export const CHART_AXIS = "#A39E93";  // grid lines + tick labels — warm gray
export const CARD_BORDER = "#E5E0D8"; // card / grid border
export const CARD_BG = "#FFFFFF";

// Donut + category series, warm-industrial ordered light-to-dark so adjacent
// segments stay distinguishable without relying on hue alone.
export const CHART_SERIES = [
  "#1F4654",
  "#2E7186",
  "#3E9AAE",
  "#8A6A3B",
  "#C5A85C",
  "#8A7F6B",
  "#C4BCAE",
];

// ---------------------------------------------------------------------------
// Period — the dashboard's global Monthly/YTD selector. "YTD" is the toggle's
// label; the window it selects is the whole calendar year.
//
// Lives here (not in a view) because the control sits ABOVE the tabs and every
// tab that has a date column reads the same selection. `meta.months` from the
// feed is the list of months that actually exist in the book, so the stepper
// can only land on a month with data instead of walking into empty ranges.
//
// Tabs whose data is a point-in-time snapshot rather than a series (Inventory
// stock on hand, Production work-in-progress) are NOT filtered by this — they
// say so in their own subtitle instead of silently ignoring the picker.
// ---------------------------------------------------------------------------
// "range" carries an explicit from..to day window (the datepicker presets and
// any custom selection). `month` stays populated on a range so the stepper and
// the calendar have something to anchor on.
export type PeriodMode = "monthly" | "ytd" | "range";
export type Period = {
  mode: PeriodMode;
  month: string;
  from?: string;
  to?: string;
  label?: string;
  // A single HIGHLIGHTED day. Deliberately NOT part of inPeriod: the chart
  // keeps showing the whole month while the KPI row, pipeline and recent list
  // narrow to this day. Picking a date and clicking a bar set the same field,
  // so the two routes into "show me this day" behave identically.
  day?: string;
};

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function monthLabel(m: string): string {
  const [y, mm] = m.split("-");
  return `${MONTH_NAMES[Number(mm) - 1] ?? mm} ${y}`;
}

/**
 * `today` is optional and only sharpens the YTD label ("2026 (Jan – Present)"
 * for the real current year vs "(Jan – Dec)" for a past one, since a past
 * year has no "present" to speak of) - every other case is unaffected, so
 * the ~40 read-only callers across the dashboard views that only ever show a
 * PAST period never need to pass it.
 */
export function periodLabel(p: Period, today?: string): string {
  if (p.day) return dayLabel(p.day);
  if (p.mode === "range") {
    if (p.label) return p.label;
    if (!p.from || !p.to) return "—";
    return p.from === p.to ? dayLabel(p.from) : `${dayLabel(p.from)} – ${dayLabel(p.to)}`;
  }
  if (!p.month) return "—";
  if (p.mode === "monthly") return monthLabel(p.month);
  const year = p.month.slice(0, 4);
  if (!today) return year;
  return `${year} (Jan – ${year === today.slice(0, 4) ? "Present" : "Dec"})`;
}

export function dayLabel(d: string): string {
  const [y, m, day] = d.split("-");
  return `${Number(day)} ${MONTH_NAMES[Number(m) - 1] ?? m} ${y}`;
}

/**
 * The days a time-audit warning happened on. A person is flagged on their
 * PERIOD ratio (sum production / sum working); these are the days whose own
 * ratio sits on the same side of the band. Never empty for a flagged person:
 * the period ratio is a working-weighted average of the daily ones. Compared
 * by multiplication, so a day with production but no working minutes counts
 * as over, not as a divide-by-zero.
 */
export function warnDays(days: { date: string; w: number; p: number }[], over: boolean, low: number, high: number): string[] {
  return days
    .filter((d) => (over ? d.p * 100 > d.w * high : d.p * 100 < d.w * low))
    .map((d) => d.date)
    .sort();
}

/** "3 Sep, 5 Sep, 9 Sep +2 more": the first `max` days, year dropped (the period label carries it). */
export function dayList(dates: string[], max = 3): string {
  const shown = dates.slice(0, max).map((d) => dayLabel(d).replace(/ \d{4}$/, ""));
  return shown.join(", ") + (dates.length > max ? ` +${dates.length - max} more` : "");
}

/**
 * The period a view actually reads, from the period in the URL.
 *
 * A BARE URL (nothing picked yet: monthly, no month, no day) opens on TODAY -
 * this month with `day` = today - because the daily check is the common visit
 * (owner 2026-09-22). Every dated figure then narrows to the day via inFocus,
 * while trend charts keep drawing the whole month around it. Clearing the
 * highlight writes the month into the URL, so it stays cleared. If the book
 * has nothing in today's month yet, it opens on the newest month instead,
 * with no day: a highlighted day outside the charted month helps nobody.
 *
 * Overview and Sales are the exception (owner 2026-09-21): they are read by
 * the month, so the shells pass `openOnToday` = false for them (see
 * opensOnToday) and a bare URL resolves to the plain month. A day the user
 * picked themselves is still honoured on every tab.
 *
 * Otherwise an unset or unknown month resolves to the newest month that
 * exists. DERIVED, never synced with an effect.
 */
export function resolvePeriod(period: Period, months: string[], today: string, openOnToday = true): Period {
  const thisMonth = today.slice(0, 7);
  if (period.mode === "monthly" && !period.month && !period.day && months.includes(thisMonth)) {
    return openOnToday ? { mode: "monthly", month: thisMonth, day: today } : { mode: "monthly", month: thisMonth };
  }
  const month = period.month && months.includes(period.month) ? period.month : (months[months.length - 1] ?? "");
  return { ...period, month };
}

/** Tabs whose bare URL opens on the MONTH, not on today. Same keys on desktop and /m. */
const MONTHLY_TABS = new Set(["overview", "sales", "ocr"]);

export function opensOnToday(tab: string | undefined): boolean {
  return !MONTHLY_TABS.has(tab ?? "");
}

// ---- Period picker logic (pure: tests/dashboard-period.test.mjs) ----------
// Shared by the desktop PeriodPicker and the /m PeriodChip so a phone and a
// desktop step, preset and highlight identically.

/** Distinct YYYY years the book has a month in, oldest first. */
export function yearsWithData(months: string[]): string[] {
  return [...new Set(months.map((m) => m.slice(0, 4)))].sort();
}

/**
 * One step of the < > arrows. They move by whatever the mode MEASURES: a year
 * in YTD (landing on the newest month that year has, so YTD covers all of it),
 * otherwise a month - and a range steps back out to a plain month rather than
 * sliding a window whose length nobody asked to keep. Targets are resolved
 * against the months the book actually has; a direction with no data is null.
 */
export function stepPeriod(period: Period, months: string[], dir: -1 | 1): Period | null {
  if (period.mode === "ytd") {
    const years = yearsWithData(months);
    const yi = years.indexOf(period.month.slice(0, 4));
    const target = years[yi + dir];
    if (yi < 0 || !target) return null;
    const last = months.filter((m) => m.startsWith(target)).pop();
    return last ? { mode: "ytd", month: last } : null;
  }
  const next = months[months.indexOf(period.month) + dir];
  return next ? { mode: "monthly", month: next } : null;
}

/**
 * One calendar day, uncapped going back (a past day with nothing sold is a
 * real answer - see periodPresets), never past `maxDay` going forward (an
 * unknowable future day is not). Not bounded to `months` - unlike the month
 * and year steppers, the Day view genuinely means every calendar day, so a
 * gap in the book should show empty rather than be skipped over.
 */
export function stepDay(day: string, delta: number, maxDay: string): string | null {
  const [y, m, d] = day.split("-").map(Number);
  const next = ymd(new Date(y, m - 1, d + delta));
  return next <= maxDay ? next : null;
}

/**
 * Today / Yesterday / Last 7 Days.
 *
 * Today and Yesterday mean the real calendar day - same as `resolvePeriod`'s
 * default-open day, so the picker never claims two different dates are
 * "today". A day with no sales yet shows empty, same as a fresh page load
 * already does; that is a real answer, not a reason to relabel yesterday.
 *
 * Last 7 Days stays anchored to the newest day the book ACTUALLY has, not the
 * end of the newest month (owner 2026-09-21: that made it select Sep 24-30
 * when data stopped on Sep 15, an all-zero window) - a relative multi-day
 * window has no calendar meaning of its own to preserve the way a single
 * named day does.
 */
export function periodPresets(latestDay: string | undefined, months: string[], today: string): { label: string; period: Period }[] {
  const one = (label: string, day: string) => ({ label, period: { mode: "monthly" as const, month: day.slice(0, 7), day } });
  const iso = latestDay || (months.length ? `${months[months.length - 1]}-01` : "");
  if (!iso && !today) return [];
  const last7: { label: string; period: Period }[] = [];
  if (iso) {
    const [y, m, d] = iso.split("-").map(Number);
    const back = (n: number) => ymd(new Date(y, m - 1, d - n));
    const from = back(6);
    last7.push({ label: "Last 7 Days", period: { mode: "range", month: from.slice(0, 7), from, to: back(0), label: "Last 7 Days" } });
  }
  if (!today) return last7;
  const [ty, tm, td] = today.split("-").map(Number);
  const todayBack = (n: number) => ymd(new Date(ty, tm - 1, td - n));
  return [one("Today", todayBack(0)), one("Yesterday", todayBack(1)), ...last7];
}

/** Is this preset the current selection? */
export function presetActive(preset: Period, period: Period): boolean {
  return preset.mode === "range"
    ? period.mode === "range" && period.from === preset.from && period.to === preset.to
    : period.day === preset.day;
}

/**
 * Monday-first calendar cells for YYYY-MM: leading nulls, then each YYYY-MM-DD.
 * Anything that is not a month is [] - the period's month is "" until the feed
 * has loaded, and `Array(NaN)` throws a RangeError that took the whole /m
 * dashboard down on first paint.
 */
export function calendarCells(viewMonth: string): (string | null)[] {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(viewMonth)) return [];
  const [y, m] = viewMonth.split("-").map(Number);
  // JS getDay() is Sunday=0, so shift by one and wrap.
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const days = new Date(y, m, 0).getDate();
  return [
    ...Array<null>(lead).fill(null),
    ...Array.from({ length: days }, (_, i) => `${viewMonth}-${String(i + 1).padStart(2, "0")}`),
  ];
}

/** YYYY-MM moved by `delta` months (a non-month comes back unchanged). */
export function shiftMonth(month: string, delta: number): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return month;
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// True when an ISO-ish date string falls inside the selected period. YTD means
// the whole calendar year the selected month belongs to.
export function inPeriod(p: Period, date: string | null | undefined): boolean {
  if (!date) return false;
  const d = String(date).slice(0, 10);
  if (p.mode === "range") {
    if (!p.from || !p.to) return false;
    return d >= p.from && d <= p.to;
  }
  if (!p.month) return false;
  if (p.mode === "monthly") return d.startsWith(p.month);
  // YTD here means the WHOLE year the selected month sits in (owner
  // 2026-09-15), NOT Jan-through-that-month. Pressing YTD while on April used
  // to cut the window at April and hide May onward, which read as the toggle
  // losing data rather than widening to the year.
  return d.slice(0, 4) === p.month.slice(0, 4);
}

// The comparable previous period: the month before in Monthly, the whole
// previous year in YTD, an equal-length window before a range.
export function previousPeriod(p: Period, months: string[]): Period | null {
  // A range compares against the window of equal length immediately before it,
  // so "last 7 days" is measured against the 7 days before that — not against
  // a calendar month of a different size.
  if (p.mode === "range") {
    if (!p.from || !p.to) return null;
    const from = new Date(p.from + "T00:00:00");
    const to = new Date(p.to + "T00:00:00");
    const days = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
    const prevTo = new Date(from.getTime() - 86400000);
    const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86400000);
    return { mode: "range", month: p.month, from: ymd(prevFrom), to: ymd(prevTo) };
  }
  if (!p.month) return null;
  if (p.mode === "monthly") {
    const i = months.indexOf(p.month);
    return i > 0 ? { mode: "monthly", month: months[i - 1] } : null;
  }
  // Whole previous year against whole current year — a part-year comparison
  // would not match what the window now covers.
  const prevYear = String(Number(p.month.slice(0, 4)) - 1);
  const lastOfPrev = [...months].filter((m) => m.slice(0, 4) === prevYear).pop();
  return lastOfPrev ? { mode: "ytd", month: lastOfPrev } : null;
}

// The rows a "focused" panel should read: the single highlighted day when one
// is picked (chart click or datepicker), otherwise the whole period. Charts
// keep using inPeriod so they still draw the whole month around the highlight.
export function inFocus(p: Period, date: string | null | undefined): boolean {
  if (p.day) return String(date ?? "").slice(0, 10) === p.day;
  return inPeriod(p, date);
}

/**
 * Overall efficiency for the period: total earned production minutes divided
 * by total clocked working minutes (performance.byDay from the prototype
 * route). A weighted total, not an average of each person's %. Null when
 * nobody clocked any time, so the card shows a dash, not 0%. The Employees
 * and Operations overview cards both read this, so they cannot disagree.
 *
 * Days with no clocked production time are skipped entirely. Job cards finish
 * during the day but working hours are entered after it, so today (and any day
 * whose hours are not in yet) carries earned minutes with nothing to divide
 * them by. Counting them pushed the month's figure up (MEASURED 2026-09-25:
 * 95.0% with today's 105.8h of earned time vs 92.9% without).
 */
export function overallEfficiencyPct(
  byDay: readonly { date: string; workingMinutes: number; productionMinutes: number }[],
  p: Period,
): number | null {
  let w = 0;
  let prod = 0;
  for (const d of byDay) {
    if (!inFocus(p, d.date) || d.workingMinutes <= 0) continue;
    w += d.workingMinutes;
    prod += d.productionMinutes;
  }
  return w > 0 ? (prod / w) * 100 : null;
}

// Sub-tab strips live in the page's sticky row (next to the period picker), so
// the keys are shared between the shell and the views.
// Tabs and sub-tabs are named after the FUNCTION, never the person who reads
// them: a chart has one home, and whoever holds the role opens that home.
export const PEOPLE_SUBS = [
  { key: "overview", label: "Overview" },
  { key: "time", label: "Time & attendance" },
  { key: "efficiency", label: "Efficiency" }, // also holds the department ledger (was its own "departments" sub)
] as const;
export const OPS_SUBS = [
  { key: "overview", label: "Overview" },
  { key: "production", label: "Output" },
  { key: "plan", label: "Plan vs Actual" },
  { key: "cost", label: "Revenue & Cost" },
  { key: "materials", label: "Materials" },
] as const;
export type PeopleSub = (typeof PEOPLE_SUBS)[number]["key"];
export type OpsSub = (typeof OPS_SUBS)[number]["key"];
export const SERVICE_SUBS = [
  { key: "overview", label: "Report" },
  { key: "performance", label: "Performance" },
  { key: "overdue", label: "Overdue" },
  { key: "approvals", label: "Approvals" },
  { key: "issues", label: "Top issues" },
] as const;
export type ServiceSub = (typeof SERVICE_SUBS)[number]["key"];
export const FIN_SUBS = [
  { key: "perhead", label: "Per head" },
  { key: "returns", label: "Returns & balance sheet" },
  { key: "outlook", label: "Outlook & P/E" },
] as const;
export type FinSub = (typeof FIN_SUBS)[number]["key"];
