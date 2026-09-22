// Last verified: 2026-09-21 against src/api/routes/accounting.ts
// (`loadFinanceSeries`, which supplies the rows), src/lib/revenue-forecast.ts
// and src/api/lib/headcount-rule.ts.
//
// The Finance dashboard tab's maths, as PURE functions over rows — no DB, no
// clock — so every rule below is unit-tested (tests/dashboard-finance.test.mjs).
// The route (routes/dashboard-finance.ts) only fetches rows and calls
// `buildFinancePayload`.
//
// DEFINITIONS (the UI prints the same text):
//   revenue        = P&L net sales (GL revenue accounts, same as the P&L tab)
//   labour cost    = P&L direct labour (750-x) + salary opex (900-S00x) — the
//                    payroll cost the P&L already carries, payslip-injected
//   net profit     = the P&L's net profit (gross profit + other income − opex)
//   avg cost/head  = labour cost ÷ headcount;  avg revenue/head = revenue ÷ headcount
//   ROA            = net profit ÷ total assets
//   ROE            = net profit ÷ total equity (incl. un-closed current earnings)
//   ROI            = net profit ÷ invested capital, invested capital =
//                    equity + long-term liabilities (the chart of accounts has no
//                    "interest-bearing" flag; long-term liabilities is the debt-like
//                    section the Balance Sheet already isolates)
//   Balance-sheet denominators are the CLOSING balances at the period end.
//   Annualising: YTD profit is used as-is; a single month's profit is ×12 and
//   flagged "annualised".
//   Money is integer sen; ratios are plain fractions (0.12 = 12%).

import { rollingForecast } from "../../lib/revenue-forecast";

export type FinMonth = {
  ym: string;
  revenueSen: number;
  labourSen: number;
  netProfitSen: number;
  assetsSen: number;
  liabilitiesSen: number; // ALL liabilities (current + long-term)
  ltLiabilitiesSen: number; // long-term section only
  equitySen: number;
  headcount: number;
};

export type Mode = "monthly" | "ytd";

// ---- small pure helpers ----------------------------------------------------
export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let c = from; c <= to; c = addMonths(c, 1)) out.push(c);
  return out;
}
/** Start month of the fiscal year containing `ym` (FYE month 12 = calendar year). */
export function fiscalYearStart(ym: string, fyeMonth: number): string {
  const [y, m] = ym.split("-").map(Number);
  const startMonth = (fyeMonth % 12) + 1;
  const startYear = m >= startMonth ? y : y - 1;
  return `${startYear}-${String(startMonth).padStart(2, "0")}`;
}
/** a ÷ b, or null when b is not a positive finite number. */
export function ratio(a: number | null, b: number | null): number | null {
  if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  return a / b;
}
/** Per-head amount in whole sen; null with no headcount. */
export function perHead(totalSen: number, heads: number | null): number | null {
  if (heads === null || !(heads > 0)) return null;
  return Math.round(totalSen / heads);
}
const hasData = (m: FinMonth): boolean => m.revenueSen !== 0 || m.labourSen !== 0 || m.netProfitSen !== 0;

export type WindowSum = {
  revenueSen: number;
  labourSen: number;
  netProfitSen: number;
  avgHeadcount: number | null; // mean over months that carry data
  months: number; // months in the window
  monthsWithData: number;
  hasData: boolean;
};
export function sumWindow(byYm: Map<string, FinMonth>, months: string[]): WindowSum {
  let revenueSen = 0, labourSen = 0, netProfitSen = 0, heads = 0, withData = 0;
  for (const ym of months) {
    const r = byYm.get(ym);
    if (!r || !hasData(r)) continue;
    revenueSen += r.revenueSen;
    labourSen += r.labourSen;
    netProfitSen += r.netProfitSen;
    heads += r.headcount;
    withData++;
  }
  return {
    revenueSen, labourSen, netProfitSen,
    avgHeadcount: withData > 0 && heads > 0 ? heads / withData : null,
    months: months.length, monthsWithData: withData, hasData: withData > 0,
  };
}

