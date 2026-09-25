// Operations tab — phone port of the desktop OperationsView (+ the plan and
// revenue panels of ProductionDailyPanels, + OverdueCards). Same cached feed,
// same maths (inPeriod / inFocus / the day-or-month bucket rule), phone layout.
// Sub-tab lives in ?sub= with the desktop's OPS_SUBS keys.
//
// Dropped vs desktop: the attendance log card (Employees tab owns it), the
// efficiency sparkline, the department filter + search on the due-soon list,
// chart tooltips / average reference line (the average is in the subtitle).
// MChartCard is single-series, so Plan vs Actual charts one series at a time
// (toggle) and the cost chart draws material + labor as one bar with the split
// shown as tiles.
import { useMemo, useState, type ReactNode } from "react";
import { useCachedJson } from "@/lib/cached-fetch";
import { formatCurrency } from "@/lib/utils";
import {
  dayLabel, fmtN, fmtRMAxis, inFocus, inPeriod, overallEfficiencyPct, periodLabel, type Period,
} from "../../../../dashboards/dashboard-shared-lib";
import { ListRow, MobileCard } from "../../../components";
import { M, M_ACCENT, M_DELTA } from "../../../theme";
import { compactSen, tapBucket } from "../dashboard-m-lib";
import { useDashboardSub } from "../hooks";
import { MChartCard, MFocusChip, MKpi, MKpiGrid, MRankList, MSection, MState, MSubPills } from "../primitives";
import { DASHBOARD_FEED_URL, type DashboardTabProps } from "../types";

// Mirrors the desktop views' Feed types. Every slice is optional: a 60s-cached
// payload from before a key existed must render an explanation, not crash.
type OrderSummary = {
  poNo: string | null;
  customer: string | null;
  productName: string | null;
  currentDept: string | null;
  daysToDD: number | null;
  stagesDone: number;
  stagesTotal: number;
};
type Feed = {
  success?: boolean;
  availability?: {
    production?: { live: boolean; reason?: string };
    inventory?: { live: boolean; reason?: string };
    lim?: { live: boolean; reason?: string };
  };
  production?: {
    orders?: OrderSummary[];
    overdueByDept?: { department: string; count: number }[];
    dueSoon3Days?: OrderSummary[];
    dailyOutput?: { date: string; orders: number; units: number }[];
    planVsActual?: {
      rows: { poNo: string | null; productName: string | null; plan: string; actual: string; varianceDays: number }[];
      onTime: number;
      late: number;
      withBothDates: number;
      completedTotal: number;
    };
    productionCost?: {
      byDay: { date: string; materialSen: number; laborSen: number; overheadSen: number; totalSen: number; batches: number }[];
      totalBatches: number;
      batchesWithCost: number;
    };
  };
  inventory?: {
    materialShortage?: { code: string | null; description: string | null; group: string | null; balanceQty: number }[];
  };
  employee?: {
    workers?: { id: string; countsToHeadcount: boolean }[];
    attendance?: { employeeId: string | null; date: string | null }[];
    performance?: { byDay?: { date: string; workingMinutes: number; productionMinutes: number }[] };
  };
  // `lim` is the feed's key for the daily production slice (backend name).
  lim?: {
    orders?: {
      byDay: { date: string; planOrders: number; planUnits: number; actualOrders: number; actualUnits: number }[];
      withoutTarget: number;
      completedTotal: number;
    };
    stages?: { byDay: { date: string; dept: string; plan: number; actual: number }[]; cardsWithoutDue: number };
    revenue?: {
      byDay: { date: string; orders: number; unpricedOrders: number; revenueSen: number }[];
      unpricedOrders: number;
    } | null;
    revenueError?: string;
  } | null;
};

const ROW_CAP = 100;
const NO_SLICE = "the feed carries no such slice (older cached response — reload in a minute — or no access)";

// Monthly/range -> one bar per day; YTD -> one bar per month (the desktop rule).
function bucket<T extends { date: string }>(rows: T[], p: Period, add: (a: T, b: T) => T) {
  if (p.mode !== "ytd") return rows.map((r) => ({ ...r, key: r.date.slice(5), iso: r.date }));
  const m = new Map<string, T & { key: string; iso: string }>();
  for (const r of rows) {
    const key = r.date.slice(0, 7);
    const cur = m.get(key);
    m.set(key, cur ? { ...add(cur, r), key, iso: key } : { ...r, key, iso: key });
  }
  return [...m.values()];
}

