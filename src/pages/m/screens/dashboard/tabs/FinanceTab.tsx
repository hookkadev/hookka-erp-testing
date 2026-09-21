// Finance tab — phone port of the desktop FinanceView (Per head / Returns &
// balance sheet / Outlook & P/E). Reads the SAME endpoint the same way:
// GET /api/dashboard/finance, accounting-gated and no-store. Like the desktop it
// uses a plain fetch, NOT useCachedJson — that hook persists every response in
// localStorage and finance figures must not land there. All maths lives on the
// server (src/api/lib/dashboard-finance.ts); this file only formats.
//
// Phone differences: tables are label-left / value-right rows; the two-series
// per-head chart is two cards; the year-over-year chart shows this period as
// bars with last year as rows under it; the forecast marks projected months
// with "*" (MChartCard has no per-bar colour) and net profit is its own card.
// The ledger is monthly, so a focused day (period.day) does not apply here.
import { useEffect, useState, type ReactNode } from "react";
import { MoneyInput } from "@/components/ui/money-input";
import { formatCurrency } from "@/lib/utils";
import { AMBER, GREEN, RED, fmtRMAxis, monthLabel, periodLabel } from "../../../../dashboards/dashboard-shared-lib";
import { MobileCard } from "../../../components";
import { M, M_ACCENT } from "../../../theme";
import { compactSen } from "../dashboard-m-lib";
import { useDashboardSub } from "../hooks";
import { MChartCard, MKpi, MKpiGrid, MSection, MState, MSubPills } from "../primitives";
import type { DashboardTabProps } from "../types";

// ---- payload (mirror of FinancePayload + route meta; every slice optional) ----

type Yoy = { current: number | null; prior: number | null; deltaAbs: number | null; deltaPct: number | null; hasPrior: boolean };
type PeVariant = {
  key: string;
  label: string;
  earningsSen: number | null;
  pe: number | null;
  status: "ok" | "nm" | "no-valuation" | "no-data";
  note: string;
};
type YoyKey = "revenue" | "labour" | "netProfit" | "labourPerHead" | "revenuePerHead" | "roa" | "roe" | "roi";
type Fin = {
  period?: { mode?: string; endYm?: string };
  coverage?: { priorHasData?: boolean };
  perHead?: {
    headcount: number | null;
    labourSen: number;
    revenueSen: number;
    labourPerHeadSen: number | null;
    revenuePerHeadSen: number | null;
    trend?: { ym: string; labourPerHeadSen: number | null; revenuePerHeadSen: number | null }[];
  };
  returns?: {
    netProfitSen: number;
    basisProfitSen: number;
    annualised: boolean;
    investedCapitalSen: number | null;
    roa: number | null;
    roe: number | null;
    roi: number | null;
    definitions?: { roa: string; roe: string; roi: string; basis: string };
    liabilitiesVsAssets?: {
      assetsSen: number;
      liabilitiesSen: number;
      equitySen: number;
      liabilitiesToAssets: number | null;
      assetCover: number | null;
    } | null;
  };
  yoy?: Partial<Record<YoyKey, Yoy>>;
  yoyChart?: { name: string; current: number; prior: number | null }[];
  forecast?: {
    method: string;
    marginPct: number | null;
    trailingMonths: number;
    next12RevenueSen: number | null;
    next12ProfitSen: number | null;
    points?: { ym: string; revenueSen: number; profitSen: number | null; projected: boolean }[];
  };
  pe?: { valuationSen: number | null; variants?: PeVariant[] };
  meta?: { canEditValuation?: boolean; headcountBasis?: string; fyeMonth?: number };
};
type State = { url: string; status: "ok" | "forbidden" | "error"; data?: Fin; error?: string };

// ---- formatters (same as the desktop view) ----

