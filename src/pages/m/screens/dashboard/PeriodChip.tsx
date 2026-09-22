// Header period chip ("Sep 2026 ▾") + the bottom sheet it opens. The sheet has
// what the desktop PeriodPicker has - a Day / Month / YTD toggle, a < >
// stepper that moves by whatever view is active, the Today / Yesterday /
// Last 7 Days presets (Day view) or a month/year grid (Month view), and
// shares its logic (dashboard-shared-lib: stepPeriod, stepDay,
// yearsWithData, periodPresets, calendarCells), so a phone and a desktop
// select identical windows.
//
// A phone NEVER sees the desktop picker: DashboardLayout redirects mobile
// devices to /m, so this chip is the only period control an iPhone gets.
import { useState } from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import {
  calendarCells, monthLabel, periodLabel, periodPresets, presetActive, shiftMonth, stepDay, stepPeriod,
  yearsWithData, ymd,
  type Period,
} from "../../../dashboards/dashboard-shared-lib";
import { Sheet } from "../../components";
import { M } from "../../theme";

const TAP = { cursor: "pointer", WebkitTapHighlightColor: "transparent" } as const;

const seg = (active: boolean) =>
  ({
    ...TAP,
    flex: 1,
    minHeight: 44,
    borderRadius: 11,
    border: `1px solid ${active ? M.taupe : M.hairline}`,
    background: active ? M.taupe : M.card,
    color: active ? "#fff" : M.body,
    fontSize: 14,
    fontWeight: 600,
  }) as const;

const square = (disabled: boolean) =>
  ({
    ...TAP,
    width: 44,
    height: 44,
    flex: "none",
    display: "grid",
    placeItems: "center",
    borderRadius: 11,
    border: `1px solid ${M.hairline}`,
    background: M.card,
    color: M.body,
    opacity: disabled ? 0.35 : 1,
    cursor: disabled ? "default" : "pointer",
  }) as const;

const caption = { fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: M.muted, margin: "16px 2px 8px" } as const;

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A single highlighted day stepped by one calendar day, or null past `maxDay` / with no day set. */
function dayNeighbour(day: string | undefined, delta: number, maxDay: string): Period | null {
  if (!day) return null;
  const nd = stepDay(day, delta, maxDay);
  return nd ? { mode: "monthly", month: nd.slice(0, 7), day: nd } : null;
}