const pct1 = (v: number | null) => (v == null ? "—" : `${v.toFixed(1)}%`);
const signed = (v: number) => `${v > 0 ? "+" : ""}${fmtN(v)}`;
const money = (sen: number) => compactSen(sen, formatCurrency);

function Note({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 11.5, lineHeight: 1.45, color: M.muted, margin: "8px 4px 0" }}>{children}</div>;
}

function Missing({ what, reason }: { what: string; reason: string | undefined }) {
  return (
    <MobileCard>
      <MState kind="empty" text={`${what} isn't available: ${reason ?? NO_SLICE}.`} />
    </MobileCard>
  );
}

function Seg<T extends string>({ options, value, onChange }: {
  options: readonly { key: T; label: string }[];
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 6, flex: 1 }}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.key)}
            style={{
              flex: 1, minHeight: 44, borderRadius: 12, fontSize: 12.5, fontWeight: 600, cursor: "pointer",
              border: `1px solid ${on ? M.taupe : M.hairline}`, backgroundColor: on ? M.card : "transparent",
              color: on ? M.raisin : M.muted, WebkitTapHighlightColor: "transparent",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

type Pt = { iso: string; date: string; value: number; detail: string };
type PanelProps = { data: Feed; period: Period; setPeriod: (p: Period) => void };

// Tap rule is tapBucket (YTD opens the month, otherwise toggles period.day).
function TrendCard({ title, subtitle, rows, period, setPeriod, formatAxis, emptyText }: {
  title: string;
  subtitle: string;
  rows: Pt[];
  period: Period;
  setPeriod: (p: Period) => void;
  formatAxis?: (v: number) => string;
  emptyText: string;
}) {
  const selected = rows.find((d) => d.iso === period.day) ?? null;
  return (
    <MChartCard
      title={title}
      subtitle={selected ? `${dayLabel(selected.iso)} · ${selected.detail}` : subtitle}
      data={rows.map((d) => ({ key: d.date, value: d.value }))}
      selectedKey={selected?.date ?? null}
      onSelect={(k) => setPeriod(tapBucket(period, rows, k))}
      formatAxis={formatAxis}
      emptyText={emptyText}
    />
  );
}

const tapHint = (p: Period) => `tap a bar to ${p.mode === "ytd" ? "open that month" : "focus that day"}`;

// ---- Overview ---------------------------------------------------------------

function urgency(daysLeft: number | null) {
  if (daysLeft == null) return { label: "—", ...M_ACCENT.gold };
  if (daysLeft <= 1) return { label: daysLeft <= 0 ? "Due today / overdue" : "1 day left", ...M_ACCENT.danger };
  return { label: `${daysLeft} days left`, ...M_ACCENT.warning };
}

function OverviewPanel({ data, period, go }: { data: Feed; period: Period; go: (sub: string) => void }) {
  const { production, inventory, employee } = data;

  const overdue = useMemo(
    () => [...(production?.overdueByDept ?? [])].sort((a, b) => b.count - a.count),
    [production?.overdueByDept],
  );
  const totalOverdue = overdue.reduce((a, d) => a + d.count, 0);

  // Stage completion across every OPEN order — the "Plan vs Actual" headline.
  const stage = useMemo(() => {
    const orders = production?.orders ?? [];
    const done = orders.reduce((a, o) => a + o.stagesDone, 0);
    const total = orders.reduce((a, o) => a + o.stagesTotal, 0);
    return { done, total, pct: total > 0 ? (done / total) * 100 : null };
  }, [production?.orders]);

  const totalCostSen = useMemo(
    () => (production?.productionCost?.byDay ?? []).filter((d) => inFocus(period, d.date)).reduce((a, d) => a + d.totalSen, 0),
    [production?.productionCost?.byDay, period],
  );

  // Only PRESENT rows exist (no absence rows), so "has a row on the latest
  // date" is the honest ceiling, not a true present/absent split.
  const attendance = useMemo(() => {
    const rows = employee?.attendance ?? [];
    const headcount = (employee?.workers ?? []).filter((w) => w.countsToHeadcount).length;
    const latest = rows.reduce((m, r) => (r.date && r.date > m ? r.date : m), "");
    if (!latest || headcount === 0) return { pct: null, present: 0, headcount };
    const present = new Set(rows.filter((r) => r.date === latest && r.employeeId).map((r) => r.employeeId)).size;
    return { pct: (present / headcount) * 100, present, headcount };
  }, [employee]);

  // Same helper as the desktop Employees and Operations cards.
  const efficiencyPct = useMemo(
    () => overallEfficiencyPct(employee?.performance?.byDay ?? [], period),
    [employee, period],
  );

  const dueSoon = useMemo(
    () => [...(production?.dueSoon3Days ?? [])].sort((a, b) => (a.daysToDD ?? 0) - (b.daysToDD ?? 0)),
    [production?.dueSoon3Days],
  );
  const shortage = inventory?.materialShortage;
  const cost = production?.productionCost;

  return (
    <>
      {!production ? (
        <div style={{ marginBottom: 10 }}>
          <Missing what="Production data" reason={data.availability?.production?.reason} />
        </div>
      ) : null}
      <MKpiGrid>
        <MKpi label="Overdue orders" value={production ? fmtN(totalOverdue) : "—"} tone={M_ACCENT.danger.fg} sub="all departments" />
        <MKpi label="Due within 3 days" value={production ? fmtN(dueSoon.length) : "—"} tone={M_ACCENT.warning.fg} sub="early warning" />
        <MKpi
          label="Plan vs actual"
          value={pct1(stage.pct)}
          onClick={() => go("plan")}
          sub={
            <>
              <div style={{ height: 5, borderRadius: 3, background: M.divider, overflow: "hidden", margin: "3px 0" }}>
                <div style={{ width: `${Math.min(100, stage.pct ?? 0)}%`, height: "100%", background: M_DELTA.up }} />
              </div>
              {fmtN(stage.done)} / {fmtN(stage.total)} stages done, open orders
            </>
          }
        />
        <MKpi
          label="Material shortage"
          value={shortage ? fmtN(shortage.length) : "—"}
          sub={shortage ? "at zero/negative stock" : "no inventory feed"}
          onClick={() => go("materials")}
        />
        <MKpi
          label="Production cost"
          value={cost ? money(totalCostSen) : "—"}
          tone={M_ACCENT.info.fg}
          sub={cost ? `${fmtN(cost.batchesWithCost)}/${fmtN(cost.totalBatches)} batches costed` : "no cost data"}
          onClick={() => go("cost")}
        />
        <MKpi
          label="Attendance"
          value={pct1(attendance.pct)}
          sub={`${fmtN(attendance.present)} / ${fmtN(attendance.headcount)} recorded, latest day`}
        />
        <div style={{ gridColumn: "1 / -1" }}>
          <MKpi
            label="Efficiency"
            value={pct1(efficiencyPct)}
            tone={M_ACCENT.info.fg}
            sub={`production ÷ working minutes · ${periodLabel(period)}`}
          />
        </div>
      </MKpiGrid>

      <MSection title="Overdue by department" hint={`${fmtN(totalOverdue)} orders`}>
        <MRankList
          items={overdue.map((d) => ({ key: d.department, label: d.department, value: d.count, valueLabel: fmtN(d.count) }))}
          valueHeading="Overdue"
          emptyText="No overdue orders."
        />
      </MSection>

      <MSection
        title="Due within 3 days"
        hint={dueSoon.length > ROW_CAP ? `worst ${ROW_CAP} of ${fmtN(dueSoon.length)}` : "worst first"}
      >
        {dueSoon.length === 0 ? (
          <MobileCard><MState kind="empty" text="Nothing due in the next 3 days." /></MobileCard>
        ) : (
          <MobileCard padded={false} radius={16} style={{ overflow: "hidden" }}>
            {dueSoon.slice(0, ROW_CAP).map((o, i) => {
              const u = urgency(o.daysToDD);
              return (
                <ListRow
                  key={o.poNo ?? i}
                  code={o.poNo ?? "—"}
                  title={o.customer ?? "—"}
                  subLine={`${o.productName ?? "—"} · ${o.currentDept ?? "no dept"}`}
                  meta={[{ label: "Stages", value: `${fmtN(o.stagesDone)}/${fmtN(o.stagesTotal)}` }]}
                  pill={
                    <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 9999, fontSize: 11, fontWeight: 700, background: u.bg, color: u.fg }}>
                      {u.label}
                    </span>
                  }
                />
              );
            })}
          </MobileCard>
        )}
      </MSection>
    </>
  );
}

