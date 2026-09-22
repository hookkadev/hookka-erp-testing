// Header period chip ("Sep 2026 ▾") + the bottom sheet it opens. The sheet has
// what the desktop PeriodPicker has - Monthly / YTD, a < > stepper, the
// Today / Yesterday / Last 7 Days presets and a calendar for one day - and
// shares its logic (dashboard-shared-lib: stepPeriod, periodPresets,
// calendarCells), so a phone and a desktop select identical windows.
//
// A phone NEVER sees the desktop picker: DashboardLayout redirects mobile
// devices to /m, so this chip is the only period control an iPhone gets.
import { useState } from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import {
  calendarCells, monthLabel, periodLabel, periodPresets, presetActive, shiftMonth, stepPeriod, ymd,
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
  // The month the calendar shows. It follows the period (stepper, presets) and
  // can be browsed on its own with the calendar's arrows in YTD / range.
  const [viewMonth, setViewMonth] = useState(period.month);
  const [seenMonth, setSeenMonth] = useState(period.month);
  if (seenMonth !== period.month) {
    setSeenMonth(period.month);
    setViewMonth(period.month);
  }

  const disabled = months.length === 0;
  const prev = stepPeriod(period, months, -1);
  const next = stepPeriod(period, months, 1);
  const today = ymd(new Date());
  const presets = periodPresets(latestDay, months, today);
  const from = period.day ?? period.from;
  const to = period.day ?? period.to;
  const apply = (p: Period) => {
    onChange(p);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        aria-label={`Period: ${periodLabel(period)}. Change period`}
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
        {periodLabel(period)}
        <ChevronDown size={15} strokeWidth={2.2} color={M.muted} />
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Period">
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" aria-pressed={period.mode !== "ytd"} style={seg(period.mode !== "ytd")} onClick={() => onChange({ mode: "monthly", month: period.month })}>
            Monthly
          </button>
          <button type="button" aria-pressed={period.mode === "ytd"} style={seg(period.mode === "ytd")} onClick={() => onChange({ mode: "ytd", month: period.month })}>
            YTD
          </button>
        </div>

        {/* Stepper: a month, or a year in YTD. Only lands on months with data. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
          <button type="button" aria-label={period.mode === "ytd" ? "Previous year" : "Previous month"} disabled={!prev} style={square(!prev)} onClick={() => prev && onChange(prev)}>
            <ChevronLeft size={20} />
          </button>
          <div style={{ flex: 1, textAlign: "center", fontSize: 16, fontWeight: 700, color: M.raisin, fontVariantNumeric: "tabular-nums" }}>
            {periodLabel({ ...period, day: undefined })}
          </div>
          <button type="button" aria-label={period.mode === "ytd" ? "Next year" : "Next month"} disabled={!next} style={square(!next)} onClick={() => next && onChange(next)}>
            <ChevronRight size={20} />
          </button>
        </div>

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
            onClick={() => apply({ mode: "monthly", month: viewMonth })}
            style={{ ...TAP, minHeight: 44, padding: "0 14px", borderRadius: 11, fontSize: 14, fontWeight: 600, border: `1px solid ${M.hairline}`, background: M.card, color: M.taupe }}
          >
            Whole month
          </button>
        </div>

        <div style={{ ...caption, display: "flex", alignItems: "center", justifyContent: "space-between", margin: "16px 2px 4px" }}>
          <span>Pick a day</span>
          {/* Monthly: the stepper above already walks months and the calendar
              follows it. YTD / range: the stepper walks years, so the calendar
              gets its own month arrows. */}
          {period.mode === "monthly" ? (
            <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 600 }}>{monthLabel(viewMonth)}</span>
          ) : (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, textTransform: "none", letterSpacing: 0 }}>
              <button type="button" aria-label="Previous month" style={{ ...square(false), border: "none", background: "none" }} onClick={() => setViewMonth(shiftMonth(viewMonth, -1))}>
                <ChevronLeft size={18} />
              </button>
              <span style={{ fontWeight: 600, minWidth: 74, textAlign: "center" }}>{monthLabel(viewMonth)}</span>
              <button type="button" aria-label="Next month" style={{ ...square(false), border: "none", background: "none" }} onClick={() => setViewMonth(shiftMonth(viewMonth, 1))}>
                <ChevronRight size={18} />
              </button>
            </span>
          )}
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
      </Sheet>
    </>
  );
}
