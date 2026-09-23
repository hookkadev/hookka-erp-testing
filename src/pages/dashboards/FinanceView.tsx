import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, ComposedChart, Cell, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoneyInput } from "@/components/ui/money-input";
import { formatCurrency } from "@/lib/utils";
import { Users, Wallet, TrendingUp, Percent, Landmark, Scale } from "lucide-react";
import type { FinancePayload, Yoy, PeVariant } from "@/api/lib/dashboard-finance";
import {
  AMBER, BORDER, CARD_BG, CARD_BORDER, CHART_AXIS, CHART_GOLD, CHART_INK, GREEN, RED, TEAL,
  fmtRMAxis, monthLabel, periodLabel, type FinSub, type Period,
} from "./dashboard-shared-lib";
import { Kpi } from "./dashboard-shared";

// Finance tab. Reads its OWN endpoint, GET /api/dashboard/finance, which is
// gated by the accounting permission and sent no-store — finance figures are
// deliberately NOT part of the cached, org-shared /api/dashboard/prototype
// feed. That is also why this view uses a plain fetch rather than
// useCachedJson: the latter persists every response in localStorage.
// All maths and definitions live in src/api/lib/dashboard-finance.ts; this
// file only formats. Every figure comes from the posted general ledger via the
// P&L / Balance Sheet code, headcount from the Employees rule.

type Resp = FinancePayload & { meta: { canEditValuation: boolean; headcountBasis: string; fyeMonth: number } };
type State = { url: string; status: "ok" | "forbidden" | "error"; data?: Resp; error?: string };

