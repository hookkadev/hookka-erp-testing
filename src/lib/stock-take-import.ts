// ---------------------------------------------------------------------------
// stock-take-import.ts — pure parsing helpers for the raw (uncategorized)
// monthly stock-count Excel import (owner rule 2026-07-01; design doc
// docs/superpowers/specs/2026-07-01-stock-take-item-alias-import-design.md).
//
// The owner's file has NO category column and its column layout varies month
// to month — grouping comes from an ALIAS TABLE keyed on each physical line's
// own identity (the descriptive columns), not a label. These functions are
// pure (no DB, no fetch) so the tricky bits — shape detection, where the
// identity columns end, key normalization — are unit-testable without a live
// database. The caller (StockTakeTab) does the fetching/resolving/UI.
// ---------------------------------------------------------------------------

// Header names (case-insensitive) that mark the start of the NUMERIC section of
// a row (in2 / Qty / Total in2 / Price per in2) — everything strictly BEFORE the
// first of these (or before "Total" itself, if none of them appear) is the
// row's descriptive IDENTITY. Qty/price change every month for the same
// physical item, so they must never leak into the identity key — only "Total"
// (the money to sum) is read past this boundary.
const NUMERIC_HEADER_NAMES = ["in2", "qty", "total in2", "price/in2"];

