// Shared /m dashboard primitives. Every tab builds from these so the tabs look
// like one screen: MKpiGrid/MKpi (2-col tiles), MSection (titled block),
// MChartCard (tap-to-focus bar chart), MRankList (ranked list with bars),
// MState (loading / error / empty). Styling follows the /m conventions —
// MobileCard surface, theme tokens `M`, no hard-coded light-only colours — so
// both /m themes work.
import { type ReactNode } from "react";
import { Bar, BarChart, Cell, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { TrendingDown, TrendingUp, X } from "lucide-react";
import { MobileCard, ListRow } from "../../components";
import { M, M_DELTA } from "../../theme";

// ---- Sub-tab pills ------------------------------------------------------

/** Second-level strip under the tab strip (NOT sticky — SubTabs owns that row). */
export function MSubPills({ subs, active, onChange }: {
  subs: readonly { key: string; label: string }[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div role="tablist" style={{ display: "flex", gap: 6, overflowX: "auto", padding: "12px 12px 0", scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}>
      {subs.map((t) => {
        const on = t.key === active;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.key)}
            style={{
              flexShrink: 0, minHeight: 36, padding: "6px 12px", borderRadius: 9999, whiteSpace: "nowrap",
              border: `1px solid ${on ? M.taupe : M.hairline}`, backgroundColor: on ? M.card : "transparent",
              color: on ? M.raisin : M.muted, fontSize: 12, fontWeight: 600, cursor: "pointer",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ---- KPI tiles ----------------------------------------------------------

export function MKpiGrid({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
      {children}
    </div>
  );
}

/** "+12.3% vs Jul 2026" line; `pct` null → "no prior period". */
export function MDelta({ pct, vs }: { pct: number | null; vs: string }) {
  if (pct === null) return <div style={{ fontSize: 11, color: M.muted }}>no prior period</div>;
  const up = pct >= 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, minWidth: 0 }}>
      <Icon size={12} strokeWidth={2} color={up ? M_DELTA.up : M_DELTA.down} style={{ flex: "none" }} />
      <span style={{ fontWeight: 700, color: up ? M_DELTA.up : M_DELTA.down, fontVariantNumeric: "tabular-nums" }}>
        {up ? "+" : ""}{pct.toFixed(1)}%
      </span>
      <span style={{ color: M.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>vs {vs}</span>
    </div>
  );
}

export function MKpi({
  label,
  value,
  sub,
  tone,
  onClick,
}: {
  label: string;
  value: string;
  /** Free line under the value; pass <MDelta/> for a delta. */
  sub?: ReactNode;
  /** Value colour, default primary text. */
  tone?: string;
  onClick?: () => void;
}) {
  return (
    <MobileCard radius={16} onClick={onClick} style={{ padding: "12px 13px", minHeight: 44, minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: M.muted, textTransform: "uppercase", letterSpacing: 0.4 }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 20,
          fontWeight: 800,
          color: tone ?? M.raisin,
          marginTop: 3,
          fontVariantNumeric: "tabular-nums",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </div>
      {sub ? <div style={{ fontSize: 11, color: M.muted, marginTop: 2 }}>{sub}</div> : null}
    </MobileCard>
  );
}

// ---- Section ------------------------------------------------------------

export function MSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, margin: "18px 4px 9px" }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, color: "#A89F8D" }}>
          {title}
        </div>
        {hint ? <div style={{ fontSize: 11, color: M.muted }}>{hint}</div> : null}
      </div>
      {children}
    </section>
  );
}

// ---- Loading / error / empty -------------------------------------------

export function MState({ kind, text, action }: { kind: "loading" | "error" | "empty"; text?: string; action?: ReactNode }) {
  const msg = text ?? (kind === "loading" ? "Loading…" : kind === "error" ? "Couldn't load this view." : "Nothing to show.");
  return (
    <div
      role={kind === "error" ? "alert" : undefined}
      style={{
        padding: "36px 20px",
        textAlign: "center",
        fontSize: 13,
        color: kind === "error" ? M_DELTA.down : M.muted,
        display: "grid",
        gap: 10,
        justifyItems: "center",
      }}
    >
      <div>{msg}</div>
      {action}
    </div>
  );
}

// ---- Focus chip ("Showing: 12 Aug — tap to clear") ----------------------

export function MFocusChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <button
      type="button"
      onClick={onClear}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        minHeight: 44,
        padding: "0 12px",
        borderRadius: 12,
        border: `1px solid ${M.border}`,
        background: M.card,
        color: M.taupe,
        fontSize: 12.5,
        fontWeight: 600,
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      Showing: {label} — tap to clear
      <X size={14} strokeWidth={2} />
    </button>
  );
}

// ---- Chart card ---------------------------------------------------------

export type MBar = {
  /** Axis label; also the tap identity handed to onSelect (e.g. "12" or "08"). */
  key: string;
  value: number;
};

/**
 * Bar chart card with tap-to-select. The chart has an explicit pixel height
 * (ResponsiveContainer needs a sized parent). Selecting is CONTROLLED: pass
 * `selectedKey` and handle `onSelect(key)` — the Sales tab maps that onto
 * `period.day` via tapBucket(), so a chart tap and the "Showing:" chip are the
 * same state. Add a new chart = build MBar[] and render <MChartCard/>.
 */
export function MChartCard({
  title,
  subtitle,
  data,
  selectedKey,
  onSelect,
  formatAxis,
  height = 190,
  emptyText = "No data in range.",
  footer,
}: {
  title: string;
  subtitle?: string;
  data: MBar[];
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  /** Y-axis tick formatter (e.g. compact RM). */
  formatAxis?: (v: number) => string;
  height?: number;
  emptyText?: string;
  /** Rendered under the chart — e.g. the MFocusChip. */
  footer?: ReactNode;
}) {
  return (
    <MobileCard radius={18} style={{ padding: "14px 12px 12px" }}>
      <div style={{ padding: "0 4px 8px" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: M.raisin }}>{title}</div>
        {subtitle ? <div style={{ fontSize: 12, color: M.muted, marginTop: 2 }}>{subtitle}</div> : null}
      </div>
      <div
        style={{ width: "100%", height, userSelect: "none", WebkitTapHighlightColor: "transparent" }}
        // Recharts paints a focus outline on its wrapper after a tap.
        className="[&_*]:outline-none"
      >
        {data.length === 0 ? (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: M.muted }}>
            {emptyText}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
              barCategoryGap="12%"
              onClick={(e) => {
                const k = e?.activeLabel;
                if (onSelect && (typeof k === "string" || typeof k === "number")) onSelect(String(k));
              }}
            >
              <XAxis
                dataKey="key"
                tick={{ fontSize: 10, fill: "var(--m-muted)" }}
                axisLine={{ stroke: "var(--m-border)" }}
                tickLine={false}
                interval="preserveStartEnd"
                minTickGap={8}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "var(--m-muted)" }}
                axisLine={false}
                tickLine={false}
                width={46}
                tickFormatter={(v) => (formatAxis ? formatAxis(Number(v)) : String(v))}
              />
              {/* pointerEvents none: same fix as the desktop trend — bar
                  shapes swallow the click otherwise; the chart-level onClick
                  resolves the bucket from activeLabel. activeBar off: no
                  hover re-layer. */}
              <Bar
                dataKey="value"
                radius={[3, 3, 0, 0]}
                maxBarSize={26}
                isAnimationActive={false}
                activeBar={false}
                style={{ pointerEvents: "none" }}
              >
                {data.map((d) => (
                  <Cell key={d.key} fill={selectedKey && selectedKey !== d.key ? "var(--m-hairline)" : "var(--m-taupe)"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
      {footer ? <div style={{ padding: "8px 4px 0" }}>{footer}</div> : null}
    </MobileCard>
  );
}

// ---- Ranked list --------------------------------------------------------

export type MRankItem = {
  key: string;
  label: string;
  /** Sort/scale value — bar length is value / max(values). */
  value: number;
  /** Right-hand text, e.g. formatted RM. */
  valueLabel: string;
  sub?: string;
  onClick?: () => void;
};

/** Ranked ListRow list; the thin bar under each title is its share of the top item. */
export function MRankList({
  items,
  valueHeading = "Revenue",
  emptyText = "Nothing to rank.",
}: {
  items: MRankItem[];
  valueHeading?: string;
  emptyText?: string;
}) {
  if (items.length === 0) return <MobileCard><MState kind="empty" text={emptyText} /></MobileCard>;
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <MobileCard padded={false} radius={16} style={{ overflow: "hidden" }}>
      {items.map((it, i) => (
        <ListRow
          key={it.key}
          code={`#${i + 1}`}
          title={it.label}
          subLine={it.sub}
          meta={[{ label: valueHeading, value: it.valueLabel }]}
          onClick={it.onClick}
          pill={
            <div style={{ height: 5, borderRadius: 3, background: "var(--m-divider)", overflow: "hidden" }}>
              <div style={{ width: `${Math.max(2, (it.value / max) * 100)}%`, height: "100%", background: "var(--m-taupe)" }} />
            </div>
          }
        />
      ))}
    </MobileCard>
  );
}
