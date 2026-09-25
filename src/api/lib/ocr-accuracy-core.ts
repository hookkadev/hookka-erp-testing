// ---------------------------------------------------------------------------
// ocr-accuracy-core.ts — pure diff logic for the OCR accuracy dashboard.
//
// Definition (owner 2026-07-04): a scanned document is a SUCCESS if the
// operator changed NOTHING between what OCR extracted (rawExtracted / rawJson)
// and what they finally imported (correctedJson). ANY change to a meaningful
// field = FAIL, and the changed field name(s) are the fail reason.
//
// Pure + deterministic so it's unit-tested (ocr-accuracy.test.mjs). The route
// (routes/ocr-accuracy.ts) loads the samples + product-category map and calls
// these; all IO stays there.
// ---------------------------------------------------------------------------

export type DiffResult = { changed: boolean; fields: string[] };

// Normalise a scalar for comparison: null/undefined/"" collapse together;
// strings trim + upper-case (codes are case-insensitive on the shop floor);
// numbers compare as numbers so 5 and "5" and 5.0 are equal.
function norm(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  const s = String(v).trim();
  if (s === "") return "";
  const n = Number(s);
  if (!Number.isNaN(n) && /^-?\d*\.?\d+$/.test(s)) return String(n);
  return s.toUpperCase();
}

function eq(a: unknown, b: unknown): boolean {
  return norm(a) === norm(b);
}

type AnyRec = Record<string, unknown>;
const asRec = (v: unknown): AnyRec => (v && typeof v === "object" ? (v as AnyRec) : {});
const asArr = (v: unknown): AnyRec[] =>
  Array.isArray(v) ? v.map((x) => asRec(x)) : [];

// Compare the operator-editable fields of a Sales Order scan. Header PO +
// customer, then each line's product/size/fabric/qty/special (matched by
// position — the modal edits rows in place, so index alignment holds).
const SO_HEADER: [string, string][] = [
  ["customerPO", "Customer PO"],
  ["customerName", "Customer"],
];
const SO_LINE: [string, string][] = [
  ["productCode", "Product code"],
  ["sizeCode", "Size"],
  ["fabricCode", "Fabric code"],
  ["quantity", "Qty"],
  ["specialOrder", "Special order"],
];

/**
 * The raw PO to compare a corrected one against.
 *
 * Since the multi-PO scan (2026-06-30) `rawExtracted` holds the whole DOCUMENT
 * — `{ pos: [ … ] }` — while `correctedJson` holds the single PO the operator
 * imported. Comparing the envelope against a PO reads `customerPO` and `items`
 * off an object that has neither, so every field registers as edited and the
 * scan can never be a success. That is the whole of the 0% the owner saw on
 * 2026-08-05: 49 scans, every one of them envelope-shaped, several byte-for-byte
 * identical to what was imported.
 *
 * Match by PO NUMBER, not by position. One document routinely carries two POs
 * and the operator imports them separately, so `pos[0]` is the right PO only by
 * luck — in the sample that prompted this, page 1 was PO/2608-027 and the
 * imported row was PO/2608-029.
 *
 * A raw PO number that matches nothing falls back to the sole entry when there
 * is only one; with several and no match there is nothing honest to compare, so
 * the caller is handed the envelope and the scan counts as changed.
 */
export function rawPoFor(raw: unknown, corrected: unknown): unknown {
  const r = asRec(raw);
  if (!Array.isArray(r.pos)) return raw; // legacy flat sample
  const pos = asArr(r.pos);
  if (pos.length === 0) return raw;
  const want = norm(asRec(corrected).customerPO);
  if (want) {
    const hit = pos.find((p) => norm(p.customerPO) === want);
    if (hit) return hit;
  }
  return pos.length === 1 ? pos[0] : raw;
}

export function diffSalesOrderSample(raw: unknown, corrected: unknown): DiffResult {
  const r = asRec(rawPoFor(raw, corrected));
  const c = asRec(corrected);
  const fields = new Set<string>();

  for (const [key, label] of SO_HEADER) {
    if (!eq(r[key], c[key])) fields.add(label);
  }
  const ri = asArr(r.items);
  const ci = asArr(c.items);
  if (ri.length !== ci.length) fields.add("Line added/removed");
  const n = Math.min(ri.length, ci.length);
  for (let i = 0; i < n; i++) {
    for (const [key, label] of SO_LINE) {
      if (!eq(ri[i][key], ci[i][key])) fields.add(label);
    }
  }
  return { changed: fields.size > 0, fields: [...fields] };
}

// Per-LINE diff for the customer × category breakdown (category is a line-level
// concept — one order can mix Sofa + Bedframe). Matches items by position and
// returns each line's productCode (so the route can map it to the Hookka
// catalog category) plus whether that line's own fields were edited.
export type LineDiff = { productCode: string; changed: boolean; fields: string[] };