// ---- Output -----------------------------------------------------------------

function OutputPanel({ data, period, setPeriod }: PanelProps) {
  const daily = data.production?.dailyOutput;
  const rows = useMemo<Pt[]>(
    () =>
      bucket((daily ?? []).filter((d) => inPeriod(period, d.date)), period,
        (a, b) => ({ ...a, units: a.units + b.units, orders: a.orders + b.orders }))
        .map((d) => ({ iso: d.iso, date: d.key, value: d.units, detail: `${fmtN(d.units)} units · ${fmtN(d.orders)} orders` })),
    [daily, period],
  );
  if (!daily) return <Missing what="Production output" reason={data.availability?.production?.reason} />;
  const total = rows.reduce((a, d) => a + d.value, 0);
  const avg = rows.length ? total / rows.length : 0;
  const unit = period.mode === "ytd" ? "month" : "day";

  return (
    <>
      <MKpiGrid>
        <MKpi label="Units completed" value={fmtN(total)} tone={M.taupe} sub={periodLabel({ ...period, day: undefined })} />
        <MKpi label={`Average per ${unit}`} value={fmtN(Math.round(avg))} sub={`${fmtN(rows.length)} ${unit}s with output`} />
      </MKpiGrid>
      <MSection title="Production output">
        <TrendCard
          title={`${period.mode === "ytd" ? "Monthly" : "Daily"} production output`}
          subtitle={`Units by completion date · ${tapHint(period)}`}
          rows={rows}
          period={period}
          setPeriod={setPeriod}
          emptyText="No completions in range."
        />
        <Note>
          The average is a baseline to compare against, not an owner-set target — there is no configured target anywhere in the data.
        </Note>
      </MSection>
    </>
  );
}