// ---- returns ---------------------------------------------------------------
export type Returns = {
  netProfitSen: number; // as reported for the window
  basisProfitSen: number; // the figure the ratios use (annualised when monthly)
  annualised: boolean;
  assetsSen: number | null;
  equitySen: number | null;
  investedCapitalSen: number | null;
  roa: number | null;
  roe: number | null;
  roi: number | null;
};
export function computeReturns(
  netProfitSen: number,
  mode: Mode,
  bs: { assetsSen: number; equitySen: number; ltLiabilitiesSen: number } | null,
): Returns {
  const annualised = mode === "monthly";
  const basisProfitSen = annualised ? netProfitSen * 12 : netProfitSen;
  const invested = bs ? bs.equitySen + bs.ltLiabilitiesSen : null;
  return {
    netProfitSen, basisProfitSen, annualised,
    assetsSen: bs ? bs.assetsSen : null,
    equitySen: bs ? bs.equitySen : null,
    investedCapitalSen: invested,
    roa: ratio(basisProfitSen, bs ? bs.assetsSen : null),
    roe: ratio(basisProfitSen, bs ? bs.equitySen : null),
    roi: ratio(basisProfitSen, invested),
  };
}

// ---- year over year --------------------------------------------------------
export type Yoy = {
  current: number | null;
  prior: number | null;
  deltaAbs: number | null;
  deltaPct: number | null; // relative to |prior|; null when prior is 0/absent
  hasPrior: boolean;
};
/** `priorHasData` false → the prior side is reported as absent, never as 0. */
export function yoy(current: number | null, prior: number | null, priorHasData: boolean): Yoy {
  const hasPrior = priorHasData && prior !== null;
  const deltaAbs = hasPrior && current !== null ? current - (prior as number) : null;
  const deltaPct =
    hasPrior && current !== null && (prior as number) !== 0
      ? (current - (prior as number)) / Math.abs(prior as number)
      : null;
  return { current, prior: hasPrior ? prior : null, deltaAbs, deltaPct, hasPrior };
}

// ---- P/E -------------------------------------------------------------------
export type PeStatus = "ok" | "nm" | "no-valuation" | "no-data";
export type PeVariant = {
  key: "current" | "trailing" | "forward" | "lastYear";
  label: string;
  earningsSen: number | null;
  pe: number | null;
  status: PeStatus;
  note: string;
};
/**
 * valuation ÷ earnings. No valuation → "no-valuation" (and NO number). Earnings
 * unknown → "no-data". Earnings <= 0 → "nm" (never a negative P/E).
 */
export function peRatio(valuationSen: number | null, earningsSen: number | null): { pe: number | null; status: PeStatus } {
  if (valuationSen === null || !(valuationSen > 0)) return { pe: null, status: "no-valuation" };
  if (earningsSen === null || !Number.isFinite(earningsSen)) return { pe: null, status: "no-data" };
  if (earningsSen <= 0) return { pe: null, status: "nm" };
  return { pe: valuationSen / earningsSen, status: "ok" };
}

// ---- forecast --------------------------------------------------------------
export type ForecastOut = {
  method: string;
  marginPct: number | null;
  trailingMonths: number;
  next12RevenueSen: number | null;
  next12ProfitSen: number | null;
  points: { ym: string; revenueSen: number; profitSen: number | null; projected: boolean }[];
};
/**
 * Forward revenue = the shared 3-month rolling average carried flat (the Sales
 * tab's forecast). Forward net profit = trailing margin × forward revenue, the
 * margin being Σ net profit ÷ Σ revenue over the last up-to-12 months with data
 * (needs >= 3 such months and positive revenue, else no profit estimate).
 */
export function buildForecast(rows: FinMonth[], endYm: string): ForecastOut {
  const data = rows.filter((r) => r.ym <= endYm && hasData(r)).sort((a, b) => (a.ym < b.ym ? -1 : 1));
  const method =
    "Estimate: revenue = average of the last 3 months carried flat (same method as the Sales tab forecast); " +
    "net profit = trailing margin (last up to 12 months) x forecast revenue.";
  if (data.length === 0) {
    return { method, marginPct: null, trailingMonths: 0, next12RevenueSen: null, next12ProfitSen: null, points: [] };
  }
  const { projected } = rollingForecast(data.map((r) => [r.ym, r.revenueSen] as const), 12);
  const trail = data.slice(-12);
  const trailRev = trail.reduce((s, r) => s + r.revenueSen, 0);
  const trailProfit = trail.reduce((s, r) => s + r.netProfitSen, 0);
  const margin = trail.length >= 3 && trailRev > 0 ? trailProfit / trailRev : null;
  const points: ForecastOut["points"] = [
    ...trail.map((r) => ({ ym: r.ym, revenueSen: r.revenueSen, profitSen: r.netProfitSen, projected: false })),
    ...projected.map((p) => ({
      ym: p.ym,
      revenueSen: Math.round(p.sen),
      profitSen: margin === null ? null : Math.round(p.sen * margin),
      projected: true,
    })),
  ];
  const pj = points.filter((p) => p.projected);
  return {
    method,
    marginPct: margin === null ? null : margin * 100,
    trailingMonths: trail.length,
    next12RevenueSen: pj.reduce((s, p) => s + p.revenueSen, 0),
    next12ProfitSen: margin === null ? null : pj.reduce((s, p) => s + (p.profitSen ?? 0), 0),
    points,
  };
}

