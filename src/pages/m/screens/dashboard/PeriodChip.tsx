// Header period chip ("Sep 2026 ▾") + the bottom sheet it opens: Monthly / YTD
// toggle and the list of months (YTD: years) that actually have data.
import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { monthLabel, periodLabel, type Period } from "../../../dashboards/dashboard-shared-lib";
import { Sheet } from "../../components";
import { M } from "../../theme";
import { periodChoices } from "./dashboard-m-lib";

const seg = (active: boolean) =>
  ({
    flex: 1,
    minHeight: 44,
    borderRadius: 11,
    border: `1px solid ${active ? M.taupe : M.hairline}`,
    background: active ? M.taupe : M.card,
    color: active ? "#fff" : M.body,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
  }) as const;

export function PeriodChip({
  period,
  months,
  onChange,
}: {
  period: Period;
  months: string[];
  onChange: (p: Period) => void;
}) {
  const [open, setOpen] = useState(false);
  // "monthly" | "ytd" only: a desktop "range" link opens as monthly here.
  const mode = period.mode === "ytd" ? "ytd" : "monthly";
  const choices = periodChoices(months, mode);
  const label = periodLabel({ ...period, day: undefined });
  const disabled = months.length === 0;

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        aria-label={`Period: ${label}. Change period`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          minHeight: 44,
          padding: "0 6px 0 10px",
          border: "none",
          background: "none",
          color: M.taupe,
          fontSize: 14,
          fontWeight: 700,
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.5 : 1,
          whiteSpace: "nowrap",
          WebkitTapHighlightColor: "transparent",
        }}
      >
        {period.mode === "ytd" ? `${label} · Year` : label}
        <ChevronDown size={16} strokeWidth={2.2} />
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Period">
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button type="button" style={seg(mode === "monthly")} onClick={() => onChange({ mode: "monthly", month: period.month })}>
            Monthly
          </button>
          <button type="button" style={seg(mode === "ytd")} onClick={() => onChange({ mode: "ytd", month: period.month })}>
            YTD
          </button>
        </div>
        <div style={{ fontSize: 11, color: M.muted, margin: "0 2px 6px" }}>
          {mode === "ytd" ? "Whole year, newest first" : "Months with sales, newest first"}
        </div>
        <div style={{ maxHeight: "45vh", overflowY: "auto", borderRadius: 14, border: `1px solid ${M.border}`, background: M.card }}>
          {choices.map((c, i) => {
            const active = mode === "ytd" ? c.label === period.month.slice(0, 4) : c.value === period.month;
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => {
                  onChange({ mode, month: c.value });
                  setOpen(false);
                }}
                style={{
                  width: "100%",
                  minHeight: 48,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "0 14px",
                  border: "none",
                  borderBottom: i === choices.length - 1 ? "none" : `1px solid ${M.divider}`,
                  background: "none",
                  color: active ? M.taupe : M.raisin,
                  fontSize: 14.5,
                  fontWeight: active ? 700 : 500,
                  cursor: "pointer",
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                {mode === "ytd" ? c.label : monthLabel(c.value)}
                {active ? <Check size={18} strokeWidth={2.4} /> : null}
              </button>
            );
          })}
          {choices.length === 0 ? (
            <div style={{ padding: 16, fontSize: 13, color: M.muted, textAlign: "center" }}>No months with data yet.</div>
          ) : null}
        </div>
      </Sheet>
    </>
  );
}