// ---- Plan vs Actual ---------------------------------------------------------

const METRICS = [{ key: "units", label: "Units" }, { key: "orders", label: "Orders" }] as const;
const SERIES = [{ key: "actual", label: "Actual" }, { key: "plan", label: "Plan" }] as const;

function PlanPanel({ data, period, setPeriod }: PanelProps) {
  const [metric, setMetric] = useState<"units" | "orders">("units");
  const [series, setSeries] = useState<"actual" | "plan">("actual");
  const lim = data.lim ?? null;
  const pva = data.production?.planVsActual;

  const chart = useMemo<Pt[]>(
    () =>
      bucket((lim?.orders?.byDay ?? []).filter((d) => inPeriod(period, d.date)), period, (a, b) => ({
        ...a, planOrders: a.planOrders + b.planOrders, planUnits: a.planUnits + b.planUnits,
        actualOrders: a.actualOrders + b.actualOrders, actualUnits: a.actualUnits + b.actualUnits,
      })).map((d) => {
        const plan = metric === "units" ? d.planUnits : d.planOrders;
        const actual = metric === "units" ? d.actualUnits : d.actualOrders;
        return { iso: d.iso, date: d.key, value: series === "plan" ? plan : actual, detail: `plan ${fmtN(plan)} · actual ${fmtN(actual)} ${metric}` };
      }),
    [lim, period, metric, series],
  );
  const totals = useMemo(
    () =>
      (lim?.orders?.byDay ?? []).filter((d) => inFocus(period, d.date)).reduce(
        (a, d) => ({ po: a.po + d.planOrders, pu: a.pu + d.planUnits, ao: a.ao + d.actualOrders, au: a.au + d.actualUnits }),
        { po: 0, pu: 0, ao: 0, au: 0 },
      ),
    [lim, period],
  );
  const stageRows = useMemo(() => {
    const m = new Map<string, { dept: string; plan: number; actual: number }>();
    for (const r of lim?.stages?.byDay ?? []) {
      if (!inFocus(period, r.date)) continue;
      const e = m.get(r.dept) ?? { dept: r.dept, plan: 0, actual: 0 };
      e.plan += r.plan;
      e.actual += r.actual;
      m.set(r.dept, e);
    }
    return [...m.values()].sort((a, b) => a.dept.localeCompare(b.dept));
  }, [lim, period]);

  const unit = period.mode === "ytd" ? "month" : "day";
  const tone = (v: number) => (v >= 0 ? M_DELTA.up : M_DELTA.down);
  const pvaRows = pva?.rows ?? [];

  return (
    <>
      {!lim ? (
        <Missing what="Plan vs Actual" reason={data.availability?.lim?.reason} />
      ) : (
        <>
          <MKpiGrid>
            <MKpi label="Planned orders" value={fmtN(totals.po)} sub={`${fmtN(totals.pu)} units`} />
            <MKpi label="Completed orders" value={fmtN(totals.ao)} tone={M_DELTA.up} sub={`${fmtN(totals.au)} units`} />
            <MKpi label="Variance (orders)" value={signed(totals.ao - totals.po)} tone={tone(totals.ao - totals.po)} sub="completed − planned" />
            <MKpi label="Variance (units)" value={signed(totals.au - totals.pu)} tone={tone(totals.au - totals.pu)} sub="completed − planned" />
          </MKpiGrid>

          <MSection title={`Plan vs actual by ${unit}`}>
            <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
              <Seg options={SERIES} value={series} onChange={setSeries} />
              <Seg options={METRICS} value={metric} onChange={setMetric} />
            </div>
            <TrendCard
              title={`${series === "plan" ? "Plan" : "Actual"} · ${metric}`}
              subtitle={`${periodLabel(period)} · ${tapHint(period)}`}
              rows={chart}
              period={period}
              setPeriod={setPeriod}
              emptyText="Nothing recorded in this period."
            />
            <Note>
              Plan = orders whose target end date falls on the {unit}; Actual = orders COMPLETED on it. Two separate tallies —
              a late order counts as actual the day it finished and as plan the day it was due. Cancelled excluded.{" "}
              {fmtN(lim.orders?.withoutTarget ?? 0)} orders have no target end date and cannot appear in Plan;{" "}
              {fmtN(lim.orders?.completedTotal ?? 0)} are COMPLETED in total.
            </Note>
          </MSection>

          <MSection title="By department (stage)" hint={periodLabel(period)}>
            {stageRows.length === 0 ? (
              <MobileCard><MState kind="empty" text="No stage plan or completion in this window." /></MobileCard>
            ) : (
              <MobileCard padded={false} radius={16} style={{ overflow: "hidden" }}>
                {stageRows.map((r) => (
                  <ListRow
                    key={r.dept}
                    code=""
                    title={r.dept}
                    subLine={`Plan ${fmtN(r.plan)} · Actual ${fmtN(r.actual)} job cards`}
                    meta={[{ label: "Variance", value: <span style={{ color: tone(r.actual - r.plan) }}>{signed(r.actual - r.plan)}</span> }]}
                  />
                ))}
              </MobileCard>
            )}
            <Note>
              Counted in job cards (one card = one department stage of one order). Plan = cards due, Actual = cards
              completed/transferred in the window. 0 actual can mean nothing was recorded rather than nothing was done;{" "}
              {fmtN(lim.stages?.cardsWithoutDue ?? 0)} cards have no due date and are not in Plan.
            </Note>
          </MSection>
        </>
      )}

      <MSection
        title="On-time completion by order"
        hint={pvaRows.length > ROW_CAP ? `first ${ROW_CAP} of ${fmtN(pvaRows.length)}` : undefined}
      >
        {pvaRows.length === 0 ? (
          <MobileCard><MState kind="empty" text="No completed order carries both dates." /></MobileCard>
        ) : (
          <MobileCard padded={false} radius={16} style={{ overflow: "hidden" }}>
            {pvaRows.slice(0, ROW_CAP).map((r, i) => (
              <ListRow
                key={r.poNo ?? i}
                code={r.poNo ?? "—"}
                title={r.productName ?? "—"}
                subLine={`Plan ${r.plan} · Actual ${r.actual}`}
                meta={[{
                  label: "Variance",
                  value: (
                    <span style={{ color: r.varianceDays > 0 ? M_DELTA.down : M_DELTA.up }}>
                      {r.varianceDays > 0 ? `+${r.varianceDays}d` : r.varianceDays === 0 ? "on time" : `${-r.varianceDays}d early`}
                    </span>
                  ),
                }]}
              />
            ))}
          </MobileCard>
        )}
        {pva ? (
          <Note>
            {fmtN(pva.onTime)} / {fmtN(pva.withBothDates)} on time, of {fmtN(pva.completedTotal)} completed orders total. Not filtered by the period.
          </Note>
        ) : null}
      </MSection>
    </>
  );
}