const rm = (sen: number | null | undefined) => (sen === null || sen === undefined ? "—" : formatCurrency(sen));
const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(1)}%`);
const signed = (x: number, f: (n: number) => string) => `${x > 0 ? "+" : x < 0 ? "-" : ""}${f(Math.abs(x))}`;

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-[#6B7280]">{children}</p>;
}

const CHART_WRAP = "select-none [&_*]:outline-none [&_.recharts-wrapper]:outline-none";
const TOOLTIP_STYLE = { background: CARD_BG, border: `1px solid ${CARD_BORDER}`, borderRadius: 8, fontSize: 12 };

export function FinanceView({
  period, sub, months, onPeriodChange,
}: {
  period: Period;
  sub: FinSub;
  months: string[];
  onPeriodChange: (p: Period) => void;
}) {
  const mode = period.mode === "ytd" ? "ytd" : "monthly";
  const url = period.month ? `/api/dashboard/finance?mode=${mode}&month=${period.month}` : null;
  const [state, setState] = useState<State | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    fetch(url)
      .then(async (r) => {
        if (cancelled) return;
        if (r.status === 401 || r.status === 403) return setState({ url, status: "forbidden" });
        if (!r.ok) return setState({ url, status: "error", error: `HTTP ${r.status}` });
        const j = (await r.json()) as { data?: Resp };
        if (!cancelled) setState(j.data ? { url, status: "ok", data: j.data } : { url, status: "error", error: "empty response" });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ url, status: "error", error: e instanceof Error ? e.message : String(e) });
      });
    return () => { cancelled = true; };
  }, [url, tick]);

  const cur = state && state.url === url ? state : null;
  if (!url || !cur) return <div className="py-16 text-center text-sm text-[#6B7280]">Loading…</div>;
  if (cur.status === "forbidden") {
    return (
      <Card className="border-[#F0D9AE] bg-[#FDF3E4]">
        <CardContent className="p-4 text-sm text-[#B5701A]">
          The Finance tab requires accounting access. Ask an administrator to grant your role the Accounting permission.
        </CardContent>
      </Card>
    );
  }
  if (cur.status === "error" || !cur.data) {
    return (
      <Card className="border-[#F0D9AE] bg-[#FDF3E4]">
        <CardContent className="p-4 text-sm text-[#B5701A]">Couldn't load Finance: {cur.error ?? "unknown error"}</CardContent>
      </Card>
    );
  }
  const d = cur.data;
  const goMonth = (ym: string) => { if (months.includes(ym)) onPeriodChange({ mode: "monthly", month: ym }); };

  return (
    <div className="space-y-5 max-md:space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Finance</h2>
        <span className="rounded-full bg-[#F0ECE9] px-2 py-0.5 text-[11px] text-[#6B7280]">
          {period.mode === "range" ? `${monthLabel(period.month)} (range shows its month)` : periodLabel(period)} · posted general ledger
        </span>
      </div>
      {sub === "perhead" && <PerHead d={d} onMonth={goMonth} />}
      {sub === "returns" && <Returns d={d} />}
      {sub === "outlook" && <Outlook d={d} onSaved={() => setTick((t) => t + 1)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
function YoyCard({ d, rows, chart }: { d: Resp; rows: { label: string; y: Yoy; kind: "money" | "ratio"; higherBetter: boolean | null }[]; chart: boolean }) {
  const noPrior = !d.coverage.priorHasData;
  const money = (n: number) => formatCurrency(n);
  const ratioFmt = (n: number) => `${(n * 100).toFixed(1)}%`;
  const chartData = d.yoyChart.map((r) => ({ name: r.name, "This period": Math.round(r.current / 100), "Same period last year": r.prior === null ? null : Math.round(r.prior / 100) }));
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Year over year</CardTitle>
        <p className="text-xs text-[#6B7280]">This period against the same window one year earlier (Monthly: the month a year ago; YTD: the same months last year).</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {noPrior && (
          <p className="rounded-md bg-[#FDF3E4] px-3 py-2 text-xs text-[#B5701A]">
            No prior-year data — the ledger holds nothing for the comparison window, so no deviance is shown.
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-[#E2DDD8] text-[10.5px] uppercase tracking-wide text-[#6B7280]">
                <th className="py-2 text-left font-semibold">Metric</th>
                <th className="py-2 text-right font-semibold">This period</th>
                <th className="py-2 text-right font-semibold">Last year</th>
                <th className="py-2 text-right font-semibold">Change</th>
                <th className="py-2 text-right font-semibold">Change %</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const f = r.kind === "money" ? money : ratioFmt;
                const good = r.y.deltaAbs === null || r.higherBetter === null || r.y.deltaAbs === 0 ? null : (r.y.deltaAbs > 0) === r.higherBetter;
                const color = good === null ? "#1F1D1B" : good ? GREEN : RED;
                return (
                  <tr key={r.label} className="border-b border-[#E2DDD8]">
                    <td className="py-2 font-medium text-[#1F1D1B]">{r.label}</td>
                    <td className="py-2 text-right font-mono">{r.y.current === null ? "—" : f(r.y.current)}</td>
                    {r.y.hasPrior ? (
                      <>
                        <td className="py-2 text-right font-mono">{f(r.y.prior as number)}</td>
                        <td className="py-2 text-right font-mono" style={{ color }}>
                          {r.y.deltaAbs === null ? "—" : r.kind === "money" ? signed(r.y.deltaAbs, money) : `${signed(r.y.deltaAbs * 100, (n) => n.toFixed(1))} pts`}
                        </td>
                        <td className="py-2 text-right font-mono" style={{ color }}>
                          {r.y.deltaPct === null ? "—" : signed(r.y.deltaPct * 100, (n) => `${n.toFixed(1)}%`)}
                        </td>
                      </>
                    ) : (
                      <td colSpan={3} className="py-2 text-right text-xs text-[#6B7280]">no prior-year data</td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {chart && !noPrior && (
          <div className={CHART_WRAP} style={{ width: "100%", height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke={CHART_AXIS} strokeOpacity={0.25} />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: CHART_AXIS }} axisLine={{ stroke: CARD_BORDER }} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: CHART_AXIS }} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => fmtRMAxis(Number(v))} />
                <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => formatCurrency(Number(v) * 100)} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="This period" fill={CHART_INK} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
                <Bar dataKey="Same period last year" fill={CHART_GOLD} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
function PerHead({ d, onMonth }: { d: Resp; onMonth: (ym: string) => void }) {
  const p = d.perHead;
  const data = p.trend.map((t) => ({
    ym: t.ym,
    label: monthLabel(t.ym),
    "Labour cost / head": t.labourPerHeadSen === null ? null : Math.round(t.labourPerHeadSen / 100),
    "Revenue / head": t.revenuePerHeadSen === null ? null : Math.round(t.revenuePerHeadSen / 100),
  }));
  const anyData = data.some((r) => r["Revenue / head"] !== null || r["Labour cost / head"] !== null);
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 max-md:gap-3">
        <Kpi label="Avg employee cost" value={rm(p.labourPerHeadSen)} sub={d.period.mode === "ytd" ? "labour cost ÷ avg headcount, YTD" : "labour cost ÷ headcount, month"} icon={Wallet} iconBgClass="bg-[#FAEFCB]" iconColorClass="text-[#9C6F1E]" valueSizeClass="text-xl" />
        <Kpi label="Avg employee revenue" value={rm(p.revenuePerHeadSen)} sub="revenue ÷ headcount" icon={TrendingUp} iconBgClass="bg-[#EEF3E4]" iconColorClass="text-[#4F7C3A]" valueSizeClass="text-xl" />
        <Kpi label="Headcount" value={p.headcount === null ? "—" : p.headcount.toLocaleString("en-MY", { maximumFractionDigits: 1 })} sub="ACTIVE, excl. TEST" icon={Users} iconBgClass="bg-[#F0ECE9]" iconColorClass="text-[#6B5C32]" valueSizeClass="text-xl" />
        <Kpi label="Labour cost" value={rm(p.labourSen)} sub={`revenue ${rm(p.revenueSen)}`} icon={Wallet} iconBgClass="bg-[#E6F0F3]" iconColorClass="text-[#3E6570]" valueSizeClass="text-xl" />
      </div>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Per head, last 12 months</CardTitle>
          <p className="text-xs text-[#6B7280]">Click a month to open it.</p>
        </CardHeader>
        <CardContent>
          <div className={CHART_WRAP} style={{ width: "100%", height: 240 }}>
            {!anyData ? (
              <div className="flex h-full items-center justify-center text-xs text-[#6B7280]">No ledger data in the last 12 months.</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={data}
                  margin={{ top: 6, right: 6, bottom: 0, left: 0 }}
                  style={{ cursor: "pointer" }}
                  onClick={(e) => {
                    const hit = data.find((r) => r.label === e?.activeLabel);
                    if (hit) onMonth(hit.ym);
                  }}
                >
                  <CartesianGrid vertical={false} stroke={CHART_AXIS} strokeOpacity={0.25} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: CHART_AXIS }} axisLine={{ stroke: CARD_BORDER }} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: CHART_AXIS }} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => fmtRMAxis(Number(v))} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => formatCurrency(Number(v) * 100)} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="Revenue / head" fill={CHART_INK} radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
                  <Bar dataKey="Labour cost / head" fill={CHART_GOLD} radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </CardContent>
      </Card>
      <YoyCard
        d={d}
        chart={false}
        rows={[
          { label: "Revenue", y: d.yoy.revenue, kind: "money", higherBetter: true },
          { label: "Labour cost", y: d.yoy.labour, kind: "money", higherBetter: null },
          { label: "Avg employee cost", y: d.yoy.labourPerHead, kind: "money", higherBetter: null },
          { label: "Avg employee revenue", y: d.yoy.revenuePerHead, kind: "money", higherBetter: true },
        ]}
      />
      <Card>
        <CardContent className="space-y-1 p-4">
          <Note><b>Labour cost</b> = the P&amp;L's direct labour (750-x) plus salary expense (900-S00x) — the payroll cost the P&amp;L already carries. <b>Revenue</b> = P&amp;L net sales.</Note>
          <Note>{d.meta.headcountBasis}</Note>
        </CardContent>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
function Returns({ d }: { d: Resp }) {
  const r = d.returns;
  const l = r.liabilitiesVsAssets;
  const tag = r.annualised ? "annualised (×12)" : "YTD, not annualised";
  const roiSub = r.investedCapitalSen === null ? "no balance sheet" : `on ${rm(r.investedCapitalSen)} invested`;
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 max-md:gap-3">
        <Kpi label="ROA" value={pct(r.roa)} sub={`net profit ÷ total assets · ${tag}`} icon={Percent} iconBgClass="bg-[#EEF3E4]" iconColorClass="text-[#4F7C3A]" valueSizeClass="text-xl" />
        <Kpi label="ROE" value={pct(r.roe)} sub={`net profit ÷ total equity · ${tag}`} icon={Percent} iconBgClass="bg-[#E6F0F3]" iconColorClass="text-[#3E6570]" valueSizeClass="text-xl" />
        <Kpi label="ROI" value={pct(r.roi)} sub={`net profit ÷ invested capital · ${roiSub}`} icon={Percent} iconBgClass="bg-[#FAEFCB]" iconColorClass="text-[#9C6F1E]" valueSizeClass="text-xl" />
        <Kpi label="Net profit" value={rm(r.netProfitSen)} sub={r.annualised ? `annualised ${rm(r.basisProfitSen)}` : "year to date"} icon={TrendingUp} iconBgClass="bg-[#F0ECE9]" iconColorClass="text-[#6B5C32]" valueSizeClass="text-xl" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 max-md:gap-3">
        <Kpi label="Total assets" value={rm(l?.assetsSen)} icon={Landmark} iconBgClass="bg-[#E6F0F3]" iconColorClass="text-[#3E6570]" valueSizeClass="text-xl" />
        <Kpi label="Total liabilities" value={rm(l?.liabilitiesSen)} icon={Scale} iconBgClass="bg-[#F6E3E0]" iconColorClass="text-[#9A3A2D]" valueSizeClass="text-xl" />
        <Kpi label="Total equity" value={rm(l?.equitySen)} icon={Wallet} iconBgClass="bg-[#EEF3E4]" iconColorClass="text-[#4F7C3A]" valueSizeClass="text-xl" />
      </div>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Liabilities vs assets</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!l || l.assetsSen <= 0 ? (
            <p className="text-xs text-[#6B7280]">No positive asset balance in the ledger at this date.</p>
          ) : (
            <>
              <p className="text-sm text-[#1F1D1B]">
                Liabilities are <b>{pct(l.liabilitiesToAssets)}</b> of assets
                {l.assetCover !== null && <> · assets cover liabilities <b>{l.assetCover.toFixed(2)}×</b></>}
              </p>
              <div className="flex h-5 w-full overflow-hidden rounded-md border" style={{ borderColor: BORDER }} role="img" aria-label="Liabilities and equity as a share of assets">
                <div style={{ width: `${Math.min(100, Math.max(0, (l.liabilitiesSen / l.assetsSen) * 100))}%`, background: RED }} title={`Liabilities ${rm(l.liabilitiesSen)}`} />
                <div style={{ width: `${Math.min(100, Math.max(0, (l.equitySen / l.assetsSen) * 100))}%`, background: GREEN }} title={`Equity ${rm(l.equitySen)}`} />
              </div>
              <div className="flex flex-wrap gap-4 text-[11px] text-[#6B7280]">
                <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: RED }} />Liabilities</span>
                <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: GREEN }} />Equity</span>
                <span>Bar = 100% of total assets</span>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      <YoyCard
        d={d}
        chart
        rows={[
          { label: "Revenue", y: d.yoy.revenue, kind: "money", higherBetter: true },
          { label: "Net profit", y: d.yoy.netProfit, kind: "money", higherBetter: true },
          { label: "ROA", y: d.yoy.roa, kind: "ratio", higherBetter: true },
          { label: "ROE", y: d.yoy.roe, kind: "ratio", higherBetter: true },
          { label: "ROI", y: d.yoy.roi, kind: "ratio", higherBetter: true },
        ]}
      />
      <Card>
        <CardContent className="space-y-1 p-4">
          <Note><b>ROA</b> = {r.definitions.roa}. <b>ROE</b> = {r.definitions.roe}. <b>ROI</b> = {r.definitions.roi}.</Note>
          <Note>{r.definitions.basis}</Note>
          <Note>Assets, liabilities and equity are the posted general ledger's balances (same sections as the Balance Sheet tab). A ratio shows "—" when its denominator is zero or negative.</Note>
        </CardContent>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
function PeCell({ v }: { v: PeVariant }) {
  if (v.status === "no-valuation") return <span className="text-[#9C6F1E]">Set a valuation</span>;
  if (v.status === "nm") return <span title="Earnings are zero or negative">n/m</span>;
  if (v.status === "no-data") return <span>—</span>;
  return <span>{(v.pe as number).toFixed(1)}×</span>;
}

function Outlook({ d, onSaved }: { d: Resp; onSaved: () => void }) {
  const f = d.forecast;
  const chartData = f.points.map((p) => ({
    label: monthLabel(p.ym),
    projected: p.projected,
    Revenue: Math.round(p.revenueSen / 100),
    "Net profit": p.profitSen === null ? null : Math.round(p.profitSen / 100),
  }));
  const valSen = d.pe.valuationSen;
  const [draft, setDraft] = useState<number | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const shown = draft !== undefined ? draft : valSen === null ? null : valSen / 100;
  const dirty = draft !== undefined;
  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch("/api/dashboard/finance/valuation", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ valuationRm: draft ?? null }),
      });
      if (r.status === 403 || r.status === 401) throw new Error("Saving needs accounting edit access.");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setDraft(undefined);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 max-md:gap-3">
        <Kpi label="Forecast revenue, next 12 mo" value={rm(f.next12RevenueSen)} sub="estimate" icon={TrendingUp} iconBgClass="bg-[#E6F0F3]" iconColorClass="text-[#3E6570]" valueSizeClass="text-xl" />
        <Kpi label="Forecast net profit, next 12 mo" value={rm(f.next12ProfitSen)} sub="estimate" icon={TrendingUp} iconBgClass="bg-[#EEF3E4]" iconColorClass="text-[#4F7C3A]" valueSizeClass="text-xl" />
        <Kpi label="Trailing net margin" value={f.marginPct === null ? "—" : `${f.marginPct.toFixed(1)}%`} sub={`last ${f.trailingMonths} months with data`} icon={Percent} iconBgClass="bg-[#FAEFCB]" iconColorClass="text-[#9C6F1E]" valueSizeClass="text-xl" />
        <Kpi label="Company valuation" value={rm(valSen)} sub={valSen === null ? "not set" : "owner-entered"} icon={Landmark} iconBgClass="bg-[#F0ECE9]" iconColorClass="text-[#6B5C32]" valueSizeClass="text-xl" />
      </div>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Forward forecast <span className="ml-1 rounded-full bg-[#FAEFCB] px-2 py-0.5 text-[10.5px] font-medium text-[#9C6F1E]">Estimate</span></CardTitle>
          <p className="text-xs text-[#6B7280]">{f.method}</p>
        </CardHeader>
        <CardContent>
          <div className={CHART_WRAP} style={{ width: "100%", height: 260 }}>
            {chartData.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-[#6B7280]">No ledger history to forecast from.</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} stroke={CHART_AXIS} strokeOpacity={0.25} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: CHART_AXIS }} axisLine={{ stroke: CARD_BORDER }} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: CHART_AXIS }} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => fmtRMAxis(Number(v))} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => formatCurrency(Number(v) * 100)} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="Revenue" radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} fill={CHART_INK}>
                    {chartData.map((r) => <Cell key={r.label} fill={r.projected ? "#E3DED5" : CHART_INK} />)}
                  </Bar>
                  <Line type="monotone" dataKey="Net profit" stroke={TEAL} strokeWidth={2} strokeDasharray="5 4" connectNulls isAnimationActive={false} dot={{ r: 2.5, fill: "#FFFFFF", stroke: TEAL, strokeWidth: 2 }} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
          <Note>Greyed bars are projected months. The current month may be part-billed, which pulls the average down.</Note>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Price / earnings</CardTitle>
          <p className="text-xs text-[#6B7280]">
            A private company has no share price, so P/E uses the company valuation you enter here: P/E = valuation ÷ net profit. Zero or negative earnings show "n/m".
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-[#6B7280]">
              Company valuation (RM)
              <div className="mt-1 w-56">
                <MoneyInput
                  value={shown}
                  onChange={(v) => setDraft(v)}
                  disabled={!d.meta.canEditValuation || saving}
                  placeholder="e.g. 5000000"
                  className="w-full rounded-md border border-[#E2DDD8] px-3 py-1.5 text-sm"
                />
              </div>
            </label>
            {d.meta.canEditValuation ? (
              <button
                type="button"
                onClick={save}
                disabled={!dirty || saving}
                className="rounded-md bg-[#6B5C32] px-4 py-1.5 max-md:h-10 text-sm font-medium text-white disabled:opacity-40"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            ) : (
              <span className="text-xs text-[#6B7280]">Editing the valuation needs accounting edit access.</span>
            )}
            {err && <span className="text-xs" style={{ color: AMBER }}>{err}</span>}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-[10.5px] uppercase tracking-wide text-[#6B7280]">
                  <th className="py-2 text-left font-semibold">Variant</th>
                  <th className="py-2 text-right font-semibold">Earnings</th>
                  <th className="py-2 text-right font-semibold">P/E</th>
                  <th className="py-2 pl-4 text-left font-semibold">Basis</th>
                </tr>
              </thead>
              <tbody>
                {d.pe.variants.map((v) => (
                  <tr key={v.key} className="border-b border-[#E2DDD8]">
                    <td className="py-2 font-medium text-[#1F1D1B]">{v.label}</td>
                    <td className="py-2 text-right font-mono">{rm(v.earningsSen)}</td>
                    <td className="py-2 text-right font-mono font-semibold"><PeCell v={v} /></td>
                    <td className="py-2 pl-4 text-xs text-[#6B7280]">{v.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Note>Forward P/E rests on the estimate above. Fiscal year end is month {d.meta.fyeMonth}. Anchored to {monthLabel(d.period.endYm)}.</Note>
        </CardContent>
      </Card>
    </>
  );
}
