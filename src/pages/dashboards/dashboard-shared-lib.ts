// Shared constants/helpers for the dashboard-prototype tabs — split out of
// dashboard-shared.tsx because a file mixing component exports with
// constant/function exports breaks Vite Fast Refresh (react-refresh/only-
// export-components).
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

export function periodLabel(p: Period): string {
  if (p.day) return dayLabel(p.day);
  if (p.mode === "range") {
    if (p.label) return p.label;
    if (!p.from || !p.to) return "—";
    return p.from === p.to ? dayLabel(p.from) : `${dayLabel(p.from)} – ${dayLabel(p.to)}`;
  }
  if (!p.month) return "—";
  // The year alone — the window IS the year, so "2026 YTD" would claim a
  // cut-off that no longer exists.
  return p.mode === "monthly" ? monthLabel(p.month) : p.month.slice(0, 4);
}

export function dayLabel(d: string): string {
  const [y, m, day] = d.split("-");
  return `${Number(day)} ${MONTH_NAMES[Number(m) - 1] ?? m} ${y}`;
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

// Sub-tab strips live in the page's sticky row (next to the period picker), so
// the keys are shared between the shell and the views.
export const EMP_SUBS = [
  { key: "overview", label: "Overview" },
  { key: "time", label: "Time & attendance" },
  { key: "efficiency", label: "Efficiency" },
] as const;
export const SITI_SUBS = [
  { key: "overview", label: "Overview" },
  { key: "production", label: "Production" },
  { key: "cost", label: "Cost" },
  { key: "materials", label: "Materials" },
] as const;
export const LIM_SUBS = [
  { key: "efficiency", label: "Efficiency" },
  { key: "plan", label: "Plan vs Actual" },
  { key: "attendance", label: "Attendance" },
  { key: "revenue", label: "Production revenue" },
  { key: "overdue", label: "Overdue" },
] as const;
export type LimSub = (typeof LIM_SUBS)[number]["key"];
export type EmpSub = (typeof EMP_SUBS)[number]["key"];
export type SitiSub = (typeof SITI_SUBS)[number]["key"];
export const SERVICE_SUBS = [
  { key: "overview", label: "Report" },
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