// ---- workers → headcount -----------------------------------------------------
export type WorkerLite = {
  empNo: string | null;
  status: string | null;
  joinDate: string | null;
  resignedAt: string | null;
};
/** Last calendar day of a YYYY-MM as YYYY-MM-DD. */
export function monthEnd(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}
/**
 * Headcount at the end of `ym`. The current (or a future) month uses the live
 * ACTIVE non-TEST rule exactly; a finished month is RECONSTRUCTED from
 * join / resign dates (TEST accounts out; INACTIVE workers have no date to
 * place them, so they are out of history). `isCounted` is the shared rule.
 */
export function headcountAt(
  workers: WorkerLite[],
  ym: string,
  nowYm: string,
  isCounted: (status: string | null, empNo: string | null) => boolean,
): number {
  if (ym >= nowYm) return workers.filter((w) => isCounted(w.status, w.empNo)).length;
  const end = monthEnd(ym);
  let n = 0;
  for (const w of workers) {
    if (/^TEST/i.test(w.empNo ?? "")) continue;
    if (w.status === "INACTIVE") continue;
    if (w.joinDate && String(w.joinDate).slice(0, 10) > end) continue;
    if (w.resignedAt && String(w.resignedAt).slice(0, 10) <= end) continue;
    n++;
  }
  return n;
}

// ---- the payload -------------------------------------------------------------
export type FinanceOpts = {
  mode: Mode;
  month: string; // the picker's month
  endYm: string; // last month of the window (== month when monthly)
  fyeMonth: number;
  valuationSen: number | null;
};