// ---- Revenue & Cost ---------------------------------------------------------

function CostPanel({ data, period, setPeriod }: PanelProps) {
  const lim = data.lim ?? null;
  const revenue = lim?.revenue ?? null;
  const cost = data.production?.productionCost;

  // Chart values are whole RM (fmtRMAxis takes RM); money text stays in sen.
  const revChart = useMemo<Pt[]>(
    () =>
      bucket((revenue?.byDay ?? []).filter((d) => inPeriod(period, d.date)), period, (a, b) => ({
        ...a, orders: a.orders + b.orders, unpricedOrders: a.unpricedOrders + b.unpricedOrders, revenueSen: a.revenueSen + b.revenueSen,
      })).map((d) => ({
        iso: d.iso, date: d.key, value: Math.round(d.revenueSen / 100),
        detail: `${formatCurrency(d.revenueSen)} · ${fmtN(d.orders)} orders`,
      })),
    [revenue, period],
  );
  const rev = useMemo(
    () =>
      (revenue?.byDay ?? []).filter((d) => inFocus(period, d.date)).reduce(
        (a, d) => ({ sen: a.sen + d.revenueSen, orders: a.orders + d.orders, unpriced: a.unpriced + d.unpricedOrders }),
        { sen: 0, orders: 0, unpriced: 0 },
      ),
    [revenue, period],
  );
  const costChart = useMemo<Pt[]>(
    () =>
      bucket((cost?.byDay ?? []).filter((d) => inPeriod(period, d.date)), period,
        (a, b) => ({ ...a, materialSen: a.materialSen + b.materialSen, laborSen: a.laborSen + b.laborSen }))
        .map((d) => ({
          iso: d.iso, date: d.key, value: Math.round((d.materialSen + d.laborSen) / 100),
          detail: `material ${formatCurrency(d.materialSen)} · labor ${formatCurrency(d.laborSen)}`,
        })),
    [cost, period],
  );
  const costTotals = useMemo(
    () =>
      (cost?.byDay ?? []).filter((d) => inFocus(period, d.date)).reduce(
        (a, d) => ({ total: a.total + d.totalSen, material: a.material + d.materialSen, labor: a.labor + d.laborSen, overhead: a.overhead + d.overheadSen }),
        { total: 0, material: 0, labor: 0, overhead: 0 },
      ),
    [cost, period],
  );
  const unit = period.mode === "ytd" ? "month" : "day";

  return (
    <>
      {!lim ? (
        <Missing what="Production revenue" reason={data.availability?.lim?.reason} />
      ) : !revenue ? (
        <Missing what="Production revenue" reason={`order values could not be loaded (${lim.revenueError ?? "unknown error"})`} />
      ) : (
        <>
          <MKpiGrid>
            <MKpi label="Production revenue" value={money(rev.sen)} tone={M_ACCENT.info.fg} sub={periodLabel(period)} />
            <MKpi label="Orders upholstered" value={fmtN(rev.orders)} />
            <div style={{ gridColumn: "1 / -1" }}>
              <MKpi
                label="Completed with no price"
                value={fmtN(rev.unpriced)}
                tone={rev.unpriced ? M_ACCENT.warning.fg : undefined}
                sub="value could not be resolved (counted as RM 0)"
              />
            </div>
          </MKpiGrid>
          <MSection title="Production revenue">
            <TrendCard
              title={`Production revenue by ${unit}`}
              subtitle={`${periodLabel(period)} · ${tapHint(period)}`}
              rows={revChart}
              period={period}
              setPeriod={setPeriod}
              formatAxis={fmtRMAxis}
              emptyText="Nothing recorded in this period."
            />
            <Note>
              Value of production orders whose last upholstery job card completed on the {unit}: quantity × its sales-order
              line price. Sofa, bedframe and accessory only — same as the main Dashboard's Production line. Not invoiced revenue.
            </Note>
          </MSection>
        </>
      )}

      <MSection title="Production cost" hint={periodLabel(period)}>
        {!cost ? (
          <Missing what="Production cost" reason={data.availability?.production?.reason} />
        ) : (
          <>
            <MKpiGrid>
              <MKpi
                label="Total cost"
                value={money(costTotals.total)}
                tone={M_ACCENT.info.fg}
                sub={`${fmtN(cost.batchesWithCost)}/${fmtN(cost.totalBatches)} batches costed`}
              />
              <MKpi label="Material" value={money(costTotals.material)} />
              <MKpi label="Labor" value={money(costTotals.labor)} />
              <MKpi label="Overhead" value={money(costTotals.overhead)} sub="in the total, not charted" />
            </MKpiGrid>
            <div style={{ height: 10 }} />
            <TrendCard
              title={`Material + labor by ${unit}`}
              subtitle={tapHint(period)}
              rows={costChart}
              period={period}
              setPeriod={setPeriod}
              formatAxis={fmtRMAxis}
              emptyText="No costed batches."
            />
            <Note>Reads finished-goods batches; most batches read RM 0 until their cost is settled.</Note>
          </>
        )}
      </MSection>
    </>
  );
}

