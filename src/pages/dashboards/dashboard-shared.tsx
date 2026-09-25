import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Info, TrendingDown, TrendingUp } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import {
  CHART_AXIS, monthLabel, periodLabel, ymd, stepPeriod, stepDay, yearsWithData, periodPresets, presetActive,
  calendarCells, shiftMonth,
  type Period,
} from "./dashboard-shared-lib";

// Shared components for the dashboard-prototype tabs (SalesOrdersView + the
// ones ported from it) — one Kpi card, one badge, one "missing" note, so the
// six tabs read as one dashboard instead of six independently-styled pages.
// Constants/formatters live in ./dashboard-shared-lib (kept out of this file
// so Fast Refresh keeps working — see that file's header comment).

export function LiveBadge({ live }: { live: boolean }) {
  return (
    <Badge
      className={
        live
          ? "bg-[#EEF3E4] text-[#4F7C3A] border-[#EEF3E4]"
          : "bg-[#FDF3E4] text-[#B5701A] border-[#FDF3E4]"
      }
    >
      {live ? "live" : "not live"}
    </Badge>
  );
}

// Month grid for the datepicker popover. Built here rather than pulling in
// react-day-picker + a popover library: this needs one month view, a range
// selection and four presets, which is less code than the wiring those would
// take — and it inherits the dashboard's tokens for free.
function CalendarGrid({
  viewMonth,
  from,
  to,
  maxDate,
  onPick,
}: {
  viewMonth: string;
  from?: string;
  to?: string;
  maxDate: string;
  onPick: (day: string) => void;
}) {
  const cells = calendarCells(viewMonth);

  return (
    <div>
      <div className="grid grid-cols-7 gap-0.5 mb-1">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <div key={i} className="h-6 grid place-items-center text-[10px]" style={{ color: CHART_AXIS }}>
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((day, i) => {
          if (!day) return <div key={`pad-${i}`} className="h-7 max-md:h-11" />;
          const isFrom = day === from;
          const isTo = day === to;
          const inRange = !!from && !!to && day > from && day < to;
          const selected = isFrom || isTo;
          // A future day is unknown, not empty — it cannot be reported on, so
          // it is hard-disabled. A PAST day with no sales stays fully
          // selectable: "nothing sold that day" is a real, useful answer.
          const future = day > maxDate;
          return (
            <button
              key={day}
              type="button"
              disabled={future}
              aria-disabled={future}
              title={future ? "Future date" : undefined}
              onClick={() => !future && onPick(day)}
              className={
                "h-7 max-md:h-11 rounded-md text-[11px] max-md:text-sm tabular-nums transition-colors " +
                (future
                  ? "text-[#C9C2B6] cursor-not-allowed"
                  : selected
                    ? "bg-[#6B5C32] text-white font-semibold"
                    : inRange
                      ? "bg-[#F0ECE9] text-[#1F1D1B]"
                      : "text-[#1F1D1B] hover:bg-[#F7F5F3]")
              }
            >
              {Number(day.slice(8))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// 12-cell grid for the Month view's popover - "click opens a month/year
// picker" (redesign spec). Only months the book has data for are pickable,
// the same bound the < > stepper already uses, so the grid can never suggest
// a jump the stepper wouldn't also allow.
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function MonthGrid({
  viewYear,
  months,
  current,
  onPick,
}: {
  viewYear: string;
  months: string[];
  current: string;
  onPick: (month: string) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-1">
      {MONTH_SHORT.map((label, i) => {
        const m = `${viewYear}-${String(i + 1).padStart(2, "0")}`;
        const has = months.includes(m);
        const selected = m === current;
        return (
          <button
            key={m}
            type="button"
            disabled={!has}
            title={has ? undefined : "No data this month"}
            onClick={() => has && onPick(m)}
            className={
              "h-9 max-md:h-11 rounded-md text-xs max-md:text-sm font-medium transition-colors " +
              (!has
                ? "text-[#C9C2B6] cursor-not-allowed"
                : selected
                  ? "bg-[#6B5C32] text-white font-semibold"
                  : "text-[#1F1D1B] hover:bg-[#F7F5F3]")
            }
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// The date trigger + its popover. What the popover CONTAINS depends on
// `view`: Day gets the day calendar + presets (jump to any date), Month gets
// a year/month grid (jump to any month with data), YTD gets neither - the
// arrows next to it already cover everything a year selector needs.
//
// At phone width (`phone`) the same content opens as a BOTTOM SHEET instead,
// with `controls` (the Day/Month/YTD toggle + arrows) on top, so the whole
// period control is one 44px button in the header. The sheet is portalled to
// <body>: the page's sticky header has backdrop-blur, and a backdrop-filter
// ancestor becomes the containing block of `position: fixed` — inside it the
// sheet would be pinned to the header, not the screen.
function DateTrigger({
  period,
  months,
  latestDay,
  todayIso,
  view,
  onChange,
  phone,
  controls,
}: {
  period: Period;
  months: string[];
  latestDay?: string;
  todayIso: string;
  view: "day" | "month" | "ytd";
  onChange: (p: Period) => void;
  phone: boolean;
  controls: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(period.month);
  const [viewYear, setViewYear] = useState(period.month.slice(0, 4));
  const wrapRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  // The outer arrows / presets change period.month while the popover is
  // open; its own browse state follows (adjusted during render, not in an
  // effect).
  const [seenMonth, setSeenMonth] = useState(period.month);
  if (seenMonth !== period.month) {
    setSeenMonth(period.month);
    setViewMonth(period.month);
    setViewYear(period.month.slice(0, 4));
  }

  // Close on outside click / Escape, so the popover behaves like every other
  // dropdown in the app.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || sheetRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const presets = useMemo(() => periodPresets(latestDay, months, todayIso), [latestDay, months, todayIso]);
  const years = useMemo(() => yearsWithData(months), [months]);

  // One click HIGHLIGHTS that day: the period stays on the day's month so the
  // trend chart still draws the whole month, and `day` narrows the KPI row and
  // the lists — exactly what clicking a bar in the chart does. Selecting a
  // range here would have collapsed the chart to a single bar.
  const pick = (day: string) => {
    onChange({ mode: "monthly", month: day.slice(0, 7), day });
    setOpen(false);
  };
  const pickMonth = (month: string) => {
    onChange({ mode: "monthly", month, day: undefined });
    setOpen(false);
  };

  const stepView = (delta: number) => setViewMonth(shiftMonth(viewMonth, delta));
  const yi = years.indexOf(viewYear);
  const stepViewYear = (delta: number) => {
    const target = years[yi + delta];
    if (target) setViewYear(target);
  };

  const dayBody = (
    <>
      <div className="flex flex-col gap-1 w-28 shrink-0 max-md:w-full max-md:flex-row max-md:flex-wrap max-md:items-center max-md:gap-2">
        <p className="text-[10px] uppercase tracking-wide pb-0.5 max-md:w-full" style={{ color: CHART_AXIS }}>
          Presets
        </p>
        {presets.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => {
              onChange(p.period);
              setOpen(false);
            }}
            className={
              "rounded-md px-2 py-1 text-left text-[11px] font-medium max-md:h-11 max-md:px-4 max-md:text-sm max-md:border max-md:border-[#E5E0D8] " +
              (presetActive(p.period, period) ? "bg-[#6B5C32] text-white" : "text-[#1F1D1B] hover:bg-[#F7F5F3]")
            }
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => pickMonth(viewMonth)}
          className="mt-1 rounded-md border border-[#E5E0D8] px-2 py-1 text-[11px] font-medium text-[#6B5C32] hover:bg-[#F7F5F3] max-md:mt-0 max-md:h-11 max-md:px-4 max-md:text-sm"
        >
          Whole month
        </button>
      </div>

      <div className="w-56 max-md:w-full">
        <div className="flex items-center justify-between pb-1.5">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => stepView(-1)}
            className="h-6 w-6 max-md:h-11 max-md:w-11 grid place-items-center rounded-md hover:bg-[#F7F5F3]"
            style={{ color: CHART_AXIS }}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-xs max-md:text-sm font-medium text-[#1F1D1B]">{monthLabel(viewMonth)}</span>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => stepView(1)}
            className="h-6 w-6 max-md:h-11 max-md:w-11 grid place-items-center rounded-md hover:bg-[#F7F5F3]"
            style={{ color: CHART_AXIS }}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <CalendarGrid
          viewMonth={viewMonth}
          from={period.day ?? period.from}
          to={period.day ?? period.to}
          maxDate={todayIso}
          onPick={pick}
        />
        <p className="pt-1.5 text-[10px]" style={{ color: CHART_AXIS }}>
          {phone ? "Tap" : "Click"} a day to see just that day · future dates are disabled
        </p>
      </div>
    </>
  );

  const monthBody = (
    <div className="w-48 max-md:w-full">
      <div className="flex items-center justify-between pb-1.5">
        <button
          type="button"
          aria-label="Previous year"
          disabled={!years[yi - 1]}
          onClick={() => stepViewYear(-1)}
          className="h-6 w-6 max-md:h-11 max-md:w-11 grid place-items-center rounded-md hover:bg-[#F7F5F3] disabled:opacity-40"
          style={{ color: CHART_AXIS }}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-xs max-md:text-sm font-medium text-[#1F1D1B]">{viewYear}</span>
        <button
          type="button"
          aria-label="Next year"
          disabled={!years[yi + 1]}
          onClick={() => stepViewYear(1)}
          className="h-6 w-6 max-md:h-11 max-md:w-11 grid place-items-center rounded-md hover:bg-[#F7F5F3] disabled:opacity-40"
          style={{ color: CHART_AXIS }}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <MonthGrid viewYear={viewYear} months={months} current={period.month} onPick={pickMonth} />
      <p className="pt-1.5 text-[10px]" style={{ color: CHART_AXIS }}>
        {phone ? "Tap" : "Click"} a month to jump to it · months with no data are disabled
      </p>
    </div>
  );

  // YTD has nothing to click into - the arrows next to the trigger already
  // cover every move a year selector needs.
  const body = view === "day" ? dayBody : view === "month" ? monthBody : null;
  const clickable = view !== "ytd";

  return (
    <div className="md:relative max-md:shrink-0" ref={wrapRef}>
      <button
        type="button"
        onClick={() => {
          if (!phone && !clickable) return;
          // Re-anchor the popover on the selected month/year each time it
          // opens. Done here rather than in an effect — an effect that
          // setStates on `open` costs an extra render every toggle.
          if (!open) {
            setViewMonth(period.month);
            setViewYear(period.month.slice(0, 4));
          }
          setOpen(!open);
        }}
        aria-expanded={open}
        className={
          "flex items-center gap-1 rounded-md border px-2.5 py-1 max-md:h-11 max-md:gap-1.5 max-md:px-3 max-md:whitespace-nowrap text-sm font-medium tabular-nums transition-colors " +
          (open
            ? "border-[#6B5C32] bg-white text-[#1F1D1B]"
            : "border-transparent max-md:border-[#E2DDD8] max-md:bg-white text-[#1F1D1B] " +
              (clickable ? "hover:bg-[#F0ECE9]" : "max-md:cursor-default"))
        }
      >
        <CalendarDays className="h-4 w-4 md:hidden" style={{ color: CHART_AXIS }} />
        {periodLabel(period, todayIso)}
        {clickable && <ChevronDown className="h-3.5 w-3.5" style={{ color: CHART_AXIS }} />}
      </button>

      {open && !phone && body && (
        <div className="absolute right-0 z-50 mt-1 flex gap-3 rounded-lg border border-[#E5E0D8] bg-white p-3 shadow-lg">
          {body}
        </div>
      )}
      {open && phone && createPortal(
        <div className="fixed inset-0 z-[100] flex items-end bg-black/40" onClick={() => setOpen(false)}>
          <div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-label="Period"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-h-[88dvh] overflow-y-auto rounded-t-2xl bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] flex flex-col gap-4"
          >
            <div className="flex items-center justify-between">
              <p className="text-base font-semibold text-[#1F1D1B]">Period</p>
              <button type="button" onClick={() => setOpen(false)} className="h-11 px-3 -mr-2 text-sm font-semibold text-[#6B5C32]">
                Done
              </button>
            </div>
            {controls}
            {body}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/** A single highlighted day stepped by one calendar day, or null past `maxDay` / with no day set. */
function dayNeighbour(day: string | undefined, delta: number, maxDay: string): Period | null {
  if (!day) return null;
  const nd = stepDay(day, delta, maxDay);
  return nd ? { mode: "monthly", month: nd.slice(0, 7), day: nd } : null;
}

// The dashboard's global period selector: Day / Month / YTD, arrows that step
// by whatever the active view measures, and a trigger whose popover matches
// (a day calendar, a month/year grid, or nothing for YTD). Rendered once,
// above the tabs.
export function PeriodPicker({
  period,
  months,
  latestDay,
  onChange,
}: {
  period: Period;
  months: string[];
  latestDay?: string;
  onChange: (p: Period) => void;
}) {
  const todayIso = ymd(new Date());
  const phone = useMediaQuery("(max-width: 767px)");

  // Which of the three views the CURRENT period reads as. A range preset
  // (Last 7 Days) has no calendar identity of its own to hold a tab for - it
  // displays and steps like a specific dated window, closest to Day.
  const view: "day" | "month" | "ytd" =
    period.mode === "ytd" ? "ytd" : period.mode === "range" || period.day ? "day" : "month";

  const setView = (v: "day" | "month" | "ytd") => {
    if (v === view) return;
    if (v === "ytd") { onChange({ mode: "ytd", month: period.month }); return; }
    if (v === "month") { onChange({ mode: "monthly", month: period.month, day: undefined }); return; }
    const day = period.day ?? todayIso;
    onChange({ mode: "monthly", month: day.slice(0, 7), day });
  };

  // A single highlighted day steps by calendar day; a range (Last 7 Days)
  // keeps the legacy "step exits to the neighbouring month" behaviour, since
  // stepping a 7-day window "by 1 day" has no one clear meaning. Month and
  // YTD are unchanged - they step by whatever they measure, bounded to the
  // months/years the book actually has.
  const singleDay = view === "day" && period.mode === "monthly" && !!period.day;
  const prev = singleDay ? dayNeighbour(period.day, -1, todayIso) : stepPeriod(period, months, -1);
  const next = singleDay ? dayNeighbour(period.day, 1, todayIso) : stepPeriod(period, months, 1);

  const trigger = (controls: ReactNode) => (
    <DateTrigger
      period={period}
      months={months}
      latestDay={latestDay}
      todayIso={todayIso}
      view={view}
      onChange={onChange}
      phone={phone}
      controls={controls}
    />
  );
  const arrow = (dir: "Previous" | "Next", to: Period | null) => (
    <button
      type="button"
      aria-label={`${dir} ${view}`}
      disabled={!to}
      onClick={() => to && onChange(to)}
      className="h-7 w-7 max-md:h-11 max-md:w-11 grid place-items-center rounded-md border border-[#E2DDD8] text-[#6B7280] disabled:opacity-40 hover:bg-[#F7F5F3]"
    >
      {dir === "Previous" ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
    </button>
  );
  // Segmented control: the ACTIVE third carries its own border + white fill so
  // which view is on is readable at a glance — a background tint alone was too
  // faint to tell apart on this cream page.
  const modes = (
    <div className="flex gap-0.5 rounded-lg border border-[#E2DDD8] bg-[#F7F5F3] p-0.5 max-md:grid max-md:grid-cols-3">
      {(["day", "month", "ytd"] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={view === v}
          onClick={() => setView(v)}
          className={
            "px-3 py-1 max-md:h-11 max-md:text-sm text-xs font-medium rounded-md border transition-colors " +
            (view === v
              ? "bg-white border-[#6B5C32] text-[#1F1D1B] shadow-sm"
              : "bg-transparent border-transparent text-[#6B7280] hover:bg-white/60")
          }
        >
          {v === "day" ? "Day" : v === "month" ? "Month" : "YTD"}
        </button>
      ))}
    </div>
  );

  // Phone: the whole control is ONE button; the Day/Month/YTD toggle and the
  // stepper move into the sheet it opens.
  if (phone) {
    return trigger(
      <>
        {modes}
        <div className="flex items-center justify-between gap-2">
          {arrow("Previous", prev)}
          <span className="text-sm font-semibold tabular-nums text-[#1F1D1B]">
            {periodLabel(view === "day" ? period : { ...period, day: undefined }, todayIso)}
          </span>
          {arrow("Next", next)}
        </div>
      </>,
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {modes}
      <div className="flex items-center gap-1">
        {arrow("Previous", prev)}
        {trigger(null)}
        {arrow("Next", next)}
      </div>
    </div>
  );
}

// A tab whose figures are a point-in-time snapshot says so, rather than
// letting the period picker above it imply a filter it does not apply.
export function SnapshotNote({ what }: { what: string }) {
  return (
    <p className="text-xs text-[#6B7280]">
      {what} is a point-in-time snapshot — the period selector above does not
      filter it.
    </p>
  );
}

export function Kpi({
  label,
  value,
  sub,
  valueColorClass,
  valueSizeClass,
  hint,
  children,
}: {
  label: string;
  value: string;
  sub?: string;
  valueColorClass?: string;
  valueSizeClass?: string;
  /** Scope / definition note, shown on hover of an info icon next to the label. */
  hint?: string;
  /** Extra content under the sub line (e.g. a baseline bar). */
  children?: ReactNode;
}) {
  // Label on top, big value, then the sub line. A "+x% / -x%" delta sub is a
  // green / red pill; any other sub is plain text so it can wrap, not truncate.
  const delta = sub ? /^[+-]/.test(sub) : false;
  const down = sub?.startsWith("-");
  const Trend = down ? TrendingDown : TrendingUp;
  return (
    <Card>
      <CardContent className="p-4 max-md:p-3 min-w-0">
        <p className="text-xs text-[#6B7280] truncate">
          {label}
          {hint && (
            <span title={hint} aria-label={hint} role="img" className="ml-1 inline-flex align-[-2px] cursor-help">
              <Info className="h-3 w-3" />
            </span>
          )}
        </p>
        <p
          className={cn(
            "mt-1 font-bold truncate tabular-nums max-md:text-xl",
            valueSizeClass ?? "text-2xl",
            valueColorClass ?? "text-[#1F1D1B]",
          )}
        >
          {value}
        </p>
        {sub &&
          (delta ? (
            <span
              className={cn(
                "mt-2 inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium",
                down ? "bg-[#F9E5E1] text-[#B3452F]" : "bg-[#EEF3E4] text-[#4F7C3A]",
              )}
            >
              <Trend className="h-3 w-3 shrink-0" />
              <span className="truncate">{sub}</span>
            </span>
          ) : (
            <p className="mt-1 text-xs text-[#6B7280]">{sub}</p>
          ))}
        {children}
      </CardContent>
    </Card>
  );
}

// A section whose live source isn't wired says so instead of rendering a
// zero that looks like a measurement — mirrors availability.<section>.missing
// from GET /api/dashboard/prototype.
export function MissingNote({ fields }: { fields: string[] }) {
  if (fields.length === 0) return null;
  return (
    <p className="text-xs text-[#9C6F1E]">
      Not available yet: {fields.join(", ")}.
    </p>
  );
}
