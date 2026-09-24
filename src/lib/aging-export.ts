// ---------------------------------------------------------------------------
// aging-export.ts — build the AR/AP aging export table (owner request
// 2026-07-09 「aging 我要能export」).
//
// Mirrors the owner's old-system "Aging - Detail" report shape: one section
// per party (name line → one row per open document with its amount in the
// bucket column it ages into → a subtotal line), then a grand-total line.
// Un-knocked advances arrive as negative docs and subtract naturally.
//
// Money cells are RM numbers (2-dp) so Excel can sum them; empty bucket
// cells stay "" (not 0) to keep the sheet readable. Pure — unit-tested
// against the same doc shape the /aging snapshot serves.
// ---------------------------------------------------------------------------

export type AgingExportDoc = {
  no: string;
  date: string;
  mo: number; // bucket index 0..4 (current / 1 / 2 / 3 / 3+ months)
  amountSen: number;
};

export type AgingExportParty = {
  name: string;
  currentSen: number;
  days30Sen: number;
  days60Sen: number;
  days90Sen: number;
  over90Sen: number;
  docs?: AgingExportDoc[];
};

export type AgingAoa = (string | number)[][];

const rm = (sen: number): number => Number((sen / 100).toFixed(2));

type AgingBuckets = Pick<AgingExportParty, "currentSen" | "days30Sen" | "days60Sen" | "days90Sen" | "over90Sen">;

function bucketsOf(p: AgingBuckets): number[] {
  return [p.currentSen, p.days30Sen, p.days60Sen, p.days90Sen, p.over90Sen];
}

// Classify an export row for the PDF's banded styling: the party-name line
// is a "section" band (clear company boundary), the "— Total" / docs-less
// single-line parties are "subtotal" bands, GRAND TOTAL gets the dark band.
export function agingRowKind(row: (string | number)[]): "section" | "subtotal" | "grand" | undefined {
  const first = row[0];
  if (first === "GRAND TOTAL") return "grand";
  if (typeof first === "string" && first !== "") {
    return row.slice(1).every((c) => c === "") ? "section" : "subtotal";
  }
  return undefined;
}

/**
 * Five-bucket aging totals — the same sums accounting/index.tsx OverviewTab
 * shows (Current / 1 month / 2 months / 3 months / 3+ months), plus their
 * total. Integer sen in, integer sen out.
 */
export function agingBucketTotals(rows: AgingBuckets[]) {
  const buckets = [
    { period: "Current", amountSen: 0 },
    { period: "1 month", amountSen: 0 },
    { period: "2 months", amountSen: 0 },
    { period: "3 months", amountSen: 0 },
    { period: "3+ months", amountSen: 0 },
  ];
  for (const r of rows) bucketsOf(r).forEach((v, i) => { buckets[i].amountSen += v; });
  return { buckets, totalSen: buckets.reduce((s, b) => s + b.amountSen, 0) };
}

export function buildAgingExportAoa(
  partyHeader: string,
  parties: AgingExportParty[],
): AgingAoa {
  // Date before Doc No (owner 2026-07-09), matching the on-screen detail rows;
  // doc order arrives pre-sorted from /aging (bucket asc, newest first inside).
  const aoa: AgingAoa = [
    [partyHeader, "Date", "Doc No", "Current", "1 Month", "2 Months", "3 Months", "> 3 Months", "Total (RM)"],
  ];
  const grand = [0, 0, 0, 0, 0];
  for (const p of parties) {
    const buckets = bucketsOf(p);
    buckets.forEach((v, i) => { grand[i] += v; });
    const total = buckets.reduce((s, v) => s + v, 0);
    const docs = p.docs ?? [];
    if (docs.length === 0) {
      // Defensive: a party with no doc detail exports as a single line.
      aoa.push([p.name, "", "", ...buckets.map((v) => (v !== 0 ? rm(v) : "")), rm(total)]);
      continue;
    }
    aoa.push([p.name, "", "", "", "", "", "", "", ""]);
    for (const d of docs) {
      const cells: (string | number)[] = ["", "", "", "", ""];
      const b = Math.min(Math.max(Math.round(d.mo) || 0, 0), 4);
      cells[b] = rm(d.amountSen);
      aoa.push(["", d.date, d.no, ...cells, rm(d.amountSen)]);
    }
    aoa.push([`${p.name} — Total`, "", "", ...buckets.map((v) => (v !== 0 ? rm(v) : "")), rm(total)]);
  }
  aoa.push([
    "GRAND TOTAL", "", "",
    ...grand.map((v) => rm(v)),
    rm(grand.reduce((s, v) => s + v, 0)),
  ]);
  return aoa;
}