/** trim + collapse internal whitespace + lowercase — for both headers and identity cells. */
function normalizeText(v: unknown): string {
  return String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** True if the header row matches the EXISTING clean "Material Group" / "Closing Stock (RM)" import shape. */
export function isCleanImportShape(headerRow: unknown[]): boolean {
  const headers = headerRow.map(normalizeText);
  return headers.includes("material group") && headers.some((h) => h.startsWith("closing stock"));
}

export type RawShape = { totalCol: number; identityCols: number[] };

/**
 * Detects the owner's raw (no-category) monthly file shape: finds the "Total"
 * column by header name, and returns every column index strictly before the
 * first numeric-section header (falling back to "everything before Total" if
 * none of the numeric header names are present). Returns null if no "Total"
 * header exists, or if that leaves zero identity columns (nothing to key on).
 */
export function detectRawShape(headerRow: unknown[]): RawShape | null {
  const headers = headerRow.map(normalizeText);
  const totalCol = headers.indexOf("total");
  if (totalCol < 0) return null;
  let boundary = headers.findIndex((h) => NUMERIC_HEADER_NAMES.includes(h));
  if (boundary < 0 || boundary > totalCol) boundary = totalCol;
  const identityCols = Array.from({ length: boundary }, (_, i) => i);
  if (identityCols.length === 0) return null;
  return { totalCol, identityCols };
}

/** Normalized compound identity key from a row's identity-column values, in order. */
export function normalizeItemKey(identityValues: unknown[]): string {
  return identityValues.map(normalizeText).join("||");
}

/**
 * Extracts an implied "YYYY-MM" from a stock-take filename, for the "does this
 * file's month match what's selected on screen" safety check (owner rule
 * 2026-07-01 — a May-dated file was once saved under July because the Month
 * picker still showed today's month, not the file's). Supports the date
 * shapes seen in the owner's actual filenames: "STOCK TAKE 30.05.2026.xlsx"
 * (DD.MM.YYYY), "STOCK_TAKE_30_05_2026_categorized.xlsx" (DD_MM_YYYY), and
 * this page's own "stock-take-2026-05.xlsx" (YYYY-MM). DD.MM.YYYY order is
 * assumed (matches every file seen) — not disambiguated from MM.DD.YYYY.
 * Returns null if no date is recognised — callers must treat that as
 * "can't check", not "no mismatch".
 */
export function impliedYmFromFilename(filename: string): string | null {
  const iso = filename.match(/(\d{4})-(\d{2})(?:-\d{2})?/);
  if (iso) {
    const m = Number(iso[2]);
    if (m >= 1 && m <= 12) return `${iso[1]}-${iso[2]}`;
  }
  const dmy = filename.match(/(\d{1,2})[._](\d{1,2})[._](\d{4})/);
  if (dmy) {
    const month = Number(dmy[2]);
    if (month >= 1 && month <= 12) return `${dmy[3]}-${String(month).padStart(2, "0")}`;
  }
  return null;
}

export type ParsedRawItem = { key: string; description: string; totalSen: number };

/**
 * Parses every data row (after the header) of a raw-shape sheet into one entry
 * per DISTINCT identity key, summing "Total" (RM, converted to integer sen)
 * across repeated rows with the same key. `description` is the identity
 * columns' original (non-normalized) text, joined with " / ", for display in
 * the "needs mapping" review panel.
 */
export function parseRawStockTakeRows(aoa: unknown[][], shape: RawShape): ParsedRawItem[] {
  const byKey = new Map<string, ParsedRawItem>();
  for (let i = 1; i < aoa.length; i++) {
    const row = aoa[i];
    if (!row || row.every((c) => c === "" || c == null)) continue;
    const idValues = shape.identityCols.map((c) => row[c]);
    const key = normalizeItemKey(idValues);
    if (!key.replace(/\|/g, "").trim()) continue; // every identity cell blank -> not a real row
    const rawTotal = row[shape.totalCol];
    const totalRm = typeof rawTotal === "number" ? rawTotal : Number(String(rawTotal ?? "").trim());
    const totalSen = Number.isFinite(totalRm) ? Math.round(totalRm * 100) : 0;
    const description = idValues.map((v) => String(v ?? "").trim()).filter(Boolean).join(" / ");
    const existing = byKey.get(key);
    if (existing) existing.totalSen += totalSen;
    else byKey.set(key, { key, description, totalSen });
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Quantity-only count (owner 2026-10-09 「这个是 9 月的 closing stock … 只是价钱
// 没有，你看可以从 purchase 那边 capture 吗？」→「用最近一次进货价」). The file is
// the raw-material master export (ID / Item Code / Description / Base UOM /
// Item Group / Balance Qty / Active) with the counted quantity per item and no
// money; each item is priced at its latest purchase on or before month-end
// (GET /api/accounting/stock-take/purchase-prices) and the owner reviews the
// priced sheet before it fills the month's group totals.
// ---------------------------------------------------------------------------

/** A header cell without the master export's required-field star ("Item Code *"). */
const headerName = (v: unknown) => normalizeText(v).replace(/\s*\*$/, "");

/** True for the raw-material master export with a Balance Qty column. */
export function isRmCountShape(headerRow: unknown[]): boolean {
  const h = headerRow.map(headerName);
  return h.includes("item code") && h.includes("item group") && h.includes("balance qty");
}

export type RmCountRow = { id: string; code: string; description: string; uom: string; group: string; qty: number };

/** Every counted item (Balance Qty > 0) of a master-export sheet, in file order. */
export function parseRmCountRows(aoa: unknown[][]): RmCountRow[] {
  const h = (aoa[0] ?? []).map(headerName);
  const at = (name: string) => h.indexOf(name);
  const cId = at("id"), cCode = at("item code"), cDesc = at("description"), cUom = at("base uom"), cGroup = at("item group"), cQty = at("balance qty");
  const cell = (row: unknown[], c: number) => (c >= 0 ? String(row[c] ?? "").trim() : "");
  const out: RmCountRow[] = [];
  for (let i = 1; i < aoa.length; i++) {
    const row = aoa[i];
    if (!row) continue;
    const raw = row[cQty];
    const qty = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(/,/g, "").trim());
    const code = cell(row, cCode);
    if (!code || !Number.isFinite(qty) || qty <= 0) continue;
    // Excel keeps float noise from the count sheet (4.39999999999999).
    out.push({ id: cell(row, cId), code, description: cell(row, cDesc), uom: cell(row, cUom), group: cell(row, cGroup), qty: Math.round(qty * 10000) / 10000 });
  }
  return out;
}

/** The key an item code and a purchase line's material code are matched on. */
export function itemCodeKey(v: unknown): string {
  return String(v ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

/**
 * Why a purchase price needs a look before it values a count: the code was
 * bought at prices more than 3× apart (a roll on one invoice, a metre on
 * another — the count's unit is unknown to the invoice), or its latest buy was
 * one or two units against a count of 20+ (a pack price).
 */
export function priceCheckReasons(p: { countQty: number; lastQty: number; minUnitSen: number; maxUnitSen: number }): ("units" | "pack")[] {
  const out: ("units" | "pack")[] = [];
  if (p.minUnitSen > 0 && p.maxUnitSen / p.minUnitSen > 3) out.push("units");
  if (p.lastQty <= 2 && p.countQty >= 20) out.push("pack");
  return out;
}

/**
 * A unit price typed in RM — up to 4 decimals (a screw costs 0.0198) — to sen,
 * which may be fractional. Commas only as thousands separators ("1,234.50");
 * anything else is unreadable → null, never a guess (BUG-2026-08-13-095).
 */
export function unitPriceToSen(v: string): number | null {
  const t = v.trim();
  if (t.includes(",") && !/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return null;
  const s = t.replace(/,/g, "");
  if (!/^\d+(\.\d{1,4})?$/.test(s)) return null;
  return Math.round(Number(s) * 1000000) / 10000;
}

/** "YYYY-MM" → its last day "YYYY-MM-DD". */
export function lastDayOfYm(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(d).padStart(2, "0")}`;
}
