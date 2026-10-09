// ---------------------------------------------------------------------------
// material-variants.ts — per-category variant suffixes for the Add RM
// "Bulk generate" mode (owner 2026-07-11), mirroring the Add FG generator.
//
// Each raw-material category (itemGroup: FOAM, FABRIC, PLYWOOD…) keeps its own
// list of variant suffixes (FOAM → 6mm / 1" / 2" / 3" / 4"). On Add RM the
// operator picks a category + a BASE code, ticks the variants, and one material
// is created per tick: code = `{base}/{variant}` (e.g. "NC36/50" + "6mm" →
// "NC36/50/6mm"). The lists are stored on kv-config `variants-config` under
// `materialVariants` and edited inline in the bulk form (which doubles as the
// "Material Categories" maintenance).
// ---------------------------------------------------------------------------

/** category (itemGroup) → its variant suffixes. */
export type MaterialVariants = Record<string, string[]>;

// Seed: FOAM thickness range from the owner's example. Other categories start
// empty and the owner fills them inline. Keys match the RM itemGroup values.
export const DEFAULT_MATERIAL_VARIANTS: MaterialVariants = {
  FOAM: ["6mm", '1"', '2"', '3"', '4"'],
};

/** Raw-material variant code: `{base}/{variant}` → "NC36/50/6mm" (the owner's
 * separator is "/", distinct from the FG "-"). */
export function materialVariantCode(base: string, variant: string): string {
  return `${base.trim()}/${variant.trim()}`;
}

/** Variant description: "`{baseDescription} {variant}`", or just the variant
 * when no base description was typed. */
export function materialVariantDescription(baseDescription: string, variant: string): string {
  const b = baseDescription.trim();
  return b ? `${b} ${variant.trim()}` : variant.trim();
}

// ---------------------------------------------------------------------------
// RM units (DEV-20). One list for every category: the built-in units plus the
// ones added in RM Settings (kv-config `variants-config` → `extraUoms`). Read
// by every RM form AND enforced by the raw-materials route. The per-category
// lists (`uomOptions`) were taken out 2026-10-07 (owner: confusing); a unit
// typed into one still counts as added until the unit list is next saved.
// ---------------------------------------------------------------------------

/** Every UOM the RM forms offered before DEV-20 (union of the four lists that
 * were hardcoded in inventory/index.tsx). */
export const ALL_RM_UOMS = ["PCS", "MTR", "ROLL", "BOX", "CTN", "SET", "KG", "LITER", "PAIR", "UNIT"];

/** Every unit a raw material may use: the built-ins, then the added ones. */
export function rmUnitsFrom(cfg: { extraUoms?: unknown; uomOptions?: unknown } | null | undefined): string[] {
  const extra = Array.isArray(cfg?.extraUoms) ? cfg.extraUoms : [];
  const legacy = cfg?.uomOptions && typeof cfg.uomOptions === "object" ? Object.values(cfg.uomOptions).flat() : [];
  const added = [...extra, ...legacy].map((u) => String(u).trim().toUpperCase()).filter(Boolean);
  return [...new Set([...ALL_RM_UOMS, ...added])];
}

/** Case-insensitive: legacy rows carry "pcs" / "Mtr" from AutoCount imports. */
export function isUomAllowed(uom: string, units: string[]): boolean {
  const u = (uom ?? "").trim().toUpperCase();
  return units.some((x) => x.toUpperCase() === u);
}

/** Units whose stock balance may not be TYPED as a fraction on the Inventory
 * page (Add RM / Edit RM). Stored on variants-config as `wholeUoms`; absent →
 * this default. PCS is left out on purpose: foam sheets are stocked in PCS and
 * consumed by area, so their counts go fractional. Owner scope: Inventory page
 * only — Stock Adjustments, PO, GRN and production consumption are unchecked. */
export const DEFAULT_WHOLE_UOMS = ["BOX", "CTN", "SET", "PAIR"];

/** The configured whole-number units; an explicit empty list means "none". */
export function wholeUomsFrom(list: unknown): string[] {
  return Array.isArray(list) ? list.map((u) => String(u).trim().toUpperCase()) : DEFAULT_WHOLE_UOMS;
}

/** True when `qty` is a fraction in a unit that must be whole. The tolerance
 * absorbs float noise such as 2.9999999999 from a UI sum. */
export function isFractionOfWholeUom(uom: string, qty: number, wholeUoms: string[]): boolean {
  if (!wholeUoms.includes((uom ?? "").trim().toUpperCase())) return false;
  return Math.abs(qty - Math.round(qty)) > 1e-9;
}

/** Same unit, ignoring case/whitespace — "pcs" → "PCS" is not a UOM change. */
export function sameUom(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim().toUpperCase() === (b ?? "").trim().toUpperCase();
}