// ---- Materials --------------------------------------------------------------

function MaterialsPanel({ data }: { data: Feed }) {
  const rows = data.inventory?.materialShortage;
  if (!rows) return <Missing what="Material shortage" reason={data.availability?.inventory?.reason} />;
  return (
    <MSection
      title="Material shortage"
      hint={rows.length > ROW_CAP ? `first ${ROW_CAP} of ${fmtN(rows.length)}` : `${fmtN(rows.length)} items`}
    >
      {rows.length === 0 ? (
        <MobileCard><MState kind="empty" text="Nothing at zero or negative stock." /></MobileCard>
      ) : (
        <MobileCard padded={false} radius={16} style={{ overflow: "hidden" }}>
          {rows.slice(0, ROW_CAP).map((m, i) => (
            <ListRow
              key={m.code ?? i}
              code={m.code ?? "—"}
              title={m.description ?? "—"}
              subLine={m.group ?? undefined}
              meta={[{ label: "Balance", value: <span style={{ color: M_DELTA.down }}>{fmtN(m.balanceQty)}</span> }]}
            />
          ))}
        </MobileCard>
      )}
      <Note>
        Proxy, not a real reorder-point check: minimum stock is 0 on every raw material, so this lists active items
        sitting at zero or negative balance instead.
      </Note>
    </MSection>
  );
}

