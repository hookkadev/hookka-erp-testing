import { Fragment, useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Info } from "lucide-react";
import { useCachedJson } from "@/lib/cached-fetch";
import { agingBucketTotals } from "@/lib/aging-export";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  completedHeadline, customerRevenue, capacityPerWorkerMin, deptBacklogRows, fabricView,
  financeRatios, orderPipeline, pendingDeliveryTotalSen, plantLoad, stateTags,
  type CustCat, type DoStatsResp, type FinanceDashRow, type Overview, type PendingValueResp,
  type SoStats, type StateSnapshot,
} from "./dashboard-widgets-lib";
import {
  AMBER, BORDER, CARD_BG, CARD_BORDER, CHART_AXIS, CHART_GOLD, CHART_INK, CHART_SERIES, GREEN, MUTED, RED, TEAL,
  widgetPeriod, widgetPeriodLabel, fmtDec2, fmtHM, fmtN, fmtPct2, fmtRM2, type Period,
} from "./dashboard-shared-lib";

// ---------------------------------------------------------------------------
// Widgets added to /dashboard-experimental (director 2026-09-23:
// every widget on /dashboard must also exist here). Each card reads the SAME
// URL /dashboard reads and derives its figures with the formulas in
// ./dashboard-widgets-lib.ts (which mirror dashboard-b/index.tsx).
//
// Owner rules: no rounding — money via fmtRM2, % via fmtPct2, decimals via
// fmtDec2, minutes via fmtHM, all TRUNCATED. A failed load never prints 0.
// /dashboard's period is a month or all-time, so YTD reads all-time
// and a highlighted day reads its month; every card title says which.
// ---------------------------------------------------------------------------

type Loaded<T> = { data: T | null; loading: boolean };

/** The payload, or null while loading / after a failed or `success:false` load. */
function ok<T extends { success?: boolean }>(r: Loaded<T>): T | null {
  return r.data && r.data.success !== false ? r.data : null;
}

function useOverview(period: Period) {
  return useCachedJson<Overview>(`/api/dashboard/overview?period=${widgetPeriod(period)}`);
}

