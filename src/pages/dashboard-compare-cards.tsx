// ---------------------------------------------------------------------------
// STAGING ONLY: never PR this into main. Used by /dashboard/compare.
//
// COPIES of /dashboard's Plant Load card (its four rows open the same
// drill-throughs) and Fabric Usage section, so the compare page looks and
// behaves like the dashboard (owner 2026-10-09). They are copies, not shared
// code, because src/pages/dashboard-b/index.tsx is frozen by the owner (see
// docs/CODEBASE-MAP.md, "Widgets from /dashboard"). A change to either block
// there must be repeated here.
// ---------------------------------------------------------------------------
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { CheckCircle2, Clock, Factory, Info, Package, Scissors, X } from "lucide-react";

export const hrs = (min: number | undefined) =>
  `${Math.round((min ?? 0) / 60).toLocaleString()}h`;
export const hm = (min: number | undefined) => {
  const m = Math.max(0, Math.round(min ?? 0));
  return `${Math.floor(m / 60).toLocaleString()}h ${m % 60}m`;
};

// Same tones as /dashboard's C_RED / C_PROD / C_GREEN / C_SO.
const RED = "#DC2626";
const GOLD = "#C9A24B";
const GREEN = "#15803D";
const BROWN = "#6B5C32";
const rm = (sen: number | undefined) => formatCurrency(sen ?? 0);

export type Drill = { title: string; subtitle?: string; node: React.ReactNode };

type JobsBreakdown = {
  bedframeUnits: number;
  sofaSets: number;
  byCustomer: { customer: string; bedframeUnits: number; sofaSets: number }[];
};
type FabricLine = {
  fabCode: string;
  meters: number;
  past30Meters: number;
  next30Meters: number;
  buyAvgSen: number;
  buyMinSen: number;
  buyMaxSen: number;
};
export type PlantLoadOverview = {
  production?: {
    dailyCapacityMin: number;
    backlogMin: number;
    backlogDays: number;
    activeJobs: JobsBreakdown;
    completedYesterday: JobsBreakdown;
    completedLast7: { date: string; bedframeUnits: number; sofaSets: number }[];
    /** Whole-window totals, deduped — NOT the per-day series added up. */
    completedRange?: { bedframeUnits: number; sofaSets: number };
    capacityDays: { date: string; minutes: number; workers: number }[];
    // backlogDays: null = "stalled" (zero completions in the rolling window).
    backlogByDept: {
      dept: string;
      sofaMin: number;
      bedframeMin: number;
      totalMin: number;
      dailyCapMin: number;
      backlogDays: number | null;
    }[];
    backlogGrandMin: number;
  };
  employee?: { activeHeadcount: number };
  fabricCostPerMeterSen?: { total: number; exclBedframeSofa: number; bedframe: number; sofa: number };
  fabric?: Record<
    "BEDFRAME" | "SOFA",
    { list: FabricLine[]; monthly: { month: string; meters: number; lateMeters?: number }[] }
  >;
  stateSnapshot?: {
    source: "live" | "snapshot" | "reconstructed";
    isHistorical: boolean;
    asOf: string | null;
  };
};

