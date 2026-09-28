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
// Allowed UOMs per category (DEV-20). Each itemGroup can narrow the UOMs a
// material in it may carry (e.g. a fabric group → MTR / ROLL). Stored on
// kv-config `variants-config` under `uomOptions`, edited in RM Settings, read
// by every RM form AND enforced by the raw-materials route. A group with no
// list set allows every UOM, so nothing changes until the owner configures it.
// ---------------------------------------------------------------------------

/** Every UOM the RM forms offered before DEV-20 (union of the four lists that
 * were hardcoded in inventory/index.tsx). */
export const ALL_RM_UOMS = ["PCS", "MTR", "ROLL", "BOX", "CTN", "SET", "KG", "LITER", "PAIR", "UNIT"];

/** category (itemGroup) → allowed UOMs. */
export type UomOptions = Record<string, string[]>;

/** The UOMs a material in `group` may use. */
export function uomOptionsFor(group: string, opts: UomOptions | null | undefined): string[] {
  const list = opts?.[(group ?? "").trim()];
  return Array.isArray(list) && list.length > 0 ? list : ALL_RM_UOMS;
}

/** Case-insensitive: legacy rows carry "pcs" / "Mtr" from AutoCount imports. */
export function isUomAllowed(group: string, uom: string, opts: UomOptions | null | undefined): boolean {
  const u = (uom ?? "").trim().toUpperCase();
  return uomOptionsFor(group, opts).some((x) => x.toUpperCase() === u);
}

/** Same unit, ignoring case/whitespace — "pcs" → "PCS" is not a UOM change. */
export function sameUom(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim().toUpperCase() === (b ?? "").trim().toUpperCase();
}
