import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { CHART_AXIS, monthLabel, periodLabel, ymd, type Period } from "./dashboard-shared-lib";

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
  const [y, m] = viewMonth.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  // Monday-first: JS getDay() is Sunday=0, so shift by one and wrap.
  const lead = (first.getDay() + 6) % 7;

  const cells: (string | null)[] = [
    ...Array<null>(lead).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) =>
      `${y}-${String(m).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`,
    ),
  ];

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
          if (!day) return <div key={`pad-${i}`} className="h-7" />;
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
                "h-7 rounded-md text-[11px] tabular-nums transition-colors " +
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
function DateTrigger({
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
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(period.month);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape, so the popover behaves like every other
  // dropdown in the app.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
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

  // Presets anchor to the newest day the book ACTUALLY has, not to the machine
  // clock and not to the end of the newest month. Anchoring to the month end
  // made "Last 7 Days" select Sep 24-30 when the data stopped on Sep 15, so
  // every preset returned zero rows.
  const latest = useMemo(() => {
    const iso = latestDay || (months.length ? `${months[months.length - 1]}-01` : "");
    if (!iso) return null;
    const [ly, lm, ld] = iso.split("-").map(Number);
    return new Date(ly, lm - 1, ld);
  }, [latestDay, months]);

  const presets = useMemo(() => {
    if (!latest) return [];
    const d = (n: number) => new Date(latest.getTime() - n * 86400000);
    return [
      { label: "Today", from: ymd(latest), to: ymd(latest) },
      { label: "Yesterday", from: ymd(d(1)), to: ymd(d(1)) },
      { label: "Last 7 Days", from: ymd(d(6)), to: ymd(latest) },
    ];
  }, [latest]);

  // One click HIGHLIGHTS that day: the period stays on the day's month so the
  // trend chart still draws the whole month, and `day` narrows the KPI row and
  // the lists — exactly what clicking a bar in the chart does. Selecting a
  // range here would have collapsed the chart to a single bar.
  const pick = (day: string) => {
    onChange({ mode: "monthly", month: day.slice(0, 7), day });
    setOpen(false);
  };

  const stepView = (delta: number) => {
    const [vy, vm] = viewMonth.split("-").map(Number);
    const next = new Date(vy, vm - 1 + delta, 1);
    setViewMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`);
  };

  return (
    <div className="relative" ref={wrapRef}>
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
          "flex items-center gap-1 rounded-md border px-2.5 py-1 text-sm font-medium tabular-nums transition-colors " +
          (open
            ? "border-[#6B5C32] bg-white text-[#1F1D1B]"
            : "border-transparent text-[#1F1D1B] hover:bg-[#F0ECE9]")
        }
      >
        {periodLabel(period)}
        <ChevronDown className="h-3.5 w-3.5" style={{ color: CHART_AXIS }} />
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1 flex gap-3 rounded-lg border border-[#E5E0D8] bg-white p-3 shadow-lg">
          <div className="flex flex-col gap-1 w-28 shrink-0">
            <p className="text-[10px] uppercase tracking-wide pb-0.5" style={{ color: CHART_AXIS }}>
              Presets
            </p>
            {presets.map((p) => {
              const on =
                p.from === p.to
                  ? period.day === p.from
                  : period.mode === "range" && period.from === p.from && period.to === p.to;
              return (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    onChange(
                      p.from === p.to
                        ? // One day: stay on that day's MONTH and highlight it,
                          // so the trend still draws the whole month and
                          // clearing the highlight returns to it.
                          { mode: "monthly", month: p.from.slice(0, 7), day: p.from }
                        : // A real multi-day window genuinely re-scopes the
                          // chart, and carries no day highlight of its own.
                          {
                            mode: "range",
                            month: p.from.slice(0, 7),
                            from: p.from,
                            to: p.to,
                            label: p.label,
                          },
                    );
                    setOpen(false);
                  }}
                  className={
                    "rounded-md px-2 py-1 text-left text-[11px] font-medium " +
                    (on ? "bg-[#6B5C32] text-white" : "text-[#1F1D1B] hover:bg-[#F7F5F3]")
                  }
                >
                  {p.label}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => {
                onChange({ mode: "monthly", month: viewMonth });
                setOpen(false);
              }}
              className="mt-1 rounded-md border border-[#E5E0D8] px-2 py-1 text-[11px] font-medium text-[#6B5C32] hover:bg-[#F7F5F3]"
            >
              Whole month
            </button>
          </div>

          <div className="w-56">
            <div className="flex items-center justify-between pb-1.5">
              <button
                type="button"
                aria-label="Previous month"
                onClick={() => stepView(-1)}
                className="h-6 w-6 grid place-items-center rounded-md hover:bg-[#F7F5F3]"
                style={{ color: CHART_AXIS }}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-xs font-medium text-[#1F1D1B]">{monthLabel(viewMonth)}</span>
              <button
                type="button"
                aria-label="Next month"
                onClick={() => stepView(1)}
                className="h-6 w-6 grid place-items-center rounded-md hover:bg-[#F7F5F3]"
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
              Click a day to see just that day · future dates are disabled
            </p>
          </div>
        </div>
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
  const idx = months.indexOf(period.month);

  // The steppers move by whatever the current mode MEASURES. In YTD that is a
  // year: stepping by month there looked broken, because "2026 YTD" reads the
  // same after a month-sized step and only changes once it happens to cross a
  // year boundary. Each target is resolved against the months the book actually
  // has, so a direction with no data is dead rather than landing on an empty
  // window (this book holds 2025 and 2026 only — forward from 2026 is dead).
  const step = (dir: -1 | 1): Period | null => {
    if (period.mode === "ytd") {
      const years = [...new Set(months.map((m) => m.slice(0, 4)))].sort();
      const yi = years.indexOf(period.month.slice(0, 4));
      const target = years[yi + dir];
      if (yi < 0 || !target) return null;
      // Land on the newest month that year has, so YTD covers all of it.
      const last = [...months].filter((m) => m.startsWith(target)).pop();
      return last ? { mode: "ytd", month: last } : null;
    }
    // Monthly — and a range, which steps back out to a plain month rather than
    // sliding a window whose length nobody asked to keep.
    const next = months[idx + dir];
    return next ? { mode: "monthly", month: next } : null;
  };

  const prev = step(-1);
  const next = step(1);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Segmented control: the ACTIVE half carries its own border + white
          fill so which mode is on is readable at a glance — a background tint
          alone was too faint to tell apart on this cream page. */}
      <div className="flex gap-0.5 rounded-lg border border-[#E2DDD8] bg-[#F7F5F3] p-0.5">
        {(["monthly", "ytd"] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={period.mode === m}
            onClick={() => onChange({ ...period, mode: m })}
            className={
              "px-3 py-1 text-xs font-medium rounded-md border transition-colors " +
              (period.mode === m
                ? "bg-white border-[#6B5C32] text-[#1F1D1B] shadow-sm"
                : "bg-transparent border-transparent text-[#6B7280] hover:bg-white/60")
            }
          >
            {m === "monthly" ? "Monthly" : "YTD"}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={period.mode === "ytd" ? "Previous year" : "Previous month"}
          disabled={!prev}
          onClick={() => prev && onChange(prev)}
          className="h-7 w-7 grid place-items-center rounded-md border border-[#E2DDD8] text-[#6B7280] disabled:opacity-40 hover:bg-[#F7F5F3]"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <DateTrigger period={period} months={months} latestDay={latestDay} onChange={onChange} />
        <button
          type="button"
          aria-label={period.mode === "ytd" ? "Next year" : "Next month"}
          disabled={!next}
          onClick={() => next && onChange(next)}
          className="h-7 w-7 grid place-items-center rounded-md border border-[#E2DDD8] text-[#6B7280] disabled:opacity-40 hover:bg-[#F7F5F3]"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
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
      <CardContent className="p-4 flex items-center gap-3">
        <div className={cn("rounded-lg p-2.5 shrink-0", iconBgClass)}>
          <Icon className={cn("h-5 w-5", iconColorClass)} />
        </div>
        <div className="min-w-0">
          <p
            className={cn(
              "font-bold truncate tabular-nums",
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
