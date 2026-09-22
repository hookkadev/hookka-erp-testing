import { useMemo, type ReactNode } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { TAUPE, AMBER, MUTED, CHART_GOLD, fmtN, type Period } from "./dashboard-shared-lib";
import {
  NONE_KEY, byCause, topProducts, causeLabel, analysisProgress, closeDaysByCause, causeGrid, dayBuckets, monthBuckets,
  topCauseByProduct, type IssueCase, type TallyRow,
} from "../../api/lib/service-issue-stats";

// "Top issues" sub-tab of the Service tab. Cases arrive already filtered to
// the period picker; definitions live in api/lib/service-issue-stats.ts
// (shared with the tests). Every field is optional on old cached feeds — a
// case without them is simply "not yet analysed".
//
// Redesigned 2026-09-22. The old panel was four identical bar tables (cause /
// unit / prevention / product) plus a smoothed line of the top 3 causes by
// day. Each question now gets the form that fits it:
//   - Analysis progress  → one meter per step (root cause → unit → prevention → done)
//   - Cases by cause     → a bar split closed | open, so "5 cases, all open" is visible
//   - Days to close      → one dot per closed case + the average, not one avg over 1-5 cases
//   - Cause × day        → a heatmap on a fixed day grid; whole counts stay whole
//   - Products           → a table (counts of 1-3 are not a chart) with the top cause
// Colour: TAUPE = closed / done, AMBER = open / gap, CHART_GOLD = heat ramp.

const INK = "#1F1D1B";
const TRACK = "#F0ECE9";

