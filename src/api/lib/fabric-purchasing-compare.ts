// ---------------------------------------------------------------------------
// fabric-purchasing-compare.ts: month buckets for the staging Dashboard Compare
// "Fabric & purchasing" tab (owner 2026-10-09). Pure, so it is tested without a
// database; the route in dashboard-overview.ts runs the queries and the BOM
// pass and hands the rows here.
//
// Every figure is bucketed by a calendar month. Nothing is rolling or "as of
// today", which is how the tab keeps monthly data monthly.
// ---------------------------------------------------------------------------

export type FabricCat = "BEDFRAME" | "SOFA";
export const FABRIC_CATS: FabricCat[] = ["BEDFRAME", "SOFA"];

/** Purchasing is split by the fabric's own item group, not by what it was cut for. */
export const PURCHASE_GROUP_CAT: Record<string, FabricCat> = {
  "B.M-FABR": "BEDFRAME",
  "S.M-FABR": "SOFA",
};

export type CutRow = { cat: string; ym: string; meters: number; shownSen: number; realSen: number; openingMeters: number };
export type InvoiceRow = { ym: string; grp: string; code: string; lines: number; meters: number; sen: number };
export type ReceiptRow = { ym: string; grp: string; meters: number };
export type GrnRow = { ym: string; grp: string; grns: number; meters: number };
export type PoRow = { cat: string; ym: string; fabricCode: string | null; plannedMeters: number; recordedMeters: number; recordedSen: number };

export type CatMonth = {
  // Cost of fabric cut (dashboard Avg cost /m) and the same metres at real prices.
  cutMeters: number;
  shownSen: number;
  realSen: number;
  openingMeters: number;
  // Purchasing, by the fabric's item group.
  invoiceLines: number;
  invoiceMeters: number;
  invoiceSen: number;
  receivedMeters: number;
  grns: number;
  grnMeters: number;
  // Orders finished this month: BOM plan vs what was recorded.
  ordersDone: number;
  ordersRecorded: number;
  plannedMeters: number;
  recordedMeters: number;
  recordedSen: number;
  fabricsUsed: number;
  fabricsRecorded: number;
};

export type TrendRow = { cat: FabricCat; code: string; meters: number; byMonth: Record<string, { meters: number; sen: number }> };

const emptyCatMonth = (): CatMonth => ({
  cutMeters: 0, shownSen: 0, realSen: 0, openingMeters: 0,
  invoiceLines: 0, invoiceMeters: 0, invoiceSen: 0, receivedMeters: 0, grns: 0, grnMeters: 0,
  ordersDone: 0, ordersRecorded: 0, plannedMeters: 0, recordedMeters: 0, recordedSen: 0,
  fabricsUsed: 0, fabricsRecorded: 0,
});

/** The `count` calendar months ending at `toYm`, newest first ("2026-10", "2026-09", ...). */
export function monthsBack(toYm: string, count: number): string[] {
  const [y, m] = toYm.split("-").map(Number);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

export function buildFabricPurchasingMonths(input: {
  months: string[];
  cut: CutRow[];
  invoices: InvoiceRow[];
  receipts: ReceiptRow[];
  grns: GrnRow[];
  orders: PoRow[];
  trendTop?: number;
}): { months: { ym: string; BEDFRAME: CatMonth; SOFA: CatMonth }[]; trend: TrendRow[] } {
  const byYm = new Map(input.months.map((ym) => [ym, { ym, BEDFRAME: emptyCatMonth(), SOFA: emptyCatMonth() }]));
  const slot = (ym: string, cat: string | undefined): CatMonth | null => {
    const row = byYm.get(ym);
    return row && (cat === "BEDFRAME" || cat === "SOFA") ? row[cat] : null;
  };

  for (const r of input.cut) {
    const s = slot(r.ym, r.cat);
    if (!s) continue;
    s.cutMeters += r.meters;
    s.shownSen += r.shownSen;
    s.realSen += r.realSen;
    s.openingMeters += r.openingMeters;
  }
  const trend = new Map<string, TrendRow>();
  for (const r of input.invoices) {
    const cat = PURCHASE_GROUP_CAT[r.grp];
    const s = slot(r.ym, cat);
    if (!s) continue;
    s.invoiceLines += r.lines;
    s.invoiceMeters += r.meters;
    s.invoiceSen += r.sen;
    const key = `${cat}|${r.code}`;
    const t = trend.get(key) ?? { cat, code: r.code, meters: 0, byMonth: {} };
    t.meters += r.meters;
    const cell = t.byMonth[r.ym] ?? { meters: 0, sen: 0 };
    cell.meters += r.meters;
    cell.sen += r.sen;
    t.byMonth[r.ym] = cell;
    trend.set(key, t);
  }
  for (const r of input.receipts) {
    const s = slot(r.ym, PURCHASE_GROUP_CAT[r.grp]);
    if (s) s.receivedMeters += r.meters;
  }
  for (const r of input.grns) {
    const s = slot(r.ym, PURCHASE_GROUP_CAT[r.grp]);
    if (!s) continue;
    s.grns += r.grns;
    s.grnMeters += r.meters;
  }
  const used = new Map<CatMonth, { all: Set<string>; recorded: Set<string> }>();
  for (const r of input.orders) {
    const s = slot(r.ym, r.cat);
    if (!s) continue;
    s.ordersDone += 1;
    s.plannedMeters += r.plannedMeters;
    if (r.recordedMeters > 0) {
      s.ordersRecorded += 1;
      s.recordedMeters += r.recordedMeters;
      s.recordedSen += r.recordedSen;
    }
    if (r.fabricCode) {
      const u = used.get(s) ?? { all: new Set(), recorded: new Set() };
      u.all.add(r.fabricCode);
      if (r.recordedMeters > 0) u.recorded.add(r.fabricCode);
      used.set(s, u);
    }
  }
  for (const [s, u] of used) {
    s.fabricsUsed = u.all.size;
    s.fabricsRecorded = u.recorded.size;
  }

  const top = input.trendTop ?? 10;
  const trendRows = FABRIC_CATS.flatMap((cat) =>
    [...trend.values()]
      .filter((t) => t.cat === cat)
      .sort((a, b) => b.meters - a.meters)
      .slice(0, top),
  );
  return { months: input.months.map((ym) => byYm.get(ym)!), trend: trendRows };
}