export function buildFinancePayload(rows: FinMonth[], o: FinanceOpts) {
  const byYm = new Map(rows.map((r) => [r.ym, r] as const));
  const dataMonths = rows.filter(hasData).map((r) => r.ym).sort();
  const firstDataYm = dataMonths[0] ?? null;
  const end = o.endYm;
  const winMonths = o.mode === "monthly" ? [end] : monthRange(`${end.slice(0, 4)}-01`, end);
  const priorMonths = winMonths.map((m) => addMonths(m, -12));
  const cur = sumWindow(byYm, winMonths);
  const pri = sumWindow(byYm, priorMonths);
  const bsOf = (ym: string) => {
    const r = byYm.get(ym);
    return r && (hasData(r) || r.assetsSen !== 0 || r.liabilitiesSen !== 0 || r.equitySen !== 0)
      ? { assetsSen: r.assetsSen, liabilitiesSen: r.liabilitiesSen, ltLiabilitiesSen: r.ltLiabilitiesSen, equitySen: r.equitySen }
      : null;
  };
  const bsCur = bsOf(end);
  const bsPri = bsOf(addMonths(end, -12));

  // per head
  const perHeadOf = (w: WindowSum) => ({
    labourPerHeadSen: perHead(w.labourSen, w.avgHeadcount),
    revenuePerHeadSen: perHead(w.revenueSen, w.avgHeadcount),
  });
  const ph = perHeadOf(cur);
  const phPrior = perHeadOf(pri);

  // returns
  const ret = computeReturns(cur.netProfitSen, o.mode, bsCur);
  const retPrior = pri.hasData ? computeReturns(pri.netProfitSen, o.mode, bsPri) : null;

  // liabilities vs assets
  const lva = bsCur
    ? {
        assetsSen: bsCur.assetsSen,
        liabilitiesSen: bsCur.liabilitiesSen,
        equitySen: bsCur.equitySen,
        liabilitiesToAssets: ratio(bsCur.liabilitiesSen, bsCur.assetsSen),
        assetCover: ratio(bsCur.assetsSen, bsCur.liabilitiesSen),
      }
    : null;

  // year over year
  const p = pri.hasData;
  const yoyOut = {
    revenue: yoy(cur.revenueSen, pri.revenueSen, p),
    labour: yoy(cur.labourSen, pri.labourSen, p),
    netProfit: yoy(cur.netProfitSen, pri.netProfitSen, p),
    labourPerHead: yoy(ph.labourPerHeadSen, phPrior.labourPerHeadSen, p),
    revenuePerHead: yoy(ph.revenuePerHeadSen, phPrior.revenuePerHeadSen, p),
    roa: yoy(ret.roa, retPrior?.roa ?? null, p && !!retPrior),
    roe: yoy(ret.roe, retPrior?.roe ?? null, p && !!retPrior),
    roi: yoy(ret.roi, retPrior?.roi ?? null, p && !!retPrior),
  };

  // forecast + P/E
  const forecast = buildForecast(rows, end);
  const fyStart = fiscalYearStart(end, o.fyeMonth);
  const covered = (from: string) => firstDataYm !== null && from >= firstDataYm;
  // current: fiscal-YTD (from the later of FY start and the first month with data), annualised
  const curFrom = firstDataYm !== null && firstDataYm > fyStart ? firstDataYm : fyStart;
  const curMonths = end >= curFrom ? monthRange(curFrom, end) : [];
  const curSum = sumWindow(byYm, curMonths);
  const currentEarn =
    curMonths.length > 0 && curSum.hasData ? Math.round((curSum.netProfitSen * 12) / curMonths.length) : null;
  const t12From = addMonths(end, -11);
  const t12 = sumWindow(byYm, monthRange(t12From, end));
  const trailingEarn = covered(t12From) && t12.hasData ? t12.netProfitSen : null;
  const lyFrom = addMonths(fyStart, -12);
  const ly = sumWindow(byYm, monthRange(lyFrom, addMonths(fyStart, -1)));
  const lastYearEarn = covered(lyFrom) && ly.hasData ? ly.netProfitSen : null;
  const variant = (
    key: PeVariant["key"], label: string, earn: number | null, note: string, missing: string,
  ): PeVariant => {
    const r = peRatio(o.valuationSen, earn);
    return { key, label, earningsSen: earn, pe: r.pe, status: r.status, note: earn === null ? missing : note };
  };
  const pe: PeVariant[] = [
    variant("current", "Current P/E", currentEarn,
      `Fiscal year to date (${curMonths.length} month${curMonths.length === 1 ? "" : "s"}), annualised x12/${curMonths.length}.`,
      "No ledger data in the current fiscal year yet."),
    variant("trailing", "Trailing 12-month P/E", trailingEarn,
      "Net profit of the last 12 months.", "Needs 12 months of ledger history."),
    variant("forward", "Forward P/E", forecast.next12ProfitSen,
      "Forecast net profit of the next 12 months (an estimate).", "Not enough history to estimate forward profit."),
    variant("lastYear", "Last full year P/E", lastYearEarn,
      "Net profit of the last completed fiscal year.", "The last full fiscal year is not fully covered by the ledger."),
  ];

  return {
    period: { mode: o.mode, month: o.month, endYm: end, months: winMonths.length },
    coverage: { firstDataYm, priorHasData: p },
    perHead: {
      headcount: cur.avgHeadcount,
      headcountPrior: pri.avgHeadcount,
      labourSen: cur.labourSen,
      revenueSen: cur.revenueSen,
      labourPerHeadSen: ph.labourPerHeadSen,
      revenuePerHeadSen: ph.revenuePerHeadSen,
      monthsWithData: cur.monthsWithData,
      trend: monthRange(addMonths(end, -11), end).map((ym) => {
        const r = byYm.get(ym);
        const on = r && hasData(r);
        return {
          ym,
          labourPerHeadSen: on ? perHead(r.labourSen, r.headcount) : null,
          revenuePerHeadSen: on ? perHead(r.revenueSen, r.headcount) : null,
        };
      }),
    },
    returns: {
      ...ret,
      definitions: {
        roa: "Net profit / total assets",
        roe: "Net profit / total equity (incl. current-year earnings not yet closed)",
        roi: "Net profit / invested capital, where invested capital = equity + long-term liabilities",
        basis: ret.annualised
          ? "Monthly view: the month's net profit is annualised (x12). Balances are the closing balances at month end."
          : "YTD view: year-to-date net profit as-is (not annualised). Balances are the closing balances at the latest month.",
      },
      liabilitiesVsAssets: lva,
    },
    yoy: yoyOut,
    yoyChart: [
      { name: "Revenue", current: cur.revenueSen, prior: p ? pri.revenueSen : null },
      { name: "Labour cost", current: cur.labourSen, prior: p ? pri.labourSen : null },
      { name: "Net profit", current: cur.netProfitSen, prior: p ? pri.netProfitSen : null },
    ],
    forecast,
    pe: { valuationSen: o.valuationSen, variants: pe },
  };
}

export type FinancePayload = ReturnType<typeof buildFinancePayload>;