/** Plain ranked rows with a bar — still used by the Performance panel's Prevention block. */
export function TallyList({
  rows, total, onPick, empty,
}: { rows: TallyRow[]; total: number; onPick?: (key: string) => void; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (total === 0) return <div className="py-6 text-center text-xs text-[#6B7280]">{empty}</div>;
  return (
    <div className="select-none [&_*]:outline-none max-md:overflow-x-auto">
      <div className="max-md:min-w-[440px] grid grid-cols-[minmax(110px,1.2fr)_2fr_44px_50px_44px_60px] gap-2 px-1 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[#6B7280]">
        <span>Issue</span><span /><span className="text-right">Cases</span><span className="text-right">% cases</span>
        <span className="text-right">Open</span><span className="text-right">Avg close</span>
      </div>
      {rows.map((r) => {
        const none = r.key === NONE_KEY;
        return (
          <div
            key={r.key}
            role={onPick ? "button" : undefined}
            onClick={onPick ? () => onPick(r.key) : undefined}
            className={`max-md:min-w-[440px] grid grid-cols-[minmax(110px,1.2fr)_2fr_44px_50px_44px_60px] gap-2 items-center px-1 py-1.5 max-md:py-2.5 border-t border-[#E2DDD8] text-[12.5px] ${onPick ? "cursor-pointer hover:bg-[#F7F5F3]" : ""}`}
          >
            <span className="truncate font-medium" style={{ color: none ? AMBER : INK }}>{r.label}</span>
            <span className="h-3 rounded-sm" style={{ background: TRACK }}>
              <span className="block h-3 rounded-sm" style={{ width: `${(r.count / max) * 100}%`, background: none ? AMBER : TAUPE }} />
            </span>
            <span className="text-right tabular-nums font-semibold" style={{ color: INK }}>{fmtN(r.count)}</span>
            <span className="text-right tabular-nums text-[#6B7280]">{r.pct}%</span>
            <span className="text-right tabular-nums text-[#6B7280]">{fmtN(r.open)}</span>
            <span className="text-right tabular-nums text-[#6B7280]">{r.avgCloseDays === null ? "—" : `${r.avgCloseDays} d`}</span>
          </div>
        );
      })}
    </div>
  );
}

const Empty = ({ text }: { text: string }) => <div className="py-6 text-center text-xs text-[#6B7280]">{text}</div>;
const Sub = ({ children }: { children: ReactNode }) => <p className="text-xs text-[#6B7280]">{children}</p>;

/** One meter per analysis step; the gap is amber so the missing share is the thing you see. */
function ProgressMeters({ cases }: { cases: IssueCase[] }) {
  const steps = useMemo(() => analysisProgress(cases), [cases]);
  if (cases.length === 0) return <Empty text="No service cases in this period." />;
  return (
    <div>
      {steps.map((s, i) => (
        <div key={s.key} className={`grid grid-cols-[minmax(130px,1fr)_2fr_110px] gap-3 items-center px-1 py-2 text-[12.5px] ${i ? "border-t border-[#E2DDD8]" : ""}`}>
          <span className="font-medium" style={{ color: INK }}>{s.label}</span>
          <span className="flex h-2.5 rounded-sm overflow-hidden gap-[2px]" style={{ background: TRACK }} title={`${fmtN(s.done)} of ${fmtN(s.total)} cases`}>
            <span className="block h-full" style={{ width: `${s.pct}%`, background: TAUPE }} />
            {s.pct < 100 && <span className="block h-full flex-1" style={{ background: AMBER, opacity: 0.3 }} />}
          </span>
          <span className="text-right tabular-nums text-[#6B7280]">
            <span className="font-semibold" style={{ color: s.pct === 100 ? INK : AMBER }}>{fmtN(s.done)}</span> / {fmtN(s.total)} · {s.pct}%
          </span>
        </div>
      ))}
    </div>
  );
}

/** Same rows as the old tally, but the bar itself is split closed | open. Click → list those cases. */
function CauseSplit({ rows, total, onPick }: { rows: TallyRow[]; total: number; onPick?: (key: string) => void }) {
  if (total === 0) return <Empty text="No service cases in this period." />;
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="select-none [&_*]:outline-none">
      <div className="flex gap-4 px-1 pb-2 text-[11px] text-[#6B7280]">
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: TAUPE }} />Closed</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: AMBER }} />Open</span>
      </div>
      {rows.map((r) => {
        const none = r.key === NONE_KEY;
        const closed = r.count - r.open;
        return (
          <div
            key={r.key}
            role={onPick ? "button" : undefined}
            onClick={onPick ? () => onPick(r.key) : undefined}
            className={`grid grid-cols-[minmax(110px,1fr)_2fr_96px] gap-3 items-center px-1 py-2 border-t border-[#E2DDD8] text-[12.5px] ${onPick ? "cursor-pointer hover:bg-[#F7F5F3]" : ""}`}
          >
            <span className="truncate font-medium" style={{ color: none ? AMBER : INK }}>{r.label}</span>
            <span className="flex h-3 gap-[2px]" title={`${fmtN(closed)} closed · ${fmtN(r.open)} open`}>
              {closed > 0 && <span className="block h-full" style={{ width: `${(closed / max) * 100}%`, background: TAUPE, borderRadius: r.open ? 0 : "0 3px 3px 0" }} />}
              {r.open > 0 && <span className="block h-full rounded-r-[3px]" style={{ width: `${(r.open / max) * 100}%`, background: AMBER }} />}
            </span>
            <span className="text-right tabular-nums text-[#6B7280]">
              <span className="font-semibold" style={{ color: INK }}>{fmtN(r.count)}</span> · {fmtN(r.open)} open
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** One dot per closed case on a shared day scale; a tick marks the average. */
function CloseDays({ cases }: { cases: IssueCase[] }) {
  const rows = useMemo(() => closeDaysByCause(cases), [cases]);
  const shown = rows.filter((r) => r.count > 0);
  if (cases.length === 0) return <Empty text="No service cases in this period." />;
  const maxDay = Math.max(7, ...rows.flatMap((r) => r.days));
  const span = Math.ceil(maxDay / 7) * 7;
  const W = 480, LABEL = 118, PAD = 12, ROW = 30, TOP = 20;
  const H = TOP + shown.length * ROW;
  const x = (d: number) => LABEL + ((W - LABEL - PAD) * d) / span;
  const ticks = Array.from({ length: span / 7 + 1 }, (_, i) => i * 7);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Days to close per closed case, by cause" className="select-none">
      <title>Days to close per closed case, by cause</title>
      {ticks.map((t) => (
        <g key={t}>
          <text x={x(t)} y={11} fontSize={10} fill={MUTED} textAnchor="middle">{t === 0 ? "0" : `${t} d`}</text>
          <line x1={x(t)} y1={16} x2={x(t)} y2={H} stroke="#E2DDD8" strokeWidth={1} />
        </g>
      ))}
      {shown.map((r, i) => {
        const cy = TOP + i * ROW + ROW / 2;
        const none = r.key === NONE_KEY;
        const fill = none ? AMBER : TAUPE;
        return (
          <g key={r.key}>
            <text x={0} y={cy + 4} fontSize={11.5} fill={none ? AMBER : "#4B5563"}>{r.label.length > 17 ? `${r.label.slice(0, 16)}…` : r.label}</text>
            {r.days.length === 0 ? (
              <text x={x(0) + 4} y={cy + 4} fontSize={10.5} fill={MUTED}>none closed yet</text>
            ) : (
              <>
                {r.days.map((d, j) => (
                  <circle key={j} cx={x(d)} cy={cy} r={5} fill={fill} stroke="#FFFFFF" strokeWidth={2}>
                    <title>{`${r.label}: closed in ${d} day${d === 1 ? "" : "s"}`}</title>
                  </circle>
                ))}
                {r.avg !== null && (
                  <>
                    <line x1={x(r.avg)} y1={cy - 10} x2={x(r.avg)} y2={cy + 10} stroke={INK} strokeWidth={2} />
                    <text x={x(r.avg) + 6} y={cy - 6} fontSize={10.5} fill={INK}>{`avg ${r.avg}`}</text>
                  </>
                )}
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** The period's bucket list — every day of the month / range, or every month of the year to date. */
function bucketsFor(period: Period): { buckets: string[]; bucketOf: (d: string) => string; label: (b: string) => string; unit: "day" | "month" } {
  if (period.mode === "ytd") {
    const [y, m] = period.month.split("-").map(Number);
    return { buckets: monthBuckets(y, m), bucketOf: (d) => d.slice(0, 7), label: (b) => b.slice(5), unit: "month" };
  }
  if (period.mode === "range" && period.from && period.to) {
    const days = dayBuckets(period.from, period.to);
    if (days.length <= 62) return { buckets: days, bucketOf: (d) => d, label: (b) => b.slice(8), unit: "day" };
    const months = [...new Set(days.map((d) => d.slice(0, 7)))];
    return { buckets: months, bucketOf: (d) => d.slice(0, 7), label: (b) => b.slice(2), unit: "month" };
  }
  const [y, m] = period.month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { buckets: dayBuckets(`${period.month}-01`, `${period.month}-${String(last).padStart(2, "0")}`), bucketOf: (d) => d, label: (b) => b.slice(8), unit: "day" };
}

/** Cause × bucket heatmap: one hue, darker = more; zero cells stay visibly empty. */
function CauseHeatmap({ cases, period }: { cases: IssueCase[]; period: Period }) {
  const { buckets, bucketOf, label, unit } = useMemo(() => bucketsFor(period), [period]);
  const grid = useMemo(() => causeGrid(cases, buckets, bucketOf), [cases, buckets, bucketOf]);
  if (grid.rows.length === 0) return <Empty text="No service cases in this period." />;
  const cols = `minmax(120px,1fr) repeat(${buckets.length}, minmax(${unit === "day" ? 18 : 30}px, 1fr))`;
  return (
    <div className="overflow-x-auto select-none">
      <div className="grid gap-[2px] items-center text-[10.5px] text-[#6B7280]" style={{ gridTemplateColumns: cols, minWidth: unit === "day" ? 720 : 0 }}>
        <span />
        {buckets.map((b) => <span key={b} className="text-center tabular-nums">{label(b)}</span>)}
        {grid.rows.map((r) => {
          const none = r.key === NONE_KEY;
          return [
            <span key={`${r.key}-l`} className="truncate pr-2 text-[12px] font-medium" style={{ color: none ? AMBER : INK }} title={r.label}>{r.label}</span>,
            ...r.cells.map((v, i) => (
              <span
                key={`${r.key}-${i}`}
                className="flex h-6 items-center justify-center rounded-[3px] tabular-nums text-[11px]"
                style={{ background: v ? CHART_GOLD : TRACK, opacity: v ? 0.3 + 0.7 * (v / Math.max(1, grid.max)) : 1, color: INK }}
                title={`${r.label} · ${buckets[i]}: ${v} case${v === 1 ? "" : "s"}`}
              >
                {v || ""}
              </span>
            )),
          ];
        })}
      </div>
    </div>
  );
}

export function ServiceIssuesPanel({
  cases, period, onPickCause, causeOnly,
}: { cases: IssueCase[]; period: Period; onPickCause: (key: string) => void; causeOnly?: boolean }) {
  const causes = useMemo(() => byCause(cases), [cases]);
  const products = useMemo(() => topProducts(cases, 10), [cases]);
  const productCause = useMemo(() => topCauseByProduct(cases), [cases]);
  const ytd = period.mode === "ytd";

  const causeCard = (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle>Cases by cause{causeOnly ? ` (${fmtN(cases.length)} cases)` : ""}</CardTitle>
        <Sub>
          Closed | open per root cause. A case with several causes counts once under each, so rows can add up to more than the total.
          {causeOnly ? "" : " Click a row to list those cases."}
        </Sub>
      </CardHeader>
      <CardContent><CauseSplit rows={causes} total={cases.length} onPick={causeOnly ? undefined : onPickCause} /></CardContent>
    </Card>
  );
  if (causeOnly) return causeCard;

  return (
    <div className="space-y-5 max-md:space-y-4">
      <Card>
        <CardHeader className="pb-1">
          <CardTitle>Analysis progress ({fmtN(cases.length)} cases logged)</CardTitle>
          <Sub>How far the root-cause process has got for the cases logged in this period. Amber is the share still missing.</Sub>
        </CardHeader>
        <CardContent><ProgressMeters cases={cases} /></CardContent>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 max-md:gap-4">
        {causeCard}
        <Card>
          <CardHeader className="pb-1">
            <CardTitle>Days to close — every closed case</CardTitle>
            <Sub>One dot per closed case (logged to closed, whole days); the tick is that cause's average. Open cases are not drawn.</Sub>
          </CardHeader>
          <CardContent><CloseDays cases={cases} /></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-1">
          <CardTitle>Cases logged — cause × {ytd ? "month" : "day"}</CardTitle>
          <Sub>Darker = more cases that {ytd ? "month" : "day"}. Empty cells are quiet {ytd ? "months" : "days"}, not missing data.</Sub>
        </CardHeader>
        <CardContent><CauseHeatmap cases={cases} period={period} /></CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-1">
          <CardTitle>Most affected products (top 10)</CardTitle>
          <Sub>Cases that list the product as affected; a product counts once per case. Top cause = the root cause recorded most often on those cases.</Sub>
        </CardHeader>
        <CardContent>
          {products.length === 0 ? (
            <Empty text="No affected products recorded in this period." />
          ) : (
            <div>
              <div className="grid grid-cols-[minmax(160px,2fr)_1fr_60px] gap-3 px-1 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[#6B7280]">
                <span>Product</span><span>Top cause</span><span className="text-right">Cases</span>
              </div>
              {products.map((p) => {
                const cause = productCause.get(p.label) ?? null;
                return (
                  <div key={p.label} className="grid grid-cols-[minmax(160px,2fr)_1fr_60px] gap-3 items-center px-1 py-1.5 border-t border-[#E2DDD8] text-[12.5px]">
                    <span className="truncate" style={{ color: INK }} title={p.label}>{p.label}</span>
                    <span className="truncate text-[#6B7280]" style={{ color: cause ? undefined : AMBER }}>{cause ? causeLabel(cause) : "Not yet analysed"}</span>
                    <span className="text-right tabular-nums font-semibold" style={{ color: INK }}>{fmtN(p.count)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