// ---- Tab --------------------------------------------------------------------

export function OperationsTab({ period, setPeriod }: DashboardTabProps) {
  const { sub, setSub, subs } = useDashboardSub("operations");
  const { data, loading, error } = useCachedJson<Feed>(DASHBOARD_FEED_URL);

  let body: ReactNode;
  if (loading) body = <MState kind="loading" />;
  else if (error || !data?.success) body = <MState kind="error" text={`Couldn't load Operations: ${error ?? "unknown error"}`} />;
  else if (sub === "production") body = <OutputPanel data={data} period={period} setPeriod={setPeriod} />;
  else if (sub === "plan") body = <PlanPanel data={data} period={period} setPeriod={setPeriod} />;
  else if (sub === "cost") body = <CostPanel data={data} period={period} setPeriod={setPeriod} />;
  else if (sub === "materials") body = <MaterialsPanel data={data} />;
  else body = <OverviewPanel data={data} period={period} go={setSub} />;

  return (
    <>
      <MSubPills subs={subs} active={sub} onChange={setSub} />
      <div style={{ padding: "12px 14px 0" }}>
        {period.day ? (
          <div style={{ marginBottom: 10 }}>
            <MFocusChip label={dayLabel(period.day)} onClear={() => setPeriod({ ...period, day: undefined })} />
          </div>
        ) : null}
        {body}
      </div>
    </>
  );
}