const rm = (sen: number | null | undefined) => (sen === null || sen === undefined ? "—" : formatCurrency(sen));
const tile = (sen: number | null | undefined) => (sen === null || sen === undefined ? "—" : compactSen(sen, formatCurrency));
const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(1)}%`);
const signed = (x: number, f: (n: number) => string) => `${x > 0 ? "+" : x < 0 ? "-" : ""}${f(Math.abs(x))}`;
const toRm = (sen: number) => Math.round(sen / 100);
const NUM = { fontVariantNumeric: "tabular-nums" } as const;

// ---- small building blocks ----

function Note({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 11.5, lineHeight: 1.45, color: M.muted }}>{children}</div>;
}

function NotesCard({ children }: { children: ReactNode }) {
  return (
    <MobileCard radius={16} style={{ marginTop: 12, display: "grid", gap: 6 }}>
      {children}
    </MobileCard>
  );
}

function Warn({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: "10px 12px", borderRadius: 12, fontSize: 12.5, lineHeight: 1.4, background: M_ACCENT.warning.bg, color: M_ACCENT.warning.fg }}>
      {children}
    </div>
  );
}

/** Table row for the phone: label (+ sub) left, value (+ detail lines) right. */
function Row({ label, sub, value, detail, first }: { label: string; sub?: ReactNode; value: ReactNode; detail?: ReactNode; first: boolean }) {
  return (
    <div
      style={{
        display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12,
        minHeight: 44, padding: "11px 14px", borderTop: first ? undefined : `1px solid ${M.divider}`,
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: M.raisin }}>{label}</div>
        {sub ? <div style={{ fontSize: 11.5, lineHeight: 1.4, color: M.muted, marginTop: 2 }}>{sub}</div> : null}
      </div>
      <div style={{ flex: "none", maxWidth: "58%", textAlign: "right", ...NUM }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: M.raisin }}>{value}</div>
        {detail ? <div style={{ fontSize: 11.5, color: M.muted, marginTop: 2 }}>{detail}</div> : null}
      </div>
    </div>
  );
}

// ---- year over year ----

type YoyRow = { label: string; y: Yoy | undefined; kind: "money" | "ratio"; higherBetter: boolean | null };

function YoyBlock({ d, rows, chart }: { d: Fin; rows: YoyRow[]; chart: boolean }) {
  const noPrior = !d.coverage?.priorHasData;
  const ratioFmt = (n: number) => `${(n * 100).toFixed(1)}%`;
  const bars = d.yoyChart ?? [];
  return (
    <MSection title="Year over year">
      <div style={{ display: "grid", gap: 10 }}>
        <Note>This period against the same window one year earlier (Monthly: the month a year ago; YTD: the same months last year).</Note>
        {noPrior ? (
          <Warn>No prior-year data — the ledger holds nothing for the comparison window, so no deviance is shown.</Warn>
        ) : null}
        <MobileCard padded={false} radius={16} style={{ overflow: "hidden" }}>
          {rows.map((r, i) => {
            const y = r.y;
            const f = r.kind === "money" ? formatCurrency : ratioFmt;
            const good = !y || y.deltaAbs === null || r.higherBetter === null || y.deltaAbs === 0 ? null : (y.deltaAbs > 0) === r.higherBetter;
            const color = good === null ? M.raisin : good ? GREEN : RED;
            return (
              <Row
                key={r.label}
                first={i === 0}
                label={r.label}
                sub={y?.hasPrior && y.prior !== null ? `Last year ${f(y.prior)}` : "no prior-year data"}
                value={!y || y.current === null ? "—" : f(y.current)}
                detail={
                  y?.hasPrior ? (
                    <span style={{ color, fontWeight: 600 }}>
                      {y.deltaAbs === null
                        ? "—"
                        : r.kind === "money"
                          ? signed(y.deltaAbs, formatCurrency)
                          : `${signed(y.deltaAbs * 100, (n) => n.toFixed(1))} pts`}
                      {" · "}
                      {y.deltaPct === null ? "—" : signed(y.deltaPct * 100, (n) => `${n.toFixed(1)}%`)}
                    </span>
                  ) : undefined
                }
              />
            );
          })}
        </MobileCard>
        {chart && !noPrior && bars.length > 0 ? (
          <MChartCard
            title="This period"
            subtitle="Same period last year is listed under the chart."
            data={bars.map((b) => ({ key: b.name, value: toRm(b.current) }))}
            formatAxis={fmtRMAxis}
            footer={
              <div style={{ display: "grid", gap: 4 }}>
                {bars.map((b) => (
                  <div key={b.name} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12, color: M.muted }}>
                    <span>{b.name}, last year</span>
                    <span style={{ color: M.raisin, fontWeight: 600, ...NUM }}>{rm(b.prior)}</span>
                  </div>
                ))}
              </div>
            }
          />
        ) : null}
      </div>
    </MSection>
  );
}

// ---- Per head ----

function PerHead({ d, onMonth }: { d: Fin; onMonth: (ym: string) => void }) {
  const p = d.perHead;
  if (!p) return <MobileCard><MState kind="empty" text="No per-head figures in the Finance response." /></MobileCard>;
  const trend = (p.trend ?? []).map((t) => ({ ...t, label: monthLabel(t.ym) }));
  const anyData = trend.some((t) => t.revenuePerHeadSen !== null || t.labourPerHeadSen !== null);
  const tap = (label: string) => {
    const hit = trend.find((t) => t.label === label);
    if (hit) onMonth(hit.ym);
  };
  // A month without ledger data is unknown (null on the wire); it draws no bar.
  const series = (pick: (t: (typeof trend)[number]) => number | null) =>
    anyData ? trend.map((t) => ({ key: t.label, value: toRm(pick(t) ?? 0) })) : [];
  return (
    <>
      <MKpiGrid>
        <MKpi label="Avg employee cost" value={tile(p.labourPerHeadSen)} tone={AMBER} sub={d.period?.mode === "ytd" ? "labour cost ÷ avg headcount, YTD" : "labour cost ÷ headcount, month"} />
        <MKpi label="Avg employee revenue" value={tile(p.revenuePerHeadSen)} tone={GREEN} sub="revenue ÷ headcount" />
        <MKpi label="Headcount" value={p.headcount === null ? "—" : p.headcount.toLocaleString("en-MY", { maximumFractionDigits: 1 })} sub="ACTIVE, excl. TEST" />
        <MKpi label="Labour cost" value={tile(p.labourSen)} sub={`revenue ${tile(p.revenueSen)}`} />
      </MKpiGrid>

      <MSection title="Per head, last 12 months" hint="Tap a month to open it">
        <div style={{ display: "grid", gap: 10 }}>
          <MChartCard
            title="Revenue / head"
            subtitle="Months without ledger data draw no bar."
            data={series((t) => t.revenuePerHeadSen)}
            onSelect={tap}
            formatAxis={fmtRMAxis}
            emptyText="No ledger data in the last 12 months."
          />
          <MChartCard
            title="Labour cost / head"
            data={series((t) => t.labourPerHeadSen)}
            onSelect={tap}
            formatAxis={fmtRMAxis}
            emptyText="No ledger data in the last 12 months."
          />
        </div>
      </MSection>

      <YoyBlock
        d={d}
        chart={false}
        rows={[
          { label: "Revenue", y: d.yoy?.revenue, kind: "money", higherBetter: true },
          { label: "Labour cost", y: d.yoy?.labour, kind: "money", higherBetter: null },
          { label: "Avg employee cost", y: d.yoy?.labourPerHead, kind: "money", higherBetter: null },
          { label: "Avg employee revenue", y: d.yoy?.revenuePerHead, kind: "money", higherBetter: true },
        ]}
      />

      <NotesCard>
        <Note><b>Labour cost</b> = the P&amp;L's direct labour (750-x) plus salary expense (900-S00x) — the payroll cost the P&amp;L already carries. <b>Revenue</b> = P&amp;L net sales.</Note>
        {d.meta?.headcountBasis ? <Note>{d.meta.headcountBasis}</Note> : null}
      </NotesCard>
    </>
  );
}

// ---- Returns & balance sheet ----

function Returns({ d }: { d: Fin }) {
  const r = d.returns;
  if (!r) return <MobileCard><MState kind="empty" text="No returns figures in the Finance response." /></MobileCard>;
  const l = r.liabilitiesVsAssets;
  const tag = r.annualised ? "annualised (×12)" : "YTD, not annualised";
  const roiSub = r.investedCapitalSen === null ? "no balance sheet" : `on ${tile(r.investedCapitalSen)} invested`;
  const share = (part: number, whole: number) => `${Math.min(100, Math.max(0, (part / whole) * 100))}%`;
  return (
    <>
      <MKpiGrid>
        <MKpi label="ROA" value={pct(r.roa)} tone={GREEN} sub={`net profit ÷ total assets · ${tag}`} />
        <MKpi label="ROE" value={pct(r.roe)} tone="#3E6570" sub={`net profit ÷ total equity · ${tag}`} />
        <MKpi label="ROI" value={pct(r.roi)} tone={AMBER} sub={`net profit ÷ invested capital · ${roiSub}`} />
        <MKpi label="Net profit" value={tile(r.netProfitSen)} sub={r.annualised ? `annualised ${tile(r.basisProfitSen)}` : "year to date"} />
        <MKpi label="Total assets" value={tile(l?.assetsSen)} />
        <MKpi label="Total liabilities" value={tile(l?.liabilitiesSen)} tone={RED} />
        <div style={{ gridColumn: "1 / -1" }}>
          <MKpi label="Total equity" value={tile(l?.equitySen)} tone={GREEN} />
        </div>
      </MKpiGrid>

      <MSection title="Liabilities vs assets">
        <MobileCard radius={16}>
          {!l || l.assetsSen <= 0 ? (
            <Note>No positive asset balance in the ledger at this date.</Note>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ fontSize: 13.5, color: M.raisin, ...NUM }}>
                Liabilities are <b>{pct(l.liabilitiesToAssets)}</b> of assets
                {l.assetCover !== null ? <> · assets cover liabilities <b>{l.assetCover.toFixed(2)}×</b></> : null}
              </div>
              <div
                role="img"
                aria-label="Liabilities and equity as a share of assets"
                style={{ display: "flex", height: 20, width: "100%", overflow: "hidden", borderRadius: 6, border: `1px solid ${M.border}` }}
              >
                <div style={{ width: share(l.liabilitiesSen, l.assetsSen), background: RED }} />
                <div style={{ width: share(l.equitySen, l.assetsSen), background: GREEN }} />
              </div>
              <div style={{ display: "grid", gap: 4, fontSize: 12, color: M.muted }}>
                {[
                  { name: "Liabilities", color: RED, sen: l.liabilitiesSen },
                  { name: "Equity", color: GREEN, sen: l.equitySen },
                ].map((s) => (
                  <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color, flex: "none" }} />
                    <span style={{ flex: 1 }}>{s.name}</span>
                    <span style={{ color: M.raisin, fontWeight: 600, ...NUM }}>{rm(s.sen)}</span>
                  </div>
                ))}
                <div>Bar = 100% of total assets</div>
              </div>
            </div>
          )}
        </MobileCard>
      </MSection>

      <YoyBlock
        d={d}
        chart
        rows={[
          { label: "Revenue", y: d.yoy?.revenue, kind: "money", higherBetter: true },
          { label: "Net profit", y: d.yoy?.netProfit, kind: "money", higherBetter: true },
          { label: "ROA", y: d.yoy?.roa, kind: "ratio", higherBetter: true },
          { label: "ROE", y: d.yoy?.roe, kind: "ratio", higherBetter: true },
          { label: "ROI", y: d.yoy?.roi, kind: "ratio", higherBetter: true },
        ]}
      />

      <NotesCard>
        {r.definitions ? (
          <>
            <Note><b>ROA</b> = {r.definitions.roa}. <b>ROE</b> = {r.definitions.roe}. <b>ROI</b> = {r.definitions.roi}.</Note>
            <Note>{r.definitions.basis}</Note>
          </>
        ) : null}
        <Note>Assets, liabilities and equity are the posted general ledger's balances (same sections as the Balance Sheet tab). A ratio shows "—" when its denominator is zero or negative.</Note>
      </NotesCard>
    </>
  );
}

// ---- Outlook & P/E ----

function peText(v: PeVariant): { text: string; tone?: string } {
  if (v.status === "no-valuation") return { text: "Set a valuation", tone: AMBER };
  if (v.status === "nm") return { text: "n/m" };
  if (v.status === "no-data" || v.pe === null) return { text: "—" };
  return { text: `${v.pe.toFixed(1)}×` };
}

function Outlook({ d, onSaved }: { d: Fin; onSaved: () => void }) {
  const f = d.forecast;
  const valSen = d.pe?.valuationSen ?? null;
  const canEdit = !!d.meta?.canEditValuation;
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

  // "*" marks a projected month (the desktop greys those bars).
  const points = (f?.points ?? []).map((p) => ({ ...p, key: `${monthLabel(p.ym)}${p.projected ? "*" : ""}` }));
  const variants = d.pe?.variants ?? [];

  return (
    <>
      <MKpiGrid>
        <MKpi label="Forecast revenue, next 12 mo" value={tile(f?.next12RevenueSen)} tone="#3E6570" sub="estimate" />
        <MKpi label="Forecast net profit, next 12 mo" value={tile(f?.next12ProfitSen)} tone={GREEN} sub="estimate" />
        <MKpi label="Trailing net margin" value={f?.marginPct === null || f?.marginPct === undefined ? "—" : `${f.marginPct.toFixed(1)}%`} tone={AMBER} sub={`last ${f?.trailingMonths ?? 0} months with data`} />
        <MKpi label="Company valuation" value={tile(valSen)} sub={valSen === null ? "not set" : "owner-entered"} />
      </MKpiGrid>

      <MSection title="Forward forecast" hint="Estimate">
        <div style={{ display: "grid", gap: 10 }}>
          {f?.method ? <Note>{f.method}</Note> : null}
          <MChartCard
            title="Revenue"
            subtitle="Months marked * are projected."
            data={points.map((p) => ({ key: p.key, value: toRm(p.revenueSen) }))}
            formatAxis={fmtRMAxis}
            emptyText="No ledger history to forecast from."
          />
          <MChartCard
            title="Net profit"
            subtitle="Months marked * are projected. Months with no estimate are left out."
            data={points.filter((p) => p.profitSen !== null).map((p) => ({ key: p.key, value: toRm(p.profitSen ?? 0) }))}
            formatAxis={fmtRMAxis}
            emptyText="No ledger history to forecast from."
          />
          <Note>The current month may be part-billed, which pulls the average down.</Note>
        </div>
      </MSection>

      <MSection title="Price / earnings">
        <div style={{ display: "grid", gap: 10 }}>
          <Note>A private company has no share price, so P/E uses the company valuation you enter here: P/E = valuation ÷ net profit. Zero or negative earnings show "n/m".</Note>
          <MobileCard radius={16} style={{ display: "grid", gap: 8 }}>
            <label htmlFor="m-fin-valuation" style={{ fontSize: 12, fontWeight: 600, color: M.muted }}>Company valuation (RM)</label>
            <div style={{ display: "flex", gap: 8 }}>
              <MoneyInput
                id="m-fin-valuation"
                value={shown}
                onChange={(v) => setDraft(v)}
                disabled={!canEdit || saving}
                placeholder="e.g. 5000000"
                className="h-11 flex-1 rounded-xl border-[var(--m-border)] bg-[var(--m-card)] text-[color:var(--m-raisin)]"
              />
              {canEdit ? (
                <button
                  type="button"
                  onClick={save}
                  disabled={!dirty || saving}
                  style={{
                    flex: "none", minHeight: 44, padding: "0 18px", borderRadius: 12, border: "none",
                    background: M.taupe, color: M.card, fontSize: 13.5, fontWeight: 700,
                    opacity: !dirty || saving ? 0.4 : 1, cursor: "pointer", WebkitTapHighlightColor: "transparent",
                  }}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              ) : null}
            </div>
            {canEdit ? null : <Note>Editing the valuation needs accounting edit access.</Note>}
            {err ? <div role="alert" style={{ fontSize: 12, color: AMBER }}>{err}</div> : null}
          </MobileCard>

          {variants.length === 0 ? (
            <MobileCard><MState kind="empty" text="No P/E variants in the Finance response." /></MobileCard>
          ) : (
            <MobileCard padded={false} radius={16} style={{ overflow: "hidden" }}>
              {variants.map((v, i) => {
                const pe = peText(v);
                return (
                  <Row
                    key={v.key}
                    first={i === 0}
                    label={v.label}
                    sub={v.note}
                    value={<span style={{ color: pe.tone }}>{pe.text}</span>}
                    detail={`Earnings ${rm(v.earningsSen)}`}
                  />
                );
              })}
            </MobileCard>
          )}
          <Note>
            Forward P/E rests on the estimate above.
            {d.meta?.fyeMonth ? ` Fiscal year end is month ${d.meta.fyeMonth}.` : ""}
            {d.period?.endYm ? ` Anchored to ${monthLabel(d.period.endYm)}.` : ""}
          </Note>
        </div>
      </MSection>
    </>
  );
}

// ---- the tab ----

export function FinanceTab({ period, setPeriod, months }: DashboardTabProps) {
  const { sub, setSub, subs } = useDashboardSub("finance");
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
        const j = (await r.json()) as { data?: Fin };
        if (!cancelled) setState(j.data ? { url, status: "ok", data: j.data } : { url, status: "error", error: "empty response" });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ url, status: "error", error: e instanceof Error ? e.message : String(e) });
      });
    return () => { cancelled = true; };
  }, [url, tick]);

  const cur = state && state.url === url ? state : null;
  const goMonth = (ym: string) => { if (months.includes(ym)) setPeriod({ mode: "monthly", month: ym }); };

  let body: ReactNode;
  if (!url || !cur) {
    body = <MState kind="loading" />;
  } else if (cur.status === "forbidden") {
    body = <Warn>The Finance tab requires accounting access. Ask an administrator to grant your role the Accounting permission.</Warn>;
  } else if (cur.status === "error" || !cur.data) {
    body = <MState kind="error" text={`Couldn't load Finance: ${cur.error ?? "unknown error"}`} />;
  } else {
    const d = cur.data;
    body = (
      <>
        <div style={{ fontSize: 12.5, color: M.muted, margin: "0 4px 10px" }}>
          {/* The ledger is monthly: a day focused on another tab is not part of this label. */}
          {period.mode === "range" ? `${monthLabel(period.month)} (range shows its month)` : periodLabel({ ...period, day: undefined })} · posted general ledger
        </div>
        {sub === "perhead" ? <PerHead d={d} onMonth={goMonth} /> : null}
        {sub === "returns" ? <Returns d={d} /> : null}
        {sub === "outlook" ? <Outlook d={d} onSaved={() => setTick((t) => t + 1)} /> : null}
      </>
    );
  }

  return (
    <div>
      <MSubPills subs={subs} active={sub} onChange={setSub} />
      <div style={{ padding: "12px 14px 0" }}>{body}</div>
    </div>
  );
}