export function PeriodChip({
  period,
  months,
  latestDay,
  onChange,
}: {
  period: Period;
  months: string[];
  /** Newest day that carries data - the presets anchor to it, not to the clock. */
  latestDay: string;
  onChange: (p: Period) => void;
}) {
  const [open, setOpen] = useState(false);
  // The month/year the popover browses. It follows the period (stepper,
  // presets) and can be browsed on its own with the popover's own arrows.
  const [viewMonth, setViewMonth] = useState(period.month);
  const [viewYear, setViewYear] = useState(period.month.slice(0, 4));
  const [seenMonth, setSeenMonth] = useState(period.month);
  if (seenMonth !== period.month) {
    setSeenMonth(period.month);
    setViewMonth(period.month);
    setViewYear(period.month.slice(0, 4));
  }

  const disabled = months.length === 0;
  const today = ymd(new Date());

  // Which of the three views the CURRENT period reads as - same rule as the
  // desktop PeriodPicker. A range preset (Last 7 Days) has no calendar
  // identity of its own, so it reads as Day (the closest of the three).
  const view: "day" | "month" | "ytd" =
    period.mode === "ytd" ? "ytd" : period.mode === "range" || period.day ? "day" : "month";
  const setView = (v: "day" | "month" | "ytd") => {
    if (v === view) return;
    if (v === "ytd") { onChange({ mode: "ytd", month: period.month }); return; }
    if (v === "month") { onChange({ mode: "monthly", month: period.month, day: undefined }); return; }
    const day = period.day ?? today;
    onChange({ mode: "monthly", month: day.slice(0, 7), day });
  };

  const singleDay = view === "day" && period.mode === "monthly" && !!period.day;
  const prev = singleDay ? dayNeighbour(period.day, -1, today) : stepPeriod(period, months, -1);
  const next = singleDay ? dayNeighbour(period.day, 1, today) : stepPeriod(period, months, 1);

  const years = yearsWithData(months);
  const yi = years.indexOf(viewYear);
  const stepViewYear = (delta: number) => {
    const target = years[yi + delta];
    if (target) setViewYear(target);
  };

  const presets = periodPresets(latestDay, months, today);
  const from = period.day ?? period.from;
  const to = period.day ?? period.to;
  const apply = (p: Period) => {
    onChange(p);
    setOpen(false);
  };
  const applyMonth = (month: string) => apply({ mode: "monthly", month, day: undefined });

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        aria-label={`Period: ${periodLabel(period, today)}. Change period`}
        style={{
          ...TAP,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          minHeight: 40,
          padding: "0 10px",
          borderRadius: 11,
          border: `1px solid ${M.hairline}`,
          background: M.card,
          color: M.raisin,
          fontSize: 13.5,
          fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
          opacity: disabled ? 0.5 : 1,
          whiteSpace: "nowrap",
        }}
      >
        <CalendarDays size={16} strokeWidth={2} color={M.taupe} />
        {periodLabel(period, today)}
        <ChevronDown size={15} strokeWidth={2.2} color={M.muted} />
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Period">
        <div style={{ display: "flex", gap: 8 }}>
          {(["day", "month", "ytd"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} style={seg(view === v)} onClick={() => setView(v)}>
              {v === "day" ? "Day" : v === "month" ? "Month" : "YTD"}
            </button>
          ))}
        </div>

        {/* Stepper: steps by whatever the active view measures - a day, a
            month, or a year - bounded to what the book actually has (Day
            only caps at today; a gap in the book should show empty, not be
            skipped over). */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
          <button type="button" aria-label={`Previous ${view}`} disabled={!prev} style={square(!prev)} onClick={() => prev && onChange(prev)}>
            <ChevronLeft size={20} />
          </button>
          <div style={{ flex: 1, textAlign: "center", fontSize: 16, fontWeight: 700, color: M.raisin, fontVariantNumeric: "tabular-nums" }}>
            {periodLabel(view === "day" ? period : { ...period, day: undefined }, today)}
          </div>
          <button type="button" aria-label={`Next ${view}`} disabled={!next} style={square(!next)} onClick={() => next && onChange(next)}>
            <ChevronRight size={20} />
          </button>
        </div>

        {view === "day" && (
          <>
            <div style={caption}>Quick picks</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {presets.map((p) => {
                const on = presetActive(p.period, period);
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => apply(p.period)}
                    style={{
                      ...TAP, minHeight: 44, padding: "0 14px", borderRadius: 11, fontSize: 14, fontWeight: 600,
                      border: `1px solid ${on ? M.taupe : M.hairline}`, background: on ? M.taupe : M.card, color: on ? "#fff" : M.body,
                    }}
                  >
                    {p.label}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => applyMonth(viewMonth)}
                style={{ ...TAP, minHeight: 44, padding: "0 14px", borderRadius: 11, fontSize: 14, fontWeight: 600, border: `1px solid ${M.hairline}`, background: M.card, color: M.taupe }}
              >
                Whole month
              </button>
            </div>

            <div style={{ ...caption, display: "flex", alignItems: "center", justifyContent: "space-between", margin: "16px 2px 4px" }}>
              <span>Pick a day</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, textTransform: "none", letterSpacing: 0 }}>
                <button type="button" aria-label="Previous month" style={{ ...square(false), border: "none", background: "none" }} onClick={() => setViewMonth(shiftMonth(viewMonth, -1))}>
                  <ChevronLeft size={18} />
                </button>
                <span style={{ fontWeight: 600, minWidth: 74, textAlign: "center" }}>{monthLabel(viewMonth)}</span>
                <button type="button" aria-label="Next month" style={{ ...square(false), border: "none", background: "none" }} onClick={() => setViewMonth(shiftMonth(viewMonth, 1))}>
                  <ChevronRight size={18} />
                </button>
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 2 }}>
              {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
                <div key={i} style={{ height: 24, display: "grid", placeItems: "center", fontSize: 11, color: M.muted }}>{d}</div>
              ))}
              {calendarCells(viewMonth).map((day, i) => {
                if (!day) return <div key={`pad-${i}`} />;
                // A future day cannot be reported on; a past day with nothing sold
                // stays selectable - "nothing that day" is a real answer.
                const future = day > today;
                const selected = day === from || day === to;
                const inRange = !!from && !!to && day > from && day < to;
                return (
                  <button
                    key={day}
                    type="button"
                    disabled={future}
                    onClick={() => apply({ mode: "monthly", month: day.slice(0, 7), day })}
                    style={{
                      ...TAP, height: 44, borderRadius: 11, border: "none", fontSize: 15, fontVariantNumeric: "tabular-nums",
                      fontWeight: selected ? 700 : 500,
                      background: selected ? M.taupe : inRange ? M.card : "none",
                      color: selected ? "#fff" : future ? M.faint : M.raisin,
                      opacity: future ? 0.45 : 1,
                      cursor: future ? "default" : "pointer",
                    }}
                  >
                    {Number(day.slice(8))}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 11.5, color: M.muted, margin: "10px 2px 0" }}>
              Tap a day to see just that day. Future dates are disabled.
            </div>
          </>
        )}

        {view === "month" && (
          <>
            <div style={{ ...caption, display: "flex", alignItems: "center", justifyContent: "space-between", margin: "16px 2px 4px" }}>
              <span>Pick a month</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, textTransform: "none", letterSpacing: 0 }}>
                <button type="button" aria-label="Previous year" disabled={!years[yi - 1]} style={{ ...square(!years[yi - 1]), border: "none", background: "none" }} onClick={() => stepViewYear(-1)}>
                  <ChevronLeft size={18} />
                </button>
                <span style={{ fontWeight: 600, minWidth: 44, textAlign: "center" }}>{viewYear}</span>
                <button type="button" aria-label="Next year" disabled={!years[yi + 1]} style={{ ...square(!years[yi + 1]), border: "none", background: "none" }} onClick={() => stepViewYear(1)}>
                  <ChevronRight size={18} />
                </button>
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
              {MONTH_SHORT.map((label, i) => {
                const m = `${viewYear}-${String(i + 1).padStart(2, "0")}`;
                const has = months.includes(m);
                const selected = m === period.month;
                return (
                  <button
                    key={m}
                    type="button"
                    disabled={!has}
                    onClick={() => has && applyMonth(m)}
                    style={{
                      ...TAP, minHeight: 44, borderRadius: 11, border: "none", fontSize: 14, fontWeight: selected ? 700 : 500,
                      background: selected ? M.taupe : "none",
                      color: selected ? "#fff" : has ? M.raisin : M.faint,
                      opacity: has ? 1 : 0.45,
                      cursor: has ? "pointer" : "default",
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 11.5, color: M.muted, margin: "10px 2px 0" }}>
              Tap a month to jump to it. Months with no data are disabled.
            </div>
          </>
        )}
      </Sheet>
    </>
  );
}