function CardShell({ title, sub, right, children }: { title: string; sub?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>{title}</CardTitle>
            {sub && <p className="mt-0.5 text-xs" style={{ color: MUTED }}>{sub}</p>}
          </div>
          {right}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** Loading / failed placeholder. A failed load says so — never a 0. */
function Gate({ loading, what }: { loading: boolean; what: string }) {
  return loading ? (
    <p className="py-6 text-center text-xs" style={{ color: MUTED }}>Loading…</p>
  ) : (
    <p className="py-6 text-center text-xs" style={{ color: AMBER }}>Couldn't load {what} — not shown as zero.</p>
  );
}

function Pills<T extends string>({ value, options, onChange }: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center gap-1">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            value === v ? "bg-[#6B5C32] text-white" : "bg-[#F5F2ED] text-[#5A5550] hover:bg-[#EAE5DC]"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function LegendToggle({ items, hidden, onToggle }: { items: readonly (readonly [string, string])[]; hidden: Set<string>; onToggle: (k: string) => void }) {
  return (
    <div className="flex flex-wrap gap-3 text-xs">
      {items.map(([k, c]) => {
        const off = hidden.has(k);
        return (
          <button
            key={k}
            type="button"
            onClick={() => onToggle(k)}
            className="inline-flex items-center gap-1"
            style={{ color: off ? "#C2BBAE" : c, opacity: off ? 0.55 : 1, textDecoration: off ? "line-through" : "none" }}
          >
            ● {k}
          </button>
        );
      })}
    </div>
  );
}

function useToggleSet() {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setHidden((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  return [hidden, toggle] as const;
}

function MiniTable({ cols, rows }: { cols: string[]; rows: (string | number)[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b text-left" style={{ borderColor: BORDER, color: MUTED }}>
            {cols.map((c, i) => (
              <th key={c} className={`py-1.5 font-medium ${i ? "text-right" : ""}`}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b border-[#F0ECE6]">
              {r.map((v, i) => (
                <td key={i} className={`py-1 tabular-nums ${i ? "text-right" : ""} text-[#1F1D1B]`}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Month-awareness of the point-in-time STATE widgets — same tags as /dashboard. */
function StateTags({ ss }: { ss: StateSnapshot | undefined }) {
  const t = stateTags(ss);
  const chip = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium";
  return (
    <div className="flex flex-wrap gap-1.5">
      {t.liveTag && (
        <span className={`${chip} bg-[#FBF3E2] text-[#9A7B2E]`} title="No daily snapshot was stored for this past month, so the current live figures are shown — not that month's true state.">
          <Info className="h-3 w-3" /> live (no history before today)
        </span>
      )}
      {t.reconstructed && (
        <span className={`${chip} bg-[#EEF1F4] text-[#5B6675]`} title="Reconstructed as of the month's last day — a best-effort estimate, not a captured figure.">
          <Info className="h-3 w-3" /> ≈ reconstructed (month-end est.)
        </span>
      )}
      {t.asOf && (
        <span className={`${chip} bg-[#EEF3EE] text-[#4B7A52]`}>
          <Info className="h-3 w-3" /> as of {t.asOf}
        </span>
      )}
    </div>
  );
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-[#F7F4EF] px-3 py-2">
      <p className="truncate text-[10px] uppercase tracking-wider" style={{ color: MUTED }}>{label}</p>
      <p className="truncate text-lg font-bold tabular-nums" style={{ color: color ?? "#1F1D1B" }}>{value}</p>
      {sub && <p className="truncate text-[10px]" style={{ color: MUTED }}>{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

export function OrderPipelineCard({ period }: { period: Period }) {
  const wp = widgetPeriod(period);
  const label = widgetPeriodLabel(period);
  const soR = useCachedJson<SoStats>("/api/sales-orders/stats");
  const ovR = useOverview(period);
  const pendR = useCachedJson<PendingValueResp>("/api/delivery-orders/pending-value");
  const doR = useCachedJson<DoStatsResp & { success?: boolean }>("/api/delivery-orders/stats");
  const so = ok(soR);
  const ov = ok(ovR);
  const pend = ok(pendR);
  const doStats = ok(doR);
  const monthScoped = wp !== "all";
  const pipe = so && ov ? orderPipeline(wp, so, ov) : null;
  return (
    <CardShell
      title={`Order Pipeline — ${label}`}
      sub={monthScoped ? `${label} orders — shipped vs still to ship` : "confirmed → outstanding → delivered"}
      right={
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-wider" style={{ color: MUTED }}>Delivered rate</p>
          <p className="text-base font-bold tabular-nums" style={{ color: GREEN }}>{pipe ? fmtPct2(pipe.deliveredRate) : "—"}</p>
        </div>
      }
    >
      <div className="mb-3 grid grid-cols-2 gap-3">
        <Stat
          label="Pending Delivery · live"
          value={pend && doStats ? fmtRM2(pendingDeliveryTotalSen(pend, doStats)) : pendR.loading || doR.loading ? "…" : "—"}
          sub={pend && doStats ? "made / on DO, not yet delivered" : pendR.loading || doR.loading ? "loading" : "couldn't load — not shown as zero"}
        />
        <Stat
          label="Outstanding · live"
          value={so ? fmtRM2(so.outstandingItemsSen ?? 0) : soR.loading ? "…" : "—"}
          sub={so ? "confirmed · not yet delivered" : soR.loading ? "loading" : "couldn't load — not shown as zero"}
        />
      </div>
      {!pipe ? (
        <Gate loading={soR.loading || ovR.loading} what="the order pipeline" />
      ) : (
        <>
          {[
            { k: "Confirmed", v: pipe.confirmed, c: CHART_INK, pct: 100 },
            { k: "Outstanding", v: pipe.outstanding, c: CHART_GOLD, pct: pipe.outstandingPct },
            { k: "Delivered", v: pipe.delivered, c: GREEN, pct: pipe.deliveredRate },
          ].map((s) => (
            <div key={s.k} className="flex items-center gap-3 py-1.5">
              <span className="w-24 text-xs text-[#5A5550]">{s.k}</span>
              <div className="h-3 flex-1 overflow-hidden rounded-full bg-[#F5F2ED]">
                <div className="h-full rounded-full" style={{ width: `${Math.max(3, (s.v / pipe.max) * 100)}%`, background: s.c }} />
              </div>
              <span className="w-16 text-right text-[11px] tabular-nums" style={{ color: MUTED }}>{fmtPct2(s.pct)}</span>
              <span className="w-28 text-right text-xs font-semibold tabular-nums text-[#1F1D1B]">{fmtRM2(s.v)}</span>
            </div>
          ))}
          <p className="mt-2 text-[11px]" style={{ color: MUTED }}>
            {fmtRM2(pipe.outstanding)} still to ship of {fmtRM2(pipe.confirmed)} confirmed{monthScoped ? ` · ${label}` : ""}.
          </p>
        </>
      )}
    </CardShell>
  );
}

const REV_SERIES = [
  ["Sales Orders", CHART_INK],
  ["Production", CHART_GOLD],
  ["Invoices", TEAL],
] as const;

export function RevenueTrendCard({ period }: { period: Period }) {
  const label = widgetPeriodLabel(period);
  const ovR = useOverview(period);
  const ov = ok(ovR);
  const [hidden, toggle] = useToggleSet();
  // Values stay in sen; only the axis/tooltip format them (truncated).
  const data = (ov?.weeklyRevenue ?? []).map((r) => ({
    m: r.week.slice(5),
    "Sales Orders": r.salesOrderSen,
    Invoices: r.invoiceSen,
    Production: r.productionSen,
  }));
  return (
    <CardShell
      title={widgetPeriod(period) === "all" ? "Revenue — last 12 weeks (All-time)" : `Revenue — ${label}`}
      sub="Sales Orders · Invoices · Production · click a legend to toggle"
      right={<LegendToggle items={REV_SERIES} hidden={hidden} onToggle={toggle} />}
    >
      {!ov ? (
        <Gate loading={ovR.loading} what="revenue" />
      ) : data.length === 0 ? (
        <p className="py-6 text-center text-xs" style={{ color: MUTED }}>No revenue data.</p>
      ) : (
        <div className="select-none [&_*]:outline-none" style={{ width: "100%", height: 260 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={CARD_BORDER} vertical={false} />
              <XAxis dataKey="m" tick={{ fontSize: 10, fill: CHART_AXIS }} axisLine={{ stroke: BORDER }} tickLine={false} />
              <YAxis tickFormatter={(v: number) => `RM ${fmtN(Math.trunc(v / 100_000))}k`} tick={{ fontSize: 10, fill: CHART_AXIS }} axisLine={false} tickLine={false} width={64} />
              <Tooltip
                formatter={(v) => fmtRM2(Number(v))}
                contentStyle={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}`, borderRadius: 8, fontSize: 12 }}
              />
              {REV_SERIES.map(([k, c]) => (
                <Line key={k} type="monotone" dataKey={k} stroke={c} strokeWidth={2} dot={false} isAnimationActive={false} hide={hidden.has(k)} strokeDasharray={k === "Invoices" ? "4 3" : undefined} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </CardShell>
  );
}

const CUST_CATS = [["all", "All"], ["bedframe", "Bedframe"], ["sofa", "Sofa"]] as const;

export function CustomerRevenueCard({ period }: { period: Period }) {
  const label = widgetPeriodLabel(period);
  const ovR = useOverview(period);
  const ov = ok(ovR);
  const [cat, setCat] = useState<CustCat>("all");
  const [open, setOpen] = useState<string | null>(null);
  const cr = ov ? customerRevenue(ov, cat) : null;
  const co = ov?.aovCompany;
  const showBed = cat !== "sofa";
  const showSofa = cat !== "bedframe";
  const cols = ["Customer", ...(showBed ? ["Bedframe AOV", "Units"] : []), ...(showSofa ? ["Sofa AOV", "Sets"] : []), "Total"];
  const dash = (n: number, v: string) => (n ? v : "—");
  return (
    <CardShell
      title={`Sales by Customer — ${label}`}
      sub={`${cat === "all" ? "avg order value — bedframe (per unit) vs sofa (per set)" : cat === "bedframe" ? "bedframe only — avg per unit" : "sofa only — avg per set"} · click a customer for the monthly breakdown`}
      right={
        <div className="flex flex-wrap items-center gap-3">
          <Pills value={cat} options={CUST_CATS} onChange={(v) => { setCat(v); setOpen(null); }} />
          <span className="text-[11px]" style={{ color: MUTED }}>
            Total <span className="font-semibold text-[#1F1D1B]">{cr ? fmtRM2(cr.totalSen) : "—"}</span>
          </span>
        </div>
      }
    >
      {!cr ? (
        <Gate loading={ovR.loading} what="customer revenue" />
      ) : cr.composition.length === 0 ? (
        <p className="py-6 text-center text-xs" style={{ color: MUTED }}>No customer revenue.</p>
      ) : (
        <div className="space-y-4">
          {/* Composition of the period's WHOLE revenue: top 6 + Others. */}
          <div>
            <div className="flex h-4 w-full overflow-hidden rounded" role="img" aria-label="Revenue share by customer">
              {cr.composition.map((c, i) => (
                <div key={c.name} title={`${c.name} ${fmtRM2(c.valueSen)}`} style={{ width: `${cr.totalSen > 0 ? (c.valueSen / cr.totalSen) * 100 : 0}%`, background: CHART_SERIES[i % CHART_SERIES.length] }} />
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#5A5550]">
              {cr.composition.map((c, i) => (
                <span key={c.name} className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-sm" style={{ background: CHART_SERIES[i % CHART_SERIES.length] }} />
                  {c.name} <span className="tabular-nums" style={{ color: MUTED }}>{fmtPct2(cr.totalSen > 0 ? (c.valueSen / cr.totalSen) * 100 : null)}</span>
                </span>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-[11px]" style={{ borderColor: BORDER, color: MUTED }}>
                  {cols.map((c, i) => <th key={c} className={`py-1.5 font-medium ${i ? "text-right" : ""}`}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {co && (
                  <tr className="border-b-2 bg-[#FAF8F4]" style={{ borderColor: BORDER }}>
                    <td className="py-1.5 font-bold text-[#1F1D1B]">All customers</td>
                    {showBed && <><td className="py-1.5 text-right font-semibold tabular-nums">{dash(co.bedframeUnits, fmtRM2(co.bedframeAvgSen))}</td><td className="py-1.5 text-right tabular-nums" style={{ color: MUTED }}>{dash(co.bedframeUnits, fmtN(co.bedframeUnits))}</td></>}
                    {showSofa && <><td className="py-1.5 text-right font-semibold tabular-nums">{dash(co.sofaSets, fmtRM2(co.sofaAvgSen))}</td><td className="py-1.5 text-right tabular-nums" style={{ color: MUTED }}>{dash(co.sofaSets, fmtN(co.sofaSets))}</td></>}
                    <td className="py-1.5 text-right font-bold tabular-nums">{fmtRM2(cr.totalSen)}</td>
                  </tr>
                )}
                {cr.rows.slice(0, 10).map((a) => {
                  const monthly = ov?.aovMonthlyByCustomer?.[a.customerName] ?? [];
                  const isOpen = open === a.customerName;
                  return (
                    <Fragment key={a.customerName}>
                      <tr className="cursor-pointer border-b border-[#F0ECE6] hover:bg-[#FAF8F4]" onClick={() => setOpen(isOpen ? null : a.customerName)}>
                        <td className="py-1.5 text-[#1F1D1B]">
                          {a.customerName} <span className="text-[10px]" style={{ color: MUTED }}>· monthly {isOpen ? "▾" : "›"}</span>
                        </td>
                        {showBed && <><td className="py-1.5 text-right tabular-nums">{dash(a.bedframeUnits, fmtRM2(a.bedframeAvgSen))}</td><td className="py-1.5 text-right tabular-nums" style={{ color: MUTED }}>{dash(a.bedframeUnits, fmtN(a.bedframeUnits))}</td></>}
                        {showSofa && <><td className="py-1.5 text-right tabular-nums">{dash(a.sofaSets, fmtRM2(a.sofaAvgSen))}</td><td className="py-1.5 text-right tabular-nums" style={{ color: MUTED }}>{dash(a.sofaSets, fmtN(a.sofaSets))}</td></>}
                        <td className="py-1.5 text-right font-semibold tabular-nums">{fmtRM2(a.catRevSen)}</td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={cols.length} className="bg-[#FAF8F4] px-3 py-2">
                            <p className="mb-1 text-[11px]" style={{ color: MUTED }}>
                              {monthly.length ? "Average per month, by SO date." : "No monthly split — all-time average."} Bedframe per unit · Sofa per set.
                            </p>
                            <MiniTable
                              cols={["Month", "Bedframe AOV", "Units", "Sofa AOV", "Sets"]}
                              rows={(monthly.length ? monthly : [{ month: "All-time", ...a }]).map((m) => [
                                m.month,
                                dash(m.bedframeUnits, fmtRM2(m.bedframeAvgSen)),
                                dash(m.bedframeUnits, fmtN(m.bedframeUnits)),
                                dash(m.sofaSets, fmtRM2(m.sofaAvgSen)),
                                dash(m.sofaSets, fmtN(m.sofaSets)),
                              ])}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px]" style={{ color: MUTED }}>
            Concentration:{" "}
            {!cr.slice || cr.shares.largestPct == null ? (
              <><b className="text-[#1F1D1B]">—</b> no {cat !== "all" ? `${cat} ` : ""}revenue observed in this period, so no share of it can be stated.</>
            ) : (
              <>
                <b className="text-[#1F1D1B]">Largest customer = {fmtPct2(cr.shares.largestPct)}</b>
                {cr.slice.largestName ? ` (${cr.slice.largestName})` : ""} · <b className="text-[#1F1D1B]">Top 10 = {fmtPct2(cr.shares.top10Pct)}</b> of TOTAL{" "}
                {cat !== "all" ? `${cat} ` : ""}revenue ({fmtRM2(cr.slice.totalSen)}) across all {fmtN(cr.slice.customerCount)} customers
                {cr.shownCount != null && cr.shownCount < cr.slice.customerCount ? ` — the table lists the top ${cr.shownCount}` : ""}.
              </>
            )}
          </p>
        </div>
      )}
    </CardShell>
  );
}

export function TopSellersCard({ period }: { period: Period }) {
  const ovR = useOverview(period);
  const ov = ok(ovR);
  const [open, setOpen] = useState<string | null>(null);
  const bed = (ov?.topSellers?.BEDFRAME ?? []).slice(0, 6).map((p) => ({
    key: `B:${p.productCode}`, name: p.productCode, qty: `×${fmtN(p.qtySold)}`, valueSen: p.valueSen,
    drill: (ov?.topSellersByCustomer?.BEDFRAME?.[p.productCode] ?? []).map((c) => [c.customer, fmtN(c.qty), fmtRM2(c.valueSen)]),
    unit: "Units",
  }));
  const sofa = (ov?.topSellers?.SOFA ?? []).slice(0, 6).map((p) => ({
    key: `S:${p.model}`, name: p.model, qty: `×${fmtN(p.setsSold)} sets`, valueSen: p.valueSen,
    drill: (ov?.topSellersByCustomer?.SOFA?.[p.model] ?? []).map((c) => [c.customer, fmtN(c.sets), fmtRM2(c.valueSen)]),
    unit: "Sets",
  }));
  return (
    <CardShell title={`Top Sellers — ${widgetPeriodLabel(period)}`} sub="bedframe by units · sofa by sets · click for customers">
      {!ov ? (
        <Gate loading={ovR.loading} what="top sellers" />
      ) : (
        <div className="grid grid-cols-2 gap-5 max-sm:grid-cols-1">
          {([["Bedframe", bed], ["Sofa", sofa]] as const).map(([title, list]) => (
            <div key={title}>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#5A5550]">{title}</p>
              {list.length === 0 && <p className="text-xs" style={{ color: MUTED }}>No sales in this period.</p>}
              {list.map((p) => (
                <div key={p.key}>
                  <button
                    type="button"
                    disabled={!p.drill.length}
                    onClick={() => setOpen(open === p.key ? null : p.key)}
                    className="flex w-full items-center justify-between rounded py-0.5 text-left text-sm enabled:hover:bg-[#FAF8F4]"
                  >
                    <span className="truncate pr-2 text-[#5A5550]">
                      <span className="font-medium text-[#1F1D1B]">{p.name}</span> <span className="text-xs" style={{ color: MUTED }}>{p.qty}</span>
                    </span>
                    <span className="text-xs font-semibold tabular-nums text-[#1F1D1B]">{fmtRM2(p.valueSen)}</span>
                  </button>
                  {open === p.key && (
                    <div className="mb-2 rounded bg-[#FAF8F4] px-2 py-1">
                      <MiniTable cols={["Customer", p.unit, "Value"]} rows={p.drill} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const TONE = { red: RED, amber: AMBER, green: GREEN } as const;

export function PlantLoadCard({ period }: { period: Period }) {
  const ovR = useOverview(period);
  const ov = ok(ovR);
  const prod = ov?.production;
  const pl = plantLoad(prod, true);
  const perWorker = prod ? capacityPerWorkerMin(prod.capacityDays ?? [], prod.dailyCapacityMin) : null;
  return (
    <CardShell title={`Plant Load — ${widgetPeriodLabel(period)}`} sub="backlog vs daily capacity">
      {!prod ? (
        <Gate loading={ovR.loading} what="plant load" />
      ) : (
        <div className="space-y-3">
          <StateTags ss={ov?.stateSnapshot} />
          <div>
            <div className="flex items-baseline justify-between">
              <span className="text-3xl font-[800] tabular-nums" style={{ color: TONE[pl.tone] }}>{fmtDec2(pl.days)}d</span>
              <span className="text-xs" style={{ color: MUTED }}>queue</span>
            </div>
            <div className="mt-1 h-2.5 overflow-hidden rounded bg-[#F5F2ED]" title="Queue length as a share of a 2-week (14-day) buffer — 100% means two full weeks of work are queued. Not a machine/worker utilisation figure.">
              <div className="h-full rounded" style={{ width: `${pl.bufferPct}%`, background: TONE[pl.tone] }} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <Stat label="Queue vs 14d" value={fmtPct2(pl.bufferPct)} color={TONE[pl.tone]} sub="of a 14-day buffer" />
            <Stat label="Workforce" value={fmtN(ov?.employee?.activeHeadcount ?? 0)} sub="active headcount" />
            <Stat label="Daily capacity" value={fmtHM(prod.dailyCapacityMin)} sub={`${perWorker == null ? "—" : fmtHM(perWorker)} per worker · ${widgetPeriod(period) === "all" ? "7-day avg" : "month avg"}`} />
            <Stat label="Total backlog" value={fmtHM(prod.backlogMin)} sub={`${fmtDec2(pl.days)}d of work`} />
            <Stat label="Active jobs" value={`${fmtN(prod.activeJobs?.bedframeUnits ?? 0)} / ${fmtN(prod.activeJobs?.sofaSets ?? 0)}`} sub="bedframe units / sofa sets" />
          </div>
          <div>
            <p className="mb-1 text-[11px] font-semibold text-[#5A5550]">Daily capacity per day</p>
            <MiniTable
              cols={["Date", "Production time", "Workers", "Per worker", "vs Avg"]}
              rows={[...(prod.capacityDays ?? [])]
                .sort((a, b) => a.date.localeCompare(b.date))
                .map((d) => {
                  const diff = d.minutes - prod.dailyCapacityMin;
                  const w = d.workers ?? 0;
                  return [d.date, fmtHM(d.minutes), w > 0 ? fmtN(w) : "—", w > 0 ? fmtHM(d.minutes / w) : "—", `${diff >= 0 ? "+" : "−"}${fmtHM(Math.abs(diff))}`];
                })}
            />
          </div>
        </div>
      )}
    </CardShell>
  );
}

const DEPT_SERIES = [["Sofa", TEAL], ["Bedframe", CHART_INK]] as const;

export function DeptBacklogCard({ period }: { period: Period }) {
  const ovR = useOverview(period);
  const ov = ok(ovR);
  const prod = ov?.production;
  const [hidden, toggle] = useToggleSet();
  const sofaOn = !hidden.has("Sofa");
  const bedOn = !hidden.has("Bedframe");
  const { rows, mxDays } = deptBacklogRows(prod?.backlogByDept ?? [], sofaOn, bedOn, true);
  return (
    <CardShell
      title={`Department Backlog — ${widgetPeriodLabel(period)}`}
      sub="active work vs daily capacity — bottleneck first · click a legend to toggle"
      right={<LegendToggle items={DEPT_SERIES} hidden={hidden} onToggle={toggle} />}
    >
      {!prod ? (
        <Gate loading={ovR.loading} what="department backlog" />
      ) : (
        <div className="space-y-1">
          <StateTags ss={ov?.stateSnapshot} />
          {rows.length === 0 && <p className="text-xs" style={{ color: MUTED }}>No active work.</p>}
          {rows.map(({ d, sofaDays, bedDays, showDays }) => (
            <div key={d.dept} className="flex items-center gap-3 py-1">
              <span className="w-28 text-xs text-[#1F1D1B]">{d.dept}</span>
              <div className="flex h-2.5 flex-1 overflow-hidden rounded bg-[#F5F2ED]">
                {sofaOn && <div className="h-full" style={{ width: `${(sofaDays / mxDays) * 100}%`, background: TEAL }} />}
                {bedOn && <div className="h-full" style={{ width: `${(bedDays / mxDays) * 100}%`, background: CHART_INK }} />}
              </div>
              <span className="w-16 text-right text-xs font-semibold tabular-nums" style={{ color: RED }} title={showDays == null ? "No completions in the rolling window — the queue can't be sized in days" : undefined}>
                {showDays == null ? "stalled" : `${fmtDec2(showDays)}d`}
              </span>
            </div>
          ))}
        </div>
      )}
    </CardShell>
  );
}

export function CompletedCard({ period }: { period: Period }) {
  const wp = widgetPeriod(period);
  const ovR = useOverview(period);
  const ov = ok(ovR);
  const h = completedHeadline(wp, ov?.production);
  return (
    <CardShell
      title={h.allTime ? "Completed yesterday (All-time view)" : `Completed — ${widgetPeriodLabel(period)}`}
      sub="counted on the day an order's LAST job card closes (all job cards done)"
    >
      {!ov?.production ? (
        <Gate loading={ovR.loading} what="completed output" />
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Bedframe units" value={fmtN(h.bedframeUnits)} />
            <Stat label="Sofa sets" value={fmtN(h.sofaSets)} />
          </div>
          <MiniTable
            cols={["Date", "Bedframe units", "Sofa sets"]}
            rows={h.days.map((d) => [d.date, fmtN(d.bedframeUnits), fmtN(d.sofaSets)])}
          />
        </div>
      )}
    </CardShell>
  );
}

export function PurchasingCard({ period }: { period: Period }) {
  const ovR = useOverview(period);
  const pur = ok(ovR)?.purchasing;
  const scoped = pur?.period && pur.period !== "all" ? pur.period : null;
  return (
    <CardShell title={`Purchasing — ${widgetPeriodLabel(period)}`} sub="open POs · invoiced spend (by supplier invoice date)">
      {!pur ? (
        <Gate loading={ovR.loading} what="purchasing" />
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Open POs" value={fmtN(pur.openPOCount)} sub="all open" />
            <Stat label="PI spend" value={fmtRM2(pur.piSpendThisMonthSen)} sub={`${scoped ?? "all time"} · by invoice date`} />
            <Stat label="Prev month" value={pur.prevPeriod ? fmtRM2(pur.piSpendPrevMonthSen) : "—"} sub={pur.prevPeriod || "—"} />
          </div>
          <div>
            <p className="mb-1 text-[11px] font-semibold text-[#5A5550]">Top suppliers by PI amount{scoped ? ` · ${scoped}` : ""}</p>
            {pur.topSuppliersByPi.length === 0 ? (
              <p className="text-xs" style={{ color: MUTED }}>No purchase invoices in this period.</p>
            ) : (
              pur.topSuppliersByPi.slice(0, 5).map((s) => (
                <div key={s.name} className="flex items-center justify-between py-0.5 text-xs">
                  <span className="truncate pr-2 text-[#5A5550]">{s.name}<span style={{ color: MUTED }}> · {fmtN(s.invoices)} PI</span></span>
                  <span className="font-semibold tabular-nums text-[#1F1D1B]">{fmtRM2(s.spendSen)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </CardShell>
  );
}

export function FabricUsageCard({ period }: { period: Period }) {
  const wp = widgetPeriod(period);
  const ovR = useOverview(period);
  const ov = ok(ovR);
  const fc = ov?.fabricCostPerMeterSen;
  const [mode, setMode] = useState<"prev" | "next">("prev");
  const [gran, setGran] = useState<"month" | "quarter">("month");
  return (
    <CardShell
      title={`Fabric Usage — Bedframe vs Sofa · ${widgetPeriodLabel(period)}`}
      sub={`${mode === "next" ? "forecast — fabric needed next 30 days" : "history — fabric used to date"} · ${gran === "quarter" ? "quarterly" : "monthly"} trend`}
      right={
        <div className="flex flex-wrap items-center gap-2">
          <Pills value={mode} options={[["prev", "Previous"], ["next", "Next"]] as const} onChange={setMode} />
          <Pills value={gran} options={[["month", "Monthly"], ["quarter", "Quarterly"]] as const} onChange={setGran} />
        </div>
      }
    >
      {!ov ? (
        <Gate loading={ovR.loading} what="fabric usage" />
      ) : (
        <div className="space-y-4">
          {fc && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Cost / m · overall" value={fmtRM2(fc.total)} sub="all issued" />
              <Stat label="Excl. bedframe & sofa" value={fc.exclBedframeSofa > 0 ? fmtRM2(fc.exclBedframeSofa) : "—"} />
              <Stat label="Bedframe cost / m" value={fmtRM2(fc.bedframe)} />
              <Stat label="Sofa cost / m" value={fmtRM2(fc.sofa)} />
            </div>
          )}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {(["BEDFRAME", "SOFA"] as const).map((cat) => {
              const v = fabricView(ov.fabric?.[cat], mode, gran);
              return (
                <div key={cat} className="space-y-2">
                  <p className="text-sm font-semibold text-[#1F1D1B]">{cat === "BEDFRAME" ? "Bedframe" : "Sofa"} Fabric</p>
                  {v.rows.length === 0 ? (
                    <p className="text-xs" style={{ color: MUTED }}>{mode === "next" ? "No upcoming fabric demand." : "No fabric issued."}</p>
                  ) : (
                    <MiniTable
                      cols={["Fabric", mode === "next" ? "Next 30d (live)" : `Used · ${wp === "all" ? "all time" : wp}`, "Past 30d (live)", "Avg buy (all time)", "Min–Max"]}
                      rows={v.rows.map((f) => [
                        f.fabCode,
                        `${fmtDec2(mode === "next" ? f.next30Meters : f.meters)} m`,
                        `${fmtDec2(f.past30Meters)} m`,
                        f.buyAvgSen ? fmtRM2(f.buyAvgSen) : "—",
                        f.buyMinSen || f.buyMaxSen ? `${fmtRM2(f.buyMinSen)}–${fmtRM2(f.buyMaxSen)}` : "—",
                      ])}
                    />
                  )}
                  <p className="pt-1 text-[11px] font-semibold text-[#5A5550]">
                    {gran === "quarter" ? "Quarterly meters posted — last 8" : "Monthly meters posted — last 12"} (newest first)
                  </p>
                  {v.trend.length === 0 ? (
                    <p className="text-xs" style={{ color: MUTED }}>No data.</p>
                  ) : (
                    v.trend.map((t) => (
                      <div key={t.label} className="flex items-center gap-2">
                        <span className="w-14 shrink-0 text-[11px] tabular-nums" style={{ color: MUTED }}>{t.label}</span>
                        <div className="h-2.5 flex-1 overflow-hidden rounded bg-[#F5F2ED]">
                          <div className="h-full rounded" style={{ width: `${Math.max(2, (t.meters / v.max) * 100)}%`, background: CHART_INK, opacity: 0.7 }} />
                        </div>
                        <span className="w-20 text-right text-[11px] font-semibold tabular-nums text-[#1F1D1B]">{fmtDec2(t.meters)} m</span>
                      </div>
                    ))
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-[10px]" style={{ color: MUTED }}>
            Fabric issued to production (RM_ISSUE), grouped by the date the issue was POSTED — an order raised one month is
            routinely cut the next, so a bar is not that month&rsquo;s production.
          </p>
        </div>
      )}
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// Finance — plain fetch, NEVER useCachedJson: that persists responses in
// localStorage, and finance figures must not land there (same rule as
// FinanceView).
// ---------------------------------------------------------------------------

type FetchState<T> = { url: string; status: "ok" | "forbidden" | "error"; data?: T };

function useFinanceFetch<T>(url: string | null): FetchState<T> | null {
  const [state, setState] = useState<FetchState<T> | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    fetch(url)
      .then(async (r) => {
        if (cancelled) return;
        if (r.status === 401 || r.status === 403) return setState({ url, status: "forbidden" });
        if (!r.ok) return setState({ url, status: "error" });
        const j = (await r.json()) as { success?: boolean; data?: T };
        if (!cancelled) setState(j.success !== false && j.data ? { url, status: "ok", data: j.data } : { url, status: "error" });
      })
      .catch(() => {
        if (!cancelled) setState({ url, status: "error" });
      });
    return () => { cancelled = true; };
  }, [url]);
  return state && state.url === url ? state : null;
}

type AgingParty = { currentSen: number; days30Sen: number; days60Sen: number; days90Sen: number; over90Sen: number };

function FinGate({ s, what }: { s: FetchState<unknown> | null; what: string }) {
  if (!s) return <p className="text-xs" style={{ color: MUTED }}>Loading…</p>;
  if (s.status === "forbidden") return <p className="text-xs" style={{ color: AMBER }}>Needs accounting access.</p>;
  return <p className="text-xs" style={{ color: AMBER }}>Couldn't load {what} — not shown as zero.</p>;
}

export function AgingRatiosCard({ period }: { period: Period }) {
  const m = period.month;
  const ytd = period.mode === "ytd";
  const ratiosUrl = m
    ? `/api/accounting/dashboard?granularity=month&from=${ytd ? `${m.slice(0, 4)}-01` : m}&to=${m}`
    : null;
  const ratiosS = useFinanceFetch<{ rows?: FinanceDashRow[] }>(ratiosUrl);
  const agingS = useFinanceFetch<{ ar?: AgingParty[]; ap?: AgingParty[] }>("/api/accounting/aging");
  const ratios = ratiosS?.status === "ok" ? financeRatios(ratiosS.data?.rows ?? []) : null;
  const aging = agingS?.status === "ok" ? agingS.data : null;
  const ar = aging ? agingBucketTotals(aging.ar ?? []) : null;
  const ap = aging ? agingBucketTotals(aging.ap ?? []) : null;
  const windowLabel = !m ? "—" : ytd ? `${m.slice(0, 4)} YTD (Jan – ${m})` : m;
  return (
    <CardShell title="Margins, liquidity & aging" sub="gross margin, current and quick ratio from the posted ledger · AR/AP aging">
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-[11px] font-semibold text-[#5A5550]">Ratios · {windowLabel}</p>
          {!ratios ? (
            <FinGate s={ratiosS} what="the ratios" />
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Gross margin" value={fmtPct2(ratios.grossMarginPct)} sub="gross profit ÷ sales" />
              <Stat label="Current ratio" value={ratios.currentRatio == null ? "—" : fmtDec2(ratios.currentRatio)} sub="current assets ÷ current liabilities" />
              <Stat label="Quick ratio" value={ratios.quickRatio == null ? "—" : fmtDec2(ratios.quickRatio)} sub="(current assets − inventory) ÷ current liabilities" />
            </div>
          )}
          <p className="mt-1 text-[10px]" style={{ color: MUTED }}>
            Balance-sheet ratios use the position at the end of the window. "—" means the denominator is zero or negative.
          </p>
        </div>
        <div>
          <p className="mb-2 text-[11px] font-semibold text-[#5A5550]">Aging · live, as of today (not filtered by the period)</p>
          {!ar || !ap ? (
            <FinGate s={agingS} what="aging" />
          ) : (
            <MiniTable
              cols={["", ...ar.buckets.map((b) => b.period), "Total"]}
              rows={[
                ["Receivable (AR)", ...ar.buckets.map((b) => fmtRM2(b.amountSen)), fmtRM2(ar.totalSen)],
                ["Payable (AP)", ...ap.buckets.map((b) => fmtRM2(b.amountSen)), fmtRM2(ap.totalSen)],
              ]}
            />
          )}
        </div>
      </div>
    </CardShell>
  );
}