export function salesOrderLineDiffs(raw: unknown, corrected: unknown): LineDiff[] {
  const ci = asArr(asRec(corrected).items);
  const ri = asArr(asRec(rawPoFor(raw, corrected)).items);
  return ci.map((cLine, i) => {
    const rLine = ri[i] ?? {};
    const fields: string[] = [];
    for (const [key, label] of SO_LINE) {
      if (!eq(rLine[key], cLine[key])) fields.push(label);
    }
    // A line the operator added (no matching raw line) counts as changed.
    const added = i >= ri.length;
    if (added && fields.length === 0) fields.push("Line added");
    return {
      productCode: String(cLine.productCode ?? rLine.productCode ?? "").trim(),
      changed: fields.length > 0 || added,
      fields,
    };
  });
}

// Compare a supplier scan. The supplier envelope is { docs: [ { docNo, lines:
// [...] } ] } (multi-doc since 2026-06-30) OR a single legacy { lines: [...] }.
// We flatten to the list of docs, compare header docNo + each line's
// code/description/qty/price by position.
const SUP_HEADER: [string, string][] = [
  ["docNo", "Doc No"],
  ["supplierName", "Supplier"],
];
const SUP_LINE: [string, string][] = [
  ["supplierCode", "Material code"],
  ["description", "Description"],
  ["qty", "Qty"],
  ["unitPrice", "Unit price"],
];

function docsOf(v: unknown): AnyRec[] {
  const rec = asRec(v);
  if (Array.isArray(rec.docs)) return asArr(rec.docs);
  // Legacy single-doc shape: the envelope itself is the doc.
  return [rec];
}

export function diffSupplierSample(raw: unknown, corrected: unknown): DiffResult {
  let rd = docsOf(raw);
  const cd = docsOf(corrected);
  const fields = new Set<string>();
  // Same envelope-vs-document mismatch as the sales side: `rawJson` may hold
  // every document on the page while `correctedJson` holds the one that was
  // imported. Narrow to the matching docNo before counting a length difference,
  // or a two-invoice scan reads as "Doc added/removed" on both halves.
  if (rd.length > cd.length && cd.length === 1) {
    const want = norm(cd[0].docNo);
    const hit = want ? rd.find((d) => norm(d.docNo) === want) : undefined;
    if (hit) rd = [hit];
  }
  if (rd.length !== cd.length) fields.add("Doc added/removed");
  const dn = Math.min(rd.length, cd.length);
  for (let d = 0; d < dn; d++) {
    for (const [key, label] of SUP_HEADER) {
      if (!eq(rd[d][key], cd[d][key])) fields.add(label);
    }
    const rl = asArr(rd[d].lines);
    const cl = asArr(cd[d].lines);
    if (rl.length !== cl.length) fields.add("Line added/removed");
    const ln = Math.min(rl.length, cl.length);
    for (let i = 0; i < ln; i++) {
      for (const [key, label] of SUP_LINE) {
        if (!eq(rl[i][key], cl[i][key])) fields.add(label);
      }
    }
  }
  return { changed: fields.size > 0, fields: [...fields] };
}

// ---- Aggregation helpers (pure) -------------------------------------------

export type Bucket = {
  key: string;
  total: number;
  success: number;
  failFields: Record<string, number>;
};

export function emptyBucket(key: string): Bucket {
  return { key, total: 0, success: 0, failFields: {} };
}

export function addToBucket(b: Bucket, diff: DiffResult): void {
  b.total += 1;
  if (!diff.changed) b.success += 1;
  else for (const f of diff.fields) b.failFields[f] = (b.failFields[f] ?? 0) + 1;
}

/** rate 0–100, 1dp; null when no samples. */
export function rateOf(b: { total: number; success: number }): number | null {
  return b.total === 0 ? null : Math.round((b.success / b.total) * 1000) / 10;
}

/** Top-N fail fields as "Label (count)" strings, most-frequent first. */
export function topFails(failFields: Record<string, number>, n = 3): string[] {
  return Object.entries(failFields)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([label, count]) => `${label} (${count})`);
}

// ---------------------------------------------------------------------------
// Per-model queue summary (2026-09-25) — the dashboard's OCR tab.
//
// The sample tables only hold scans the operator IMPORTED, so a model that
// fails or produces junk the operator throws away looks no worse there. This
// works from scan_queue instead: every finished row counts, and each row gets
// exactly one outcome.
// ---------------------------------------------------------------------------

export type QueueRow = {
  id: string;
  kind: string; // "po" | "supplier"
  model: string | null; // scan_queue.ocr_model; null = scanned before it was stamped
  status: string; // done | failed (other statuses are filtered out by the caller)
  secs: number | null; // started_at → completed_at
  consumed: boolean;
  raw: unknown; // the sample's raw extraction (null when no sample)
  corrected: unknown; // the sample's correctedJson (null = not imported)
  fileName: string;
  error: string | null;
  createdAt: string;
};

/**
 * One scan_queue SELECT row → QueueRow minus the sample fields. Dual-keyed:
 * the DB layer hands columns back camelCased (sample_id → sampleId), the same
 * reason hydrateRow in routes/scan-queue.ts reads `r.x ?? r.x_snake`.
 */
