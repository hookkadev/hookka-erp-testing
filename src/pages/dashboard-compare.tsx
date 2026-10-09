// ============================================================
// /dashboard/compare: Plant Load on a 7-day vs a 14-day capacity window,
// side by side, to judge the 2026-10-08 switch to 14 days.
//
// STAGING ONLY: lives on the `staging` branch, never PR this into main.
// Both columns read /api/dashboard/overview with capacityWindow=7 / 14, which
// the route answers without touching any stored copy. Month picker: "Up to
// yesterday" is today's state; a month keeps both windows INSIDE that month
// (owner 2026-10-09: nothing carried over from the month before), ending on
// its last day, or yesterday for the current month.
// Each column: the /dashboard Plant Load card itself (its four rows open the
// same drill-throughs), the Department Backlog bars and the daily production
// chart. Bars and charts of a kind share one scale across columns.
//
// Second tab (?tab=fabric), "Fabric & purchasing" (owner 2026-10-09): the
// dashboard's Fabric Usage section for the picked month, then the
// dashboard/purchasing to-do items per calendar month (last 12 months) from
// /api/dashboard/overview/fabric-cost-compare: fabric Avg cost /m as shown vs at
// real purchase prices vs invoice price, each finished order's BOM plan vs what
// it recorded, fabric invoiced vs received into stock, and an invoice price trend.
// The month picker sits at the top right on every tab.
// ============================================================
import { useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { formatRM } from "@/lib/utils";
import { useCachedJson } from "@/lib/cached-fetch";
import { FabricUsageSection, Modal, PlantLoadCard, type Drill, type PlantLoadOverview } from "@/pages/dashboard-compare-cards";
import { deptBacklogRows, type DeptBacklog } from "@/pages/dashboards/dashboard-widgets-lib";
import { daysTone } from "@/pages/dashboards/ops-floor-lib";
import { AMBER, GREEN, RED } from "@/pages/dashboards/dashboard-shared-lib";

type Overview = PlantLoadOverview & {
  salesMonths?: string[];
  stateSnapshot?: { source: "live" | "snapshot" | "reconstructed"; asOf: string | null };
};
type Prod = NonNullable<Overview["production"]> & { backlogByDept: DeptBacklog[] };

const CUR_YM = new Date().toISOString().slice(0, 7);
const h = (min: number | null | undefined) => `${Math.round((min ?? 0) / 60).toLocaleString()}h`;
const INK = "#6B5C32";
const SOFA = "#A8A29E";
const TONE = { red: RED, amber: AMBER, green: GREEN } as const;

function DeptBacklog({ prod, mx }: { prod: Prod; mx: number }) {
  const { rows } = deptBacklogRows(prod.backlogByDept, true, true);
  const sorted = [...rows].sort((a, b) => (b.showDays ?? Infinity) - (a.showDays ?? Infinity));
  return (
    <Card className="min-w-0">
      <CardContent className="p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
          <h3 className="text-sm font-bold text-[#1F1D1B]">Department Backlog</h3>
          <span className="flex gap-3 text-xs text-[#5A5550]">
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: SOFA }} />Sofa</span>
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: INK }} />Bedframe</span>
          </span>
        </div>
        <div className="space-y-2.5">
          {sorted.map(({ d, sofaDays, bedDays, showDays }) => (
            <div key={d.dept} className="grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)_3rem] items-center gap-2 text-xs">
              <span className="truncate text-[#1F1D1B]">{d.dept}</span>
              <span className="flex h-2 min-w-0 overflow-hidden rounded-full bg-[#F5F2ED]" title={`${h(d.totalMin)} queued · ${h(d.dailyCapMin)}/day`}>
                <span style={{ width: `${(sofaDays / mx) * 100}%`, background: SOFA }} />
                <span style={{ width: `${(bedDays / mx) * 100}%`, background: INK }} />
              </span>
              <span className="text-right font-semibold tabular-nums" style={{ color: TONE[daysTone(showDays)] }}>
                {showDays == null ? "stalled" : `${showDays.toFixed(1)}d`}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function DailyChart({ prod, dayMax }: { prod: Prod; dayMax: number }) {
  const days = [...prod.capacityDays]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ day: d.date.slice(5), hours: Math.round(d.minutes / 60) }));
  return (
    <Card className="min-w-0">
      <CardContent className="p-4 sm:p-5">
        <h3 className="text-sm font-bold text-[#1F1D1B] mb-2">Production hours per working day</h3>
        <div className="h-52">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={days} margin={{ top: 16, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E0D8" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#A39E93" }} interval="preserveStartEnd" />
              <YAxis domain={[0, dayMax]} tick={{ fontSize: 10, fill: "#A39E93" }} />
              <Tooltip formatter={(v) => [`${v}h`, "Production"]} />
              <ReferenceLine
                y={Math.round(prod.dailyCapacityMin / 60)}
                stroke="#C5A85C"
                strokeDasharray="4 3"
                label={{ value: `avg ${h(prod.dailyCapacityMin)}`, position: "insideTopRight", fontSize: 10, fill: INK }}
              />
              <Bar dataKey="hours" fill={INK} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function Column({
  win,
  period,
  res,
  dayMax,
  deptMax,
  onDrill,
}: {
  win: 7 | 14;
  period: string;
  res: { data: Overview | null; loading: boolean };
  dayMax: number;
  deptMax: number;
  onDrill: (d: Drill) => void;
}) {
  const prod = res.data?.production;
  const cd = prod?.capacityDays ?? [];
  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 className="text-base font-bold text-[#1F1D1B]">{win}-day window</h2>
        {cd.length > 0 && (
          <span className="text-xs text-[#6B7280] tabular-nums">
            {cd.length} working day{cd.length === 1 ? "" : "s"} · {cd[0].date.slice(5)} to {cd[cd.length - 1].date.slice(5)}
          </span>
        )}
      </div>
      {prod ? (
        <>
          <PlantLoadCard
            ov={res.data ?? {}}
            period={period}
            curYm={CUR_YM}
            onDrill={onDrill}
            windowLabel={`${cd.length}-day avg`}
            windowTitle={`Daily Capacity — ${win}-day window (${cd.length} working days)`}
          />
          <DeptBacklog prod={prod} mx={deptMax} />
          <DailyChart prod={prod} dayMax={dayMax} />
        </>
      ) : (
        <p className="text-sm text-[#6B7280]">{res.loading ? "Loading…" : "Could not load the dashboard data."}</p>
      )}
    </div>
  );
}

type FabricCat = "BEDFRAME" | "SOFA";
type CatMonth = {
  cutMeters: number;
  shownSen: number;
  realSen: number;
  openingMeters: number;
  invoiceLines: number;
  invoiceMeters: number;
  invoiceSen: number;
  receivedMeters: number;
  grns: number;
  grnMeters: number;
  ordersDone: number;
  ordersRecorded: number;
  plannedMeters: number;
  recordedMeters: number;
  recordedSen: number;
  fabricsUsed: number;
  fabricsRecorded: number;
};
type FabricMonth = { ym: string; BEDFRAME: CatMonth; SOFA: CatMonth };
type TrendRow = { cat: FabricCat; code: string; meters: number; byMonth: Record<string, { meters: number; sen: number }> };
type FabricData = { months: FabricMonth[]; trend: TrendRow[] };

const CAT_LABEL: Record<FabricCat, string> = { SOFA: "Sofa", BEDFRAME: "Bedframe" };
const m = (n: number) => `${Math.round(n).toLocaleString()} m`;
const perM = (sen: number, meters: number) => (meters > 0 ? formatRM(Math.round(sen / meters)) : "—");
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

type Col = { label: string; cell: (c: CatMonth) => ReactNode; strong?: boolean };

function MonthTable({ cat, months, cols }: { cat: FabricCat; months: FabricMonth[]; cols: Col[] }) {
  return (
    <Card className="min-w-0">
      <CardContent className="p-4 sm:p-5">
        <h3 className="text-sm font-bold text-[#1F1D1B] mb-2">{CAT_LABEL[cat]}</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[440px] text-sm tabular-nums">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-[#9CA3AF]">
                <th className="text-left py-2 pr-2">Month</th>
                {cols.map((col) => (
                  <th key={col.label} className="text-right py-2 px-2 last:pr-0">{col.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {months.map((row) => (
                <tr key={row.ym} className="border-t border-[#F0ECE6]">
                  <td className="py-2 pr-2 text-[#1F1D1B]">{row.ym}</td>
                  {cols.map((col) => (
                    <td
                      key={col.label}
                      className={`text-right py-2 px-2 last:pr-0 ${col.strong ? "font-semibold text-[#1F1D1B]" : "text-[#5A5550]"}`}
                    >
                      {col.cell(row[cat])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function Section({ title, note, months, cols }: { title: string; note: string; months: FabricMonth[]; cols: Col[] }) {
  return (
    <section className="space-y-2">
      <h2 className="text-base font-bold text-[#1F1D1B]">{title}</h2>
      <p className="text-sm text-[#5A5550]">{note}</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <MonthTable cat="SOFA" months={months} cols={cols} />
        <MonthTable cat="BEDFRAME" months={months} cols={cols} />
      </div>
    </section>
  );
}

function PriceTrend({ cat, data }: { cat: FabricCat; data: FabricData }) {
  const rows = data.trend.filter((t) => t.cat === cat);
  // Oldest on the left so the row reads as a trend.
  const cols = [...data.months].reverse().map((r) => r.ym);
  return (
    <Card className="min-w-0">
      <CardContent className="p-4 sm:p-5">
        <h3 className="text-sm font-bold text-[#1F1D1B] mb-2">{CAT_LABEL[cat]}</h3>
        {rows.length === 0 ? (
          <p className="text-sm text-[#6B7280]">No fabric invoiced in these months.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-xs tabular-nums">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-[#9CA3AF]">
                  <th className="text-left py-2 pr-2">Fabric</th>
                  {cols.map((ym) => (
                    <th key={ym} className="text-right py-2 px-1.5">{ym.slice(2)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.code} className="border-t border-[#F0ECE6]">
                    <td className="py-2 pr-2 text-[#1F1D1B] whitespace-nowrap">{t.code}</td>
                    {cols.map((ym) => {
                      const cell = t.byMonth[ym];
                      return (
                        <td key={ym} className="text-right py-2 px-1.5 text-[#5A5550]" title={cell ? m(cell.meters) : undefined}>
                          {cell && cell.meters > 0 ? (cell.sen / cell.meters / 100).toFixed(2) : "—"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FabricPurchasingTab({ ov, period }: { ov: Overview | null; period: string }) {
  const res = useCachedJson<FabricData>("/api/dashboard/overview/fabric-cost-compare", 60);
  const data = res.data?.months ? res.data : null;
  const usage = ov ? <FabricUsageSection ov={ov} period={period} /> : <p className="text-sm text-[#6B7280]">Loading…</p>;
  if (!data) {
    return (
      <div className="space-y-6">
        {usage}
        <p className="text-sm text-[#6B7280]">{res.loading ? "Loading…" : "Could not load the fabric data."}</p>
      </div>
    );
  }
  const months = data.months;
  return (
    <div className="space-y-6">
      {usage}
      <p className="text-sm text-[#5A5550]">
        The last 12 months. Every figure belongs to its calendar month; nothing here is a live or rolling figure.
      </p>

      <Section
        title="Average fabric price"
        note="Shown is the dashboard's Avg cost /m: what the fabric cut that month cost, oldest stock first. Opening stock was loaded on 2026-02-21 at a flat RM 25.00 or RM 35.00 per metre, above every real purchase price of those fabrics. Real price costs the same metres with each opening-stock slice at that fabric's average purchase price. Invoice price is what supplier invoices dated that month charged per metre."
        months={months}
        cols={[
          { label: "Cut", cell: (c) => (c.cutMeters > 0 ? m(c.cutMeters) : "—") },
          { label: "Shown", cell: (c) => perM(c.shownSen, c.cutMeters) },
          { label: "Real price", cell: (c) => perM(c.realSen, c.cutMeters), strong: true },
          { label: "Invoice price", cell: (c) => perM(c.invoiceSen, c.invoiceMeters) },
          { label: "At placeholder", cell: (c) => (c.cutMeters > 0 ? pct(c.openingMeters, c.cutMeters) : "—") },
        ]}
      />

      <Section
        title="Planned (BOM) vs recorded"
        note="Orders finished in the month. Planned is each order's own bill of materials (the fabric it should use). Recorded is the fabric the system actually booked for it. When a fabric has no stock on the books, cutting it records nothing, so the gap is fabric used but never costed."
        months={months}
        cols={[
          { label: "Orders", cell: (c) => c.ordersDone.toLocaleString() },
          { label: "Recorded", cell: (c) => `${c.ordersRecorded.toLocaleString()} · ${pct(c.ordersRecorded, c.ordersDone)}` },
          { label: "Planned", cell: (c) => m(c.plannedMeters) },
          { label: "Recorded m", cell: (c) => m(c.recordedMeters), strong: true },
          { label: "Fabrics", cell: (c) => `${c.fabricsRecorded} of ${c.fabricsUsed}` },
        ]}
      />

      <Section
        title="Fabric purchasing"
        note="By the fabric's own group (sofa fabric, bedframe fabric), so a bedframe fabric cut for a sofa still counts as bedframe here. Invoiced comes from supplier invoices by invoice date. Received is what reached stock in the system. Fabric that is invoiced but never received has no stock to be cut from."
        months={months}
        cols={[
          { label: "Invoiced", cell: (c) => (c.invoiceMeters > 0 ? m(c.invoiceMeters) : "—") },
          { label: "Invoiced RM", cell: (c) => (c.invoiceSen > 0 ? formatRM(c.invoiceSen) : "—"), strong: true },
          { label: "Received", cell: (c) => (c.receivedMeters > 0 ? m(c.receivedMeters) : "—") },
          { label: "GRNs", cell: (c) => (c.grns > 0 ? c.grns.toLocaleString() : "—") },
        ]}
      />

      <section className="space-y-2">
        <h2 className="text-base font-bold text-[#1F1D1B]">Price trend</h2>
        <p className="text-sm text-[#5A5550]">
          RM per metre on supplier invoices, by invoice month, for the 10 fabrics bought most in these months. Hover a
          price for the metres behind it. A figure far from its neighbours is usually a unit mix-up on the invoice (a
          roll or a yard keyed as a metre).
        </p>
        <div className="grid gap-4">
          <PriceTrend cat="SOFA" data={data} />
          <PriceTrend cat="BEDFRAME" data={data} />
        </div>
      </section>
    </div>
  );
}

const TABS = [
  { key: "plant", label: "Plant Load 7d vs 14d" },
  { key: "fabric", label: "Fabric & purchasing" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default function DashboardCompare() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: TabKey = searchParams.get("tab") === "fabric" ? "fabric" : "plant";
  const [period, setPeriod] = useState("all");
  const r7 = useCachedJson<Overview>(`/api/dashboard/overview?period=${period}&capacityWindow=7`, 60);
  const r14 = useCachedJson<Overview>(`/api/dashboard/overview?period=${period}&capacityWindow=14`, 60);
  const [months, setMonths] = useState<string[]>([]);
  const fresh = r14.data?.salesMonths;
  if (fresh && fresh.length > months.length) setMonths(fresh);
  const pastMonths = months.filter((m) => m < CUR_YM);
  const state = r14.data?.stateSnapshot;
  const p7 = r7.data?.production;
  const p14 = r14.data?.production;
  const [drill, setDrill] = useState<Drill | null>(null);

  const allDays = [...(p7?.capacityDays ?? []), ...(p14?.capacityDays ?? [])].map((d) => d.minutes / 60);
  const dayMax = Math.ceil(Math.max(50, ...allDays) / 50) * 50;
  const deptDays = [p7, p14].flatMap((p) =>
    p ? deptBacklogRows(p.backlogByDept, true, true).rows.map((r) => r.showDays ?? 0) : [],
  );
  const deptMax = Math.max(1, ...deptDays);

  const by14 = new Map((p14?.backlogByDept ?? []).map((d) => [d.dept, d]));
  const rows = (p7?.backlogByDept ?? [])
    .map((d7) => ({ d7, d14: by14.get(d7.dept) }))
    .sort((a, b) => (b.d14?.backlogDays ?? Infinity) - (a.d14?.backlogDays ?? Infinity));
  const fmtDays = (d: number | null | undefined) => (d == null ? "stalled" : `${d.toFixed(1)}d`);
  const diff = (a: number | null | undefined, b: number | null | undefined) =>
    a == null || b == null ? "—" : `${b - a >= 0 ? "+" : "−"}${Math.abs(b - a).toFixed(1)}d`;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Dashboard Compare"
        subtitle={
          tab === "fabric"
            ? "Fabric price, planned vs recorded fabric, fabric purchasing and price trend, month by month. Staging only."
            : "Plant Load with capacity averaged over the last 7 vs the last 14 working days. Staging only."
        }
        actions={
          (
            <select
              id="compare-period"
              aria-label="Month"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="h-9 rounded-md border border-[#E2DDD8] bg-white px-2 text-sm"
            >
              <option value="all">Up to yesterday</option>
              <option value={CUR_YM}>{CUR_YM} (this month so far)</option>
              {pastMonths.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )
        }
      />
      <Tabs tabs={TABS} value={tab} onChange={(k) => setSearchParams(k === "plant" ? {} : { tab: k })} />
      {tab === "fabric" ? <FabricPurchasingTab ov={r14.data} period={period} /> : (
        <>
          {period !== "all" && (
            <p className="text-xs text-[#5A5550]">
              Both windows stay inside {period}: they count back from {period === CUR_YM ? "yesterday" : "its last day"} and stop
              at the 1st, so a window can hold fewer working days than its name.
              {state && state.source !== "live" && (
                <>
                  {" "}Backlog at month end:{" "}
                  {state.source === "snapshot"
                    ? `saved snapshot of ${state.asOf}`
                    : "estimated from job cards (no snapshot was saved that month)"}
                  .
                </>
              )}
            </p>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <Column win={7} period={period} res={r7} dayMax={dayMax} deptMax={deptMax} onDrill={setDrill} />
            <Column win={14} period={period} res={r14} dayMax={dayMax} deptMax={deptMax} onDrill={setDrill} />
          </div>
          {p7 && p14 && (
            <Card>
              <CardContent className="p-4 sm:p-5">
                <h2 className="text-base font-bold text-[#1F1D1B] mb-3">Difference</h2>
                <p className="text-sm text-[#5A5550] mb-3">
                  Plant: daily capacity {h(p7.dailyCapacityMin)} → {h(p14.dailyCapacityMin)}, queue{" "}
                  {fmtDays(p7.backlogDays)} → {fmtDays(p14.backlogDays)} ({diff(p7.backlogDays, p14.backlogDays)}). The backlog is
                  the same in both; only the daily capacity it is divided by changes.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] text-sm tabular-nums">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wider text-[#9CA3AF]">
                        <th className="text-left py-2 pr-2">Department</th>
                        <th className="text-right py-2 px-2">Backlog</th>
                        <th className="text-right py-2 px-2">Per day, 7d</th>
                        <th className="text-right py-2 px-2">Per day, 14d</th>
                        <th className="text-right py-2 px-2">Queue, 7d</th>
                        <th className="text-right py-2 px-2">Queue, 14d</th>
                        <th className="text-right py-2 pl-2">Change</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(({ d7, d14 }) => (
                        <tr key={d7.dept} className="border-t border-[#F0ECE6]">
                          <td className="py-2 pr-2 text-[#1F1D1B]">{d7.dept}</td>
                          <td className="text-right py-2 px-2">{h(d7.totalMin)}</td>
                          <td className="text-right py-2 px-2">{h(d7.dailyCapMin)}</td>
                          <td className="text-right py-2 px-2">{h(d14?.dailyCapMin)}</td>
                          <td className="text-right py-2 px-2">{fmtDays(d7.backlogDays)}</td>
                          <td className="text-right py-2 px-2">{fmtDays(d14?.backlogDays)}</td>
                          <td className="text-right py-2 pl-2 font-semibold">{diff(d7.backlogDays, d14?.backlogDays)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
      {drill && (
        <Modal title={drill.title} subtitle={drill.subtitle} onClose={() => setDrill(null)}>
          {drill.node}
        </Modal>
      )}
    </div>
  );
}
