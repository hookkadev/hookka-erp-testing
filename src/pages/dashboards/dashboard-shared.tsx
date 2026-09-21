import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import type { LucideIcon } from "lucide-react";
import {
  CHART_AXIS, monthLabel, periodLabel, ymd, stepPeriod, periodPresets, presetActive, calendarCells, shiftMonth,
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

// `Sep 2026 ▾` — opens a popover with a calendar and the common presets.
// At phone width (`phone`) the same content opens as a BOTTOM SHEET instead,
// with `controls` (Monthly/YTD + stepper) on top, so the whole period control
// is one 44px button in the header. The sheet is portalled to <body>: the
// page's sticky header has backdrop-blur, and a backdrop-filter ancestor
// becomes the containing block of `position: fixed` — inside it the sheet
// would be pinned to the header, not the screen.
function DateTrigger({
  period,
  months,
  latestDay,
  onChange,
  phone,
  controls,
}: {
  period: Period;
  months: string[];
  latestDay?: string;
  onChange: (p: Period) => void;
  phone: boolean;
  controls: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(period.month);
  const wrapRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  // The sheet's stepper changes period.month while it is open; the calendar
  // follows (state adjusted during render, not in an effect).
  const [seenMonth, setSeenMonth] = useState(period.month);
  if (seenMonth !== period.month) {
    setSeenMonth(period.month);
    setViewMonth(period.month);
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

  const todayIso = ymd(new Date());

  const presets = useMemo(() => periodPresets(latestDay, months), [latestDay, months]);

  // One click HIGHLIGHTS that day: the period stays on the day's month so the
  // trend chart still draws the whole month, and `day` narrows the KPI row and
  // the lists — exactly what clicking a bar in the chart does. Selecting a
  // range here would have collapsed the chart to a single bar.
  const pick = (day: string) => {
    onChange({ mode: "monthly", month: day.slice(0, 7), day });
    setOpen(false);
  };

  const stepView = (delta: number) => setViewMonth(shiftMonth(viewMonth, delta));

  const body = (
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
          onClick={() => {
            onChange({ mode: "monthly", month: viewMonth });
            setOpen(false);
          }}
          className="mt-1 rounded-md border border-[#E5E0D8] px-2 py-1 text-[11px] font-medium text-[#6B5C32] hover:bg-[#F7F5F3] max-md:mt-0 max-md:h-11 max-md:px-4 max-md:text-sm"
        >
          Whole month
        </button>
      </div>

      <div className="w-56 max-md:w-full">
        {/* Phone, monthly: the sheet's stepper above already walks months and
            the calendar follows it - a second "< Sep 2026 >" row under it read
            as a duplicate. YTD keeps it (the stepper walks YEARS there). */}
        <div className={"flex items-center justify-between pb-1.5" + (phone && period.mode !== "ytd" ? " hidden" : "")}>
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

  return (
    <div className="md:relative max-md:shrink-0" ref={wrapRef}>
      <button
        type="button"
        onClick={() => {
          // Re-anchor the calendar on the selected month each time it opens.
          // Done here rather than in an effect — an effect that setStates on
          // `open` costs an extra render every time the popover toggles.
          if (!open) setViewMonth(period.month);
          setOpen(!open);
        }}
        aria-expanded={open}
        className={
          "flex items-center gap-1 rounded-md border px-2.5 py-1 max-md:h-11 max-md:gap-1.5 max-md:px-3 max-md:whitespace-nowrap text-sm font-medium tabular-nums transition-colors " +
          (open
            ? "border-[#6B5C32] bg-white text-[#1F1D1B]"
            : "border-transparent max-md:border-[#E2DDD8] max-md:bg-white text-[#1F1D1B] hover:bg-[#F0ECE9]")
        }
      >
        <CalendarDays className="h-4 w-4 md:hidden" style={{ color: CHART_AXIS }} />
        {periodLabel(period)}
        <ChevronDown className="h-3.5 w-3.5" style={{ color: CHART_AXIS }} />
      </button>

      {open && !phone && (
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

// The dashboard's global period selector — Monthly/YTD, a month stepper
// bounded by the months that actually exist in the book, and Today (jump to
// the newest month). Rendered once, above the tabs.
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
  const prev = stepPeriod(period, months, -1);
  const next = stepPeriod(period, months, 1);
  const phone = useMediaQuery("(max-width: 767px)");
  const trigger = (controls: ReactNode) => (
    <DateTrigger period={period} months={months} latestDay={latestDay} onChange={onChange} phone={phone} controls={controls} />
  );
  const arrow = (dir: "Previous" | "Next", to: Period | null) => (
    <button
      type="button"
      aria-label={`${dir} ${period.mode === "ytd" ? "year" : "month"}`}
      disabled={!to}
      onClick={() => to && onChange(to)}
      className="h-7 w-7 max-md:h-11 max-md:w-11 grid place-items-center rounded-md border border-[#E2DDD8] text-[#6B7280] disabled:opacity-40 hover:bg-[#F7F5F3]"
    >
      {dir === "Previous" ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
    </button>
  );
  // Segmented control: the ACTIVE half carries its own border + white fill so
  // which mode is on is readable at a glance — a background tint alone was too
  // faint to tell apart on this cream page.
  const modes = (
    <div className="flex gap-0.5 rounded-lg border border-[#E2DDD8] bg-[#F7F5F3] p-0.5 max-md:grid max-md:grid-cols-2">
      {(["monthly", "ytd"] as const).map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={period.mode === m}
          onClick={() => onChange({ ...period, mode: m })}
          className={
            "px-3 py-1 max-md:h-11 max-md:text-sm text-xs font-medium rounded-md border transition-colors " +
            (period.mode === m
              ? "bg-white border-[#6B5C32] text-[#1F1D1B] shadow-sm"
              : "bg-transparent border-transparent text-[#6B7280] hover:bg-white/60")
          }
        >
          {m === "monthly" ? "Monthly" : "YTD"}
        </button>
      ))}
    </div>
  );

  // Phone: the whole control is ONE button; Monthly/YTD and the stepper move
  // into the sheet it opens.
  if (phone) {
    return trigger(
      <>
        {modes}
        <div className="flex items-center justify-between gap-2">
          {arrow("Previous", prev)}
          <span className="text-sm font-semibold tabular-nums text-[#1F1D1B]">{periodLabel({ ...period, day: undefined })}</span>
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
  icon: Icon,
  iconBgClass,
  iconColorClass,
  valueColorClass,
  valueSizeClass,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: LucideIcon;
  iconBgClass: string;
  iconColorClass: string;
  valueColorClass?: string;
  valueSizeClass?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4 max-md:p-3 flex items-center gap-3 max-md:gap-2">
        <div className={cn("rounded-lg p-2.5 shrink-0 max-[420px]:hidden", iconBgClass)}>
          <Icon className={cn("h-5 w-5", iconColorClass)} />
        </div>
        <div className="min-w-0">
          <p
            className={cn(
              "font-bold truncate tabular-nums max-md:text-xl",
              valueSizeClass ?? "text-2xl",
              valueColorClass ?? "text-[#1F1D1B]",
            )}
          >
            {value}
          </p>
          <p className="text-xs text-[#6B7280]">{label}</p>
          {sub && <p className="text-xs text-[#6B7280]">{sub}</p>}
        </div>
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