export function readQueueRow(r: Record<string, unknown>): Omit<QueueRow, "raw" | "corrected"> & { sampleId: string | null } {
  const v = (camel: string, snake: string) => r[camel] ?? r[snake] ?? null;
  const secs = r.secs == null ? null : Number(r.secs);
  return {
    id: String(r.id ?? ""),
    kind: String(r.kind ?? "po"),
    model: (v("ocrModel", "ocr_model") as string | null) || null,
    status: String(r.status ?? ""),
    secs: secs !== null && Number.isFinite(secs) ? secs : null,
    consumed: v("consumedAt", "consumed_at") != null,
    sampleId: (v("sampleId", "sample_id") as string | null) || null,
    fileName: String(v("fileName", "file_name") ?? ""),
    error: (r.error ?? null) as string | null,
    createdAt: String(v("createdAt", "created_at") ?? ""),
  };
}

export type Outcome = "clean" | "edited" | "failed" | "discarded" | "pending";

export const KIND_LABEL: Record<string, string> = {
  po: "Customer PO",
  supplier: "Supplier doc",
};
export const UNRECORDED_MODEL = "Not recorded";

export function rowOutcome(r: QueueRow): { outcome: Outcome; fields: string[] } {
  if (r.status === "failed") return { outcome: "failed", fields: [] };
  if (r.corrected) {
    const d = r.kind === "supplier"
      ? diffSupplierSample(r.raw, r.corrected)
      : diffSalesOrderSample(r.raw, r.corrected);
    return d.changed ? { outcome: "edited", fields: d.fields } : { outcome: "clean", fields: [] };
  }
  // Consumed with nothing imported = the operator dismissed the result.
  return { outcome: r.consumed ? "discarded" : "pending", fields: [] };
}

/** Nearest-rank percentile of an unsorted list; null when empty. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

const pct1 = (n: number, d: number): number | null =>
  d === 0 ? null : Math.round((n / d) * 1000) / 10;

export type ModelGroup = {
  kind: string;
  kindLabel: string;
  model: string;
  scans: number;
  failed: number;
  discarded: number;
  pending: number;
  imported: number;
  clean: number;
  /** clean / imported */
  accuracy: number | null;
  /** failed / scans */
  failureRate: number | null;
  avgSec: number | null;
  p90Sec: number | null;
  /** Per-field miss rate over imported scans, worst first. */
  fields: { field: string; fails: number; rate: number | null }[];
};

export type ProblemScan = {
  id: string;
  kindLabel: string;
  model: string;
  fileName: string;
  outcome: "failed" | "edited";
  detail: string;
  createdAt: string;
};

export function summariseQueue(rows: QueueRow[], recentLimit = 25): {
  groups: ModelGroup[];
  problems: ProblemScan[];
} {
  const acc = new Map<string, ModelGroup & { _secs: number[] }>();
  const problems: ProblemScan[] = [];
  for (const r of rows) {
    const model = r.model || UNRECORDED_MODEL;
    const kindLabel = KIND_LABEL[r.kind] ?? r.kind;
    const key = `${r.kind}||${model}`;
    let g = acc.get(key);
    if (!g) {
      g = {
        kind: r.kind, kindLabel, model, scans: 0, failed: 0, discarded: 0, pending: 0,
        imported: 0, clean: 0, accuracy: null, failureRate: null, avgSec: null, p90Sec: null,
        fields: [], _secs: [],
      };
      acc.set(key, g);
    }
    const { outcome, fields } = rowOutcome(r);
    g.scans += 1;
    if (r.secs !== null && Number.isFinite(r.secs) && r.status === "done") g._secs.push(r.secs);
    if (outcome === "failed") g.failed += 1;
    else if (outcome === "discarded") g.discarded += 1;
    else if (outcome === "pending") g.pending += 1;
    else {
      g.imported += 1;
      if (outcome === "clean") g.clean += 1;
      for (const f of fields) {
        const hit = g.fields.find((x) => x.field === f);
        if (hit) hit.fails += 1;
        else g.fields.push({ field: f, fails: 1, rate: null });
      }
    }
    if (outcome === "failed" || outcome === "edited") {
      problems.push({
        id: r.id,
        kindLabel,
        model,
        fileName: r.fileName,
        outcome,
        detail: outcome === "failed" ? (r.error ?? "").slice(0, 300) : fields.join(", "),
        createdAt: r.createdAt,
      });
    }
  }
  const groups = [...acc.values()].map(({ _secs, ...g }) => ({
    ...g,
    accuracy: pct1(g.clean, g.imported),
    failureRate: pct1(g.failed, g.scans),
    avgSec: _secs.length ? Math.round((_secs.reduce((a, b) => a + b, 0) / _secs.length) * 10) / 10 : null,
    p90Sec: percentile(_secs, 90),
    fields: g.fields
      .map((f) => ({ ...f, rate: pct1(f.fails, g.imported) }))
      .sort((a, b) => b.fails - a.fails),
  }));
  groups.sort((a, b) => a.kind.localeCompare(b.kind) || b.scans - a.scans);
  problems.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return { groups, problems: problems.slice(0, recentLimit) };
}