// Simple two/three-column table used inside several drill-throughs.
export function MiniTable({
  cols,
  rows,
}: {
  cols: string[];
  rows: (string | number)[][];
}) {
  if (rows.length === 0)
    return <p className="text-xs text-[#9CA3AF]">Nothing here.</p>;
  return (
    <div className="overflow-x-auto">
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-[#9CA3AF] border-b border-[#E2DDD8]">
          {cols.map((c, i) => (
            <th
              key={c}
              className={`py-1.5 font-medium ${i === 0 ? "" : "text-right"}`}
            >
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, ri) => (
          <tr key={ri} className="border-b border-[#F0ECE6]">
            {r.map((cell, ci) => (
              <td
                key={ci}
                className={`py-1.5 tabular-nums ${
                  ci === 0
                    ? "text-[#1F1D1B]"
                    : "text-right font-semibold text-[#1F1D1B]"
                }`}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

export function SectionTitle({
  title,
  sub,
  right,
}: {
  title: string;
  sub?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-end justify-between mb-3 flex-wrap gap-y-2">
      <div>
        <h3 className="text-sm font-bold text-[#1F1D1B] tracking-[-0.2px]">
          {title}
        </h3>
        {sub && <p className="text-xs text-[#9CA3AF] mt-0.5">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

// Light radial gauge — track in brand cream, arc in accent.
export function Gauge({
  value,
  big,
  cap,
  accent,
}: {
  value: number;
  big: string;
  cap: string;
  accent: string;
}) {
  const pct = Math.max(0, Math.min(1, value));
  const r = 60;
  const c = 2 * Math.PI * r;
  const arc = c * 0.75;
  return (
    <div className="relative flex items-center justify-center">
      <svg width="184" height="184" viewBox="0 0 184 184">
        <circle
          cx="92"
          cy="92"
          r={r}
          fill="none"
          stroke="#F0ECE6"
          strokeWidth="12"
          strokeDasharray={`${arc} ${c}`}
          strokeLinecap="round"
          transform="rotate(135 92 92)"
        />
        <circle
          cx="92"
          cy="92"
          r={r}
          fill="none"
          stroke={accent}
          strokeWidth="12"
          strokeDasharray={`${arc * pct} ${c}`}
          strokeLinecap="round"
          transform="rotate(135 92 92)"
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="text-[34px] leading-none font-[800] text-[#1F1D1B] tabular-nums">
          {big}
        </span>
        <span className="mt-1 text-[10px] uppercase tracking-wider text-[#9CA3AF]">
          {cap}
        </span>
      </div>
    </div>
  );
}

// Centred modal for the drill-throughs (same UX as /dashboard).
export function Modal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 sm:p-8 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-3xl my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-[#E2DDD8] px-6 py-4">
          <div>
            <h3 className="text-base font-bold text-[#1F1D1B]">{title}</h3>
            {subtitle && (
              <p className="text-xs text-[#9CA3AF] mt-0.5">{subtitle}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 hover:bg-[#F5F2ED] text-[#5A5550]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-6 py-4">{children}</div>
      </div>
    </div>
  );
}

export function PlantLoadCard({
  ov,
  period,
  curYm,
  onDrill,
  windowLabel,
  windowTitle,
}: {
  ov: PlantLoadOverview;
  /** "all" or a "YYYY-MM" month. */
  period: string;
  curYm: string;
  onDrill: (d: Drill) => void;
  /** Compare page: e.g. "7-day avg". Default follows the period. */
  windowLabel?: string;
  /** Compare page: the Daily Capacity drill title. Default follows the period. */
  windowTitle?: string;
}) {
  const prod = ov.production;
  const isAllTime = period === "all";
  // All-time and the current month average the last 14 working days; a past
  // month averages its own working days (owner 2026-10-08).
  const capacityRolling = isAllTime || period === curYm;
  const capacityWindowLabel =
    windowLabel ?? (capacityRolling ? "14-day avg" : `${period} avg`);
  const capacityDrillTitle =
    windowTitle ??
    (capacityRolling ? "Daily Capacity — Past 14 Working Days" : `Daily Capacity — ${period}`);
  const completedDrillTitle = isAllTime
    ? "Completed — last 7 days"
    : `Completed — ${period}`;
  const backlogDays = prod?.backlogDays ?? 0;
  const util = Math.min(1, backlogDays / 14);
  const gaugeAccent = backlogDays > 12 ? RED : backlogDays > 7 ? GOLD : GREEN;
  // Month-awareness: the state widgets (Backlog / Active Jobs / Workforce)
  // are point-in-time counts. Three cases for a selected period:
  //   • source === "snapshot"      → a true captured daily snapshot for that
  //                                   past month. Show "as of <date>".
  //   • source === "reconstructed" → rebuilt as of the month's last day
  //                                   (best-effort estimate): "≈ reconstructed".
  //   • source === "live" + isHistorical → couldn't reconstruct; current live
  //                                   value shown for a past month.
  //   • source === "live" (current/all) → no tag.
  const stateReconstructed = ov.stateSnapshot?.source === "reconstructed";
  const stateLiveTag =
    ov.stateSnapshot?.isHistorical === true && !stateReconstructed;
  const stateAsOf =
    ov.stateSnapshot?.source === "snapshot" || stateReconstructed
      ? ov.stateSnapshot?.asOf
      : null;
  // Completed headline: all-time shows yesterday's live pulse; a selected month
  // (current or past) shows that month's RUNNING TOTAL. Take the server's
  // whole-window total. Adding up the per-day series double-counts sofa sets,
  // which are a DISTINCT count of sales orders — an order finishing across two
  // days appears in both. Falls back to the sum only if an older payload has
  // no range total.
  const completedMonthBf =
    prod?.completedRange?.bedframeUnits ??
    (prod?.completedLast7 ?? []).reduce((s, d) => s + (d.bedframeUnits || 0), 0);
  const completedMonthSofa =
    prod?.completedRange?.sofaSets ??
    (prod?.completedLast7 ?? []).reduce((s, d) => s + (d.sofaSets || 0), 0);
  const completedHeadBf = isAllTime
    ? (prod?.completedYesterday?.bedframeUnits ?? 0)
    : completedMonthBf;
  const completedHeadSofa = isAllTime
    ? (prod?.completedYesterday?.sofaSets ?? 0)
    : completedMonthSofa;
  const completedHeadlineLabel = isAllTime
    ? "Completed yest."
    // Labelled with its DEFINITION. This counts a production order on the day
    // its LAST job card closes, not when someone sets the order to COMPLETED —
    // which is the right call (the status depends on a human remembering to
    // click, and 59 orders on prod prove how that goes) but it makes the tile
    // disagree with the order list by ~14%. Owner 2026-08-05: keep the number,
    // explain it.
    : `Completed · ${period} (all job cards done)`;
  const completedHintLabel = isAllTime ? "· view 7d" : "· view days";

  return (
    <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
      <CardContent className="p-5 flex flex-col items-center">
        <SectionTitle title="Plant Load" sub="backlog vs daily capacity" />
        {stateLiveTag && (
          <span
            title="Backlog, Active Jobs and Workforce are point-in-time counts. No daily snapshot was stored for this past month, so the current live figures are shown — not that month's true state."
            className="mt-1 inline-flex items-center gap-1 rounded-full bg-[#FBF3E2] px-2 py-0.5 text-[10px] font-medium text-[#9A7B2E]"
          >
            <Info className="h-3 w-3" />
            live (no history before today)
          </span>
        )}
        {stateReconstructed && (
          <span
            title="No daily snapshot was stored for this past month. Backlog and Workforce are reconstructed as of the month's last day from job-card and worker records — a best-effort estimate, not a captured figure. (Active Jobs stays on the current live value.)"
            className="mt-1 inline-flex items-center gap-1 rounded-full bg-[#EEF1F4] px-2 py-0.5 text-[10px] font-medium text-[#5B6675]"
          >
            <Info className="h-3 w-3" />
            ≈ reconstructed (month-end est.)
          </span>
        )}
        {stateAsOf && (
          <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-[#EEF3EE] px-2 py-0.5 text-[10px] font-medium text-[#4B7A52]">
            <Info className="h-3 w-3" />
            as of {stateAsOf}
          </span>
        )}
        <Gauge
          value={util}
          big={`${backlogDays.toLocaleString()}d`}
          cap="queue"
          accent={gaugeAccent}
        />
        <div className="mt-4 grid w-full grid-cols-2 gap-3 text-center">
          <div className="rounded-lg bg-[#F7F4EF] px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-[#9CA3AF]">
              Workforce
            </p>
            <p className="text-lg font-bold text-[#1F1D1B] tabular-nums">
              {ov.employee?.activeHeadcount ?? 0}
            </p>
          </div>
          <div
            className="rounded-lg bg-[#F7F4EF] px-3 py-2"
            title="Queue length as a share of a 2-week (14-day) buffer — 100% means two full weeks of work are queued. Not a machine/worker utilization figure."
          >
            <p className="text-[10px] uppercase tracking-wider text-[#9CA3AF]">
              Queue vs 14d
            </p>
            <p
              className="text-lg font-bold tabular-nums"
              style={{ color: gaugeAccent }}
            >
              {Math.round(util * 100)}%
            </p>
          </div>
        </div>
        <div className="mt-4 w-full border-t border-[#F0ECE6] pt-3 space-y-2">
          <button
            type="button"
            disabled={!prod?.capacityDays}
            onClick={() => {
              if (!prod?.capacityDays) return;
              const days = prod.capacityDays;
              // Average capacity per worker — avg daily capacity
              // ÷ avg workers/day. Days with zero credited workers are
              // left out so they don't distort the average.
              const wDays = days.filter((d) => (d.workers ?? 0) > 0);
              const avgWorkers = wDays.length
                ? wDays.reduce((s, d) => s + (d.workers ?? 0), 0) /
                  wDays.length
                : 0;
              const perWorkerAvg =
                avgWorkers > 0
                  ? hm(Math.round(prod.dailyCapacityMin / avgWorkers))
                  : "—";
              onDrill({
                title: capacityDrillTitle,
                subtitle: `Average ${hm(prod.dailyCapacityMin)}/day · ${perWorkerAvg}/worker across all production depts`,
                node: (
                  <MiniTable
                    cols={[
                      "Date",
                      "Production time",
                      "Workers",
                      "Per Worker",
                      "vs Avg",
                    ]}
                    rows={[...days]
                      .sort((a, b) => a.date.localeCompare(b.date))
                      .map((d) => {
                        const diff = d.minutes - prod.dailyCapacityMin;
                        const w = d.workers ?? 0;
                        return [
                          d.date,
                          hm(d.minutes),
                          w > 0 ? String(w) : "—",
                          w > 0 ? hm(Math.round(d.minutes / w)) : "—",
                          `${diff >= 0 ? "+" : "−"}${hm(Math.abs(diff))}`,
                        ];
                      })}
                  />
                ),
              });
            }}
            className="w-full flex items-center justify-between rounded-lg bg-[#F7F4EF] hover:bg-[#F0ECE6] px-3 py-2 text-left transition-colors"
          >
            <span className="flex items-center gap-2">
              <Factory className="h-4 w-4 text-[#6B5C32]" />
              <span className="text-xs text-[#5A5550]">
                Daily Capacity{" "}
                <span className="text-[#C2BBAE]">· {capacityWindowLabel}</span>
              </span>
            </span>
            <span className="text-sm font-bold text-[#1F1D1B] tabular-nums">
              {hrs(prod?.dailyCapacityMin)}
            </span>
          </button>
          <button
            type="button"
            disabled={!prod?.backlogByDept}
            onClick={() =>
              prod?.backlogByDept &&
              onDrill({
                title: "Total Backlog — per Department",
                subtitle: `${hm(prod.backlogGrandMin)} of active work across ${prod.backlogByDept.length} dept${prod.backlogByDept.length === 1 ? "" : "s"}`,
                node: (
                  <MiniTable
                    cols={[
                      "Department",
                      "Sofa",
                      "Bedframe",
                      "Total",
                      "Daily cap",
                      "Backlog",
                    ]}
                    rows={prod.backlogByDept.map((d) => [
                      d.dept,
                      hm(d.sofaMin),
                      hm(d.bedframeMin),
                      hm(d.totalMin),
                      `${hm(d.dailyCapMin)}/d`,
                      d.backlogDays == null ? "stalled" : `${d.backlogDays.toLocaleString()}d`,
                    ])}
                  />
                ),
              })
            }
            className="w-full flex items-center justify-between rounded-lg bg-[#F7F4EF] hover:bg-[#F0ECE6] px-3 py-2 text-left transition-colors"
          >
            <span className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-[#DC2626]" />
              <span className="text-xs text-[#5A5550]">
                Total Backlog{" "}
                <span className="text-[#C2BBAE]">· per dept</span>
              </span>
            </span>
            <span className="text-sm font-bold text-[#1F1D1B] tabular-nums">
              {backlogDays.toLocaleString()}d ·{" "}
              {hrs(prod?.backlogMin)}
            </span>
          </button>
          <button
            type="button"
            disabled={!prod?.activeJobs}
            onClick={() =>
              prod?.activeJobs &&
              onDrill({
                title: "Active Jobs — pending by customer",
                subtitle:
                  "Bedframe = pieces in production · Sofa = sets (1 SO = 1 set)",
                node: (
                  <MiniTable
                    cols={["Customer", "Bedframe units", "Sofa sets"]}
                    rows={prod.activeJobs.byCustomer.map((c) => [
                      c.customer,
                      c.bedframeUnits ? c.bedframeUnits.toLocaleString() : "—",
                      c.sofaSets ? c.sofaSets.toLocaleString() : "—",
                    ])}
                  />
                ),
              })
            }
            className="w-full flex items-center justify-between rounded-lg bg-[#F7F4EF] hover:bg-[#F0ECE6] px-3 py-2 text-left transition-colors"
          >
            <span className="flex items-center gap-2">
              <Package className="h-4 w-4 text-[#6B5C32]" />
              <span className="text-xs text-[#5A5550]">
                Active Jobs{" "}
                <span className="text-[#C2BBAE]">· pending</span>
              </span>
            </span>
            <span className="text-sm font-bold text-[#1F1D1B] tabular-nums">
              {(prod?.activeJobs?.bedframeUnits ?? 0).toLocaleString()} /{" "}
              {(prod?.activeJobs?.sofaSets ?? 0).toLocaleString()}
            </span>
          </button>
          <button
            type="button"
            disabled={!prod?.completedLast7}
            onClick={() =>
              prod?.completedLast7 &&
              onDrill({
                title: completedDrillTitle,
                subtitle:
                  "Production finished per day (last upholstery completed)",
                node: (
                  <MiniTable
                    cols={["Date", "Bedframe units", "Sofa sets"]}
                    rows={prod.completedLast7.map((d) => [
                      d.date,
                      d.bedframeUnits.toLocaleString(),
                      d.sofaSets.toLocaleString(),
                    ])}
                  />
                ),
              })
            }
            className="w-full flex items-center justify-between rounded-lg bg-[#F7F4EF] hover:bg-[#F0ECE6] px-3 py-2 text-left transition-colors"
          >
            <span className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-[#15803D]" />
              <span className="text-xs text-[#5A5550]">
                {completedHeadlineLabel}{" "}
                <span className="text-[#C2BBAE]">{completedHintLabel}</span>
              </span>
            </span>
            <span className="text-sm font-bold text-[#1F1D1B] tabular-nums">
              {completedHeadBf.toLocaleString()} /{" "}
              {completedHeadSofa.toLocaleString()}
            </span>
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

// Roll the last-12 monthly fabric series up into the last 8 quarters.
function toQuarterly(
  monthly: { month: string; meters: number; lateMeters?: number }[],
): { label: string; meters: number; lateMeters: number }[] {
  const q = new Map<string, { meters: number; lateMeters: number }>();
  for (const m of monthly) {
    const [y, mm] = m.month.split("-");
    const qn = Math.ceil((Number(mm) || 1) / 3);
    const key = `${y}-Q${qn}`;
    const e = q.get(key) ?? { meters: 0, lateMeters: 0 };
    e.meters += m.meters;
    e.lateMeters += m.lateMeters ?? 0;
    q.set(key, e);
  }
  return [...q.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-8)
    .map(([label, v]) => ({ label, ...v }))
    .reverse();
}

// /dashboard's "Fabric Usage — Bedframe vs Sofa" section for one period.
export function FabricUsageSection({ ov, period }: { ov: PlantLoadOverview; period: string }) {
  const [fabMode, setFabMode] = useState<"prev" | "next">("prev");
  const [fabGran, setFabGran] = useState<"month" | "quarter">("month");
  const fc = ov.fabricCostPerMeterSen;
  return (
    <div>
      <div className="flex items-end justify-between mb-3 flex-wrap gap-y-2">
        <div>
          <h3 className="text-sm font-bold text-[#1F1D1B] tracking-[-0.2px]">
            Fabric Usage — Bedframe vs Sofa
          </h3>
          <p className="text-xs text-[#9CA3AF] mt-0.5">
            {fabMode === "next"
              ? "forecast — fabric needed next 30 days"
              : "history — fabric used to date"}{" "}
            · {fabGran === "quarter" ? "quarterly trend" : "monthly trend"}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            {(["prev", "next"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setFabMode(m)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  fabMode === m
                    ? "bg-[#6B5C32] text-white"
                    : "bg-[#F5F2ED] text-[#5A5550] hover:bg-[#EAE5DC]"
                }`}
              >
                {m === "prev" ? "Previous" : "Next"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            {(["month", "quarter"] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setFabGran(g)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  fabGran === g
                    ? "bg-[#6B5C32] text-white"
                    : "bg-[#F5F2ED] text-[#5A5550] hover:bg-[#EAE5DC]"
                }`}
              >
                {g === "month" ? "Monthly" : "Quarterly"}
              </button>
            ))}
          </div>
        </div>
      </div>
      {fc && (
        <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)] mb-4">
          <CardContent className="py-4 px-5 flex flex-wrap items-center gap-x-10 gap-y-3">
            <div className="flex items-center gap-2">
              <Scissors className="h-4 w-4 text-[#6B5C32]" />
              <span className="text-xs font-semibold text-[#5A5550]">Fabric Cost / Meter</span>
            </div>
            <div>
              <p className="text-[11px] text-[#9CA3AF]">Overall (all issued)</p>
              <p className="text-xl font-bold text-[#1F1D1B] tabular-nums">{rm(fc.total)}</p>
            </div>
            <div>
              <p className="text-[11px] text-[#9CA3AF]">Excl. Bedframe &amp; Sofa</p>
              <p className="text-xl font-bold text-[#1F1D1B] tabular-nums">
                {fc.exclBedframeSofa > 0 ? rm(fc.exclBedframeSofa) : "—"}
              </p>
            </div>
            <p className="text-[10px] text-[#9CA3AF] max-w-[16rem]">
              Weighted avg of fabric actually issued to production (consumption).
            </p>
          </CardContent>
        </Card>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {(["BEDFRAME", "SOFA"] as const).map((cat) => {
          const blk = ov.fabric?.[cat];
          const trend =
            fabGran === "quarter"
              ? toQuarterly(blk?.monthly ?? [])
              : (blk?.monthly ?? [])
                  .map((m) => ({ label: m.month, meters: m.meters, lateMeters: m.lateMeters ?? 0 }))
                  // Newest at the top, read like a statement.
                  .reverse();
          const mMax = Math.max(1, ...trend.map((t) => t.meters));
          const fabRows =
            fabMode === "next"
              ? (blk?.list ?? [])
                  .filter((f) => f.next30Meters > 0)
                  .sort((a, b) => b.next30Meters - a.next30Meters)
                  .slice(0, 10)
              : (blk?.list ?? [])
                  .filter((f) => f.meters > 0)
                  .sort((a, b) => b.meters - a.meters)
                  .slice(0, 10);
          return (
            <Card key={cat} className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)] min-w-0">
              <CardContent className="p-5">
                <SectionTitle
                  title={`${cat === "BEDFRAME" ? "Bedframe" : "Sofa"} Fabric`}
                  sub={
                    fabMode === "next"
                      ? "forecast — next 30 days · purchase price /m"
                      : `used in ${period === "all" ? "all time" : period} · lifetime purchase price /m`
                  }
                  right={
                    <div className="text-right">
                      <p className="text-[10px] uppercase tracking-wider text-[#9CA3AF]">Avg cost /m</p>
                      <p className="text-sm font-bold text-[#1F1D1B] tabular-nums">
                        {rm(cat === "BEDFRAME" ? fc?.bedframe : fc?.sofa)}
                      </p>
                    </div>
                  }
                />
                {fabRows.length === 0 ? (
                  <p className="text-xs text-[#9CA3AF] py-3">
                    {fabMode === "next" ? "No upcoming fabric demand." : "No fabric issued."}
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-[10px] text-[#9CA3AF] border-b border-[#F0ECE6]">
                          <th className="font-medium pb-1.5">Fabric</th>
                          <th className="font-medium pb-1.5 text-right">
                            {fabMode === "next" ? "Next 30d" : "Used"}
                            {fabMode === "next" && (
                              <span className="ml-1 text-[8px] uppercase tracking-wide text-[#C9A961]">live</span>
                            )}
                          </th>
                          <th className="font-medium pb-1.5 text-right">
                            Past 30d
                            <span className="ml-1 text-[8px] uppercase tracking-wide text-[#C9A961]">live</span>
                          </th>
                          <th
                            className="font-medium pb-1.5 text-right"
                            title="Weighted average purchase price across all receipts to date — not scoped to the selected month."
                          >
                            Avg buy
                            <span className="ml-1 text-[8px] uppercase tracking-wide text-[#9CA3AF]">all time</span>
                          </th>
                          <th className="font-medium pb-1.5 text-right">Min–Max</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fabRows.map((f) => (
                          <tr key={f.fabCode} className="border-b border-[#F7F4EF]">
                            <td className="py-1 font-medium text-[#1F1D1B]">{f.fabCode}</td>
                            <td
                              className={`py-1 text-right tabular-nums font-semibold ${
                                fabMode === "next" ? "text-[#6B5C32]" : "text-[#1F1D1B]"
                              }`}
                            >
                              {fabMode === "next"
                                ? `${f.next30Meters.toLocaleString()} m`
                                : `${Math.round(f.meters).toLocaleString()} m`}
                            </td>
                            <td className="py-1 text-right tabular-nums text-[#5A5550]">
                              {f.past30Meters.toLocaleString()} m
                            </td>
                            <td className="py-1 text-right tabular-nums text-[#1F1D1B]">
                              {f.buyAvgSen ? rm(f.buyAvgSen) : "—"}
                            </td>
                            <td className="py-1 text-right tabular-nums text-[#9CA3AF]">
                              {f.buyMinSen || f.buyMaxSen ? `${rm(f.buyMinSen)}–${rm(f.buyMaxSen)}` : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="mt-3 border-t border-[#F0ECE6] pt-2 space-y-1">
                  <p className="text-[11px] font-semibold text-[#5A5550] mb-1">
                    {fabGran === "quarter" ? "Quarterly meters posted — last 8" : "Monthly meters posted — last 12"}
                  </p>
                  {trend.length === 0 ? (
                    <p className="text-xs text-[#9CA3AF]">No data.</p>
                  ) : (
                    trend.map((t) => (
                      <div key={t.label} className="flex items-center gap-2">
                        <span className="w-14 shrink-0 text-[11px] text-[#9CA3AF] tabular-nums">{t.label}</span>
                        <div className="flex-1 h-2.5 rounded bg-[#F5F2ED] overflow-hidden">
                          <div
                            className="h-full rounded"
                            style={{ width: `${Math.max(2, (t.meters / mMax) * 100)}%`, background: BROWN, opacity: 0.7 }}
                          />
                        </div>
                        <span className="w-16 text-right text-[11px] font-semibold text-[#1F1D1B] tabular-nums">
                          {Math.round(t.meters).toLocaleString()} m
                        </span>
                      </div>
                    ))
                  )}
                </div>
                <p className="text-[10px] text-[#9CA3AF] mt-2">
                  Fabric issued to {cat === "BEDFRAME" ? "bedframe" : "sofa"} production (RM_ISSUE). Bars are grouped
                  by the date the issue was POSTED — an order raised one month is routinely cut the next, so a bar is
                  not that month&rsquo;s production.
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
