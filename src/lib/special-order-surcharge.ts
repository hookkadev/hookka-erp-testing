// ---------------------------------------------------------------------------
// special-order-surcharge.ts — derive a line's special-order surcharge from the
// saved `specialOrder` TEXT, for write paths that don't compute it themselves.
//
// WHY THIS EXISTS (BUG-2026-07-17-002 — RM 8,060 under-billed across 66 SOs):
// `sales_order_items.specialOrderPriceSen` was whatever the client POSTed.
// Two clients post sales orders and only ONE of them computes it:
//   • src/pages/sales/create.tsx  — the typed form. Computes the surcharge from
//     the selected CODES and always sends the number. Correct.
//   • src/components/scan-po-modal.tsx + src/pages/m/components/ScanPOSheet.tsx
//     — the scan-a-customer-PO paths. They POST /api/sales-orders DIRECTLY
//     (never through the form), sending the `specialOrder` TEXT and a
//     `basePriceSen` read off the customer's PDF, and NO specialOrderPriceSen.
//     The backend's `Number(item.specialOrderPriceSen) || 0` then stored 0.
// Net: the same bed with the same option was charged RM 80 when typed and RM 0
// when scanned. Measured on prod: 82 of 166 special-order lines charged 0.
//
// Verified NOT a bookkeeping artifact: for every product+fabric where a plain
// line and an optioned line coexist, basePriceSen is IDENTICAL — the customer's
// PO price does not silently include the option, so the money was really lost.
//
// This is the same bug class as the 2026-07-14 totalHeightPriceSen fix in
// sales-orders.ts (a surcharge component silently dropped from the stored unit
// price). The durable answer, per the FE+BE-unified-validation rule, is that the
// SERVER derives the surcharge when the client didn't supply one — so no future
// client can skip it by omission.
//
// TRUST MODEL — deliberately narrow, so this can't over-bill:
//   • client SENT a number (even 0) → TRUST IT, derive nothing. The typed form
//     always sends one, so its combined-cover maths and custom specials win, and
//     Service-Order mode (which sends 0 on purpose — SVs are free by default)
//     keeps charging 0.
//   • client OMITTED the field (undefined/null) → derive from the text.
//     Today that is exactly the two scan paths.
// An unknown token contributes 0 — never guess a price for something that isn't
// in the catalog ("reject, don't normalize"; don't invent money).
// ---------------------------------------------------------------------------
import { specialOrderOptions } from "./pricing-options";

/** Shape of one entry in kv_config.variants-config.specials (owner-editable). */
export type CfgSpecial = { value: string; priceSen: number };

/** Operator free-text special with its own surcharge ("OTHER: <desc>"). */
export type CustomSpecialInput = {
  description?: string | null;
  surchargeSen?: number | null;
};

// COMBO DISCOUNT — corrected 2026-08-02 by the owner, twice over.
//
// What was here was a flat RM 100 TOTAL, applied to HB Fully Cover + Divan FULL
// Cover. Two things were wrong with it:
//   * the pair was wrong. The rule belongs to HB Fully Cover + Divan **TOP**
//     Fully Cover ("If HB & divan top full cover combined = discount RM20").
//     HB + Divan FULL Cover has no rule at all — it is 50 + 80 = 130, and had
//     been charging 100, i.e. RM 30 under per line.
//   * a flat TOTAL hardcodes the prices. The owner edits special-order prices in
//     Settings, and a total of "100" silently stops meaning anything the moment
//     either price moves. Owner:「不要放死价格」.
//
// So it is a DISCOUNT off the sum, not a total. Change a price in Settings and
// the combo follows it; only the discount itself is a number, and it comes from
// the same owner-editable config the prices do.
//
// Owner's ruling on history:「旧的 order 就算了 新的 order 确保要全部跟着」— no
// backfill. Existing orders keep the price they were written with.
export const HB_FULL_COVER = "HB Fully Cover";
export const DIVAN_TOP_COVER = "Divan Top Fully Cover";
/** Kept exported: other modules still name the option. */
export const DIVAN_FULL_COVER = "Divan Full Cover";
/** Default when the config carries no override. RM 20. */
export const HB_DIVAN_TOP_COMBO_DISCOUNT_SEN = 2000;

/** Split the stored text into option tokens. The two writers disagree on the
 *  separator — the form joins with "; " while scan-po.ts:430 joins with ", " —
 *  so accept both. "OTHER: <desc>" tokens are custom specials and are priced
 *  from `customSpecials`, never from the catalog. */
export function parseSpecialOrderTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  return String(text)
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^OTHER\s*:/i.test(s));
}

/** Catalog price for one option NAME. Owner's kv_config entry wins — including
 *  options that exist ONLY in the config (added in Settings, not in the static
 *  table); the static table is the fallback. Unknown in both → 0.
 *  BUG-2026-09-23: a config-only option (e.g. sofa "Extend Down 6\"(1A)") used
 *  to return 0 here, so ticking it showed "+RM 100" but added nothing. */
function priceOfSen(name: string, cfgSpecials?: CfgSpecial[] | null): number {
  if (Array.isArray(cfgSpecials)) {
    const hit = cfgSpecials.find(
      (e) => e && typeof e === "object" && e.value === name,
    );
    if (hit && Number.isFinite(Number(hit.priceSen))) return Number(hit.priceSen);
  }
  return specialOrderOptions.find((o) => o.name === name)?.surcharge ?? 0;
}

/** The checkbox code for an option name: the static table's code, else the
 *  name slugged — the same shape every form's `availableSpecials` derives for
 *  config-only options. */
export function specialCodeForName(name: string): string {
  return (
    specialOrderOptions.find((o) => o.name === name)?.code ??
    name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")
  );
}

/** Reverse of specialCodeForName: code → option name, looking in the static
 *  table first, then the kv_config entries (config-only options). */
export function specialNameForCode(code: string, cfgSpecials?: unknown): string | null {
  const known = specialOrderOptions.find((o) => o.code === code);
  if (known) return known.name;
  if (!Array.isArray(cfgSpecials)) return null;
  for (const e of cfgSpecials) {
    const v =
      e && typeof e === "object" && "value" in e
        ? String((e as { value: unknown }).value)
        : typeof e === "string" ? e : null;
    if (v && specialCodeForName(v) === code) return v;
  }
  return null;
}

/** Keep only well-formed {value, priceSen} entries from a raw kv_config list. */
export function toCfgSpecials(raw: unknown): CfgSpecial[] | null {
  if (!Array.isArray(raw)) return null;
  return raw
    .filter(
      (e): e is CfgSpecial =>
        !!e && typeof e === "object" && "value" in e && "priceSen" in e,
    )
    .map((e) => ({ value: String(e.value), priceSen: Number(e.priceSen) }));
}

/** Surcharge (sen) for the ticked checkbox CODES of a line — the one rule every
 *  SO / CO form uses. `rawCfg` is maintenanceConfig.specials / .sofaSpecials. */
export function calcSpecialsSurchargeSen(codes: string[], rawCfg?: unknown): number {
  const names = codes
    .map((c) => specialNameForCode(c, rawCfg))
    .filter((n): n is string => !!n);
  return deriveSpecialOrderSurchargeSen(names.join("; "), null, toCfgSpecials(rawCfg));
}

/**
 * Total surcharge in sen for a line, derived from its saved text.
 * Mirrors calcPredefinedSurcharge + calcTotalSpecialSurcharge in
 * sales/create.tsx (same catalog, same config override, same combined-cover
 * rule) so a scanned order prices identically to a typed one.
 */
export function deriveSpecialOrderSurchargeSen(
  specialOrderText: string | null | undefined,
  customSpecials?: CustomSpecialInput[] | null,
  cfgSpecials?: CfgSpecial[] | null,
  /** Owner-editable override for the combo discount; defaults to RM 20. */
  comboDiscountSen?: number | null,
): number {
  const tokens = parseSpecialOrderTokens(specialOrderText);
  const hasHb = tokens.includes(HB_FULL_COVER);
  const hasDivanTop = tokens.includes(DIVAN_TOP_COVER);
  const comboDiscount = hasHb && hasDivanTop;

  let sen = 0;
  const counted = new Set<string>();
  for (const t of tokens) {
    // Every option is charged at ITS OWN price, always — the combo is a
    // discount off the sum, never a replacement for it. That is what lets the
    // owner change a price in Settings and have the combo follow.
    if (counted.has(t)) continue;
    counted.add(t);
    sen += priceOfSen(t, cfgSpecials);
  }
  if (comboDiscount) {
    sen -= comboDiscountSen ?? HB_DIVAN_TOP_COMBO_DISCOUNT_SEN;
    // A discount must never turn into a credit, however the prices are edited.
    if (sen < 0) sen = 0;
  }

  for (const cs of customSpecials ?? []) {
    const v = Number(cs?.surchargeSen);
    if (Number.isFinite(v) && v > 0) sen += Math.round(v);
  }
  return sen;
}

/**
 * BUG-2026-09-23-183 backfill maths for ONE saved line. The old forms dropped
 * config-only options (added in Settings) from the surcharge, and saved them
 * as their slug code ("EXTEND_DOWN_5_1A_") instead of their name.
 *
 * Returns the text with slugs turned back into names, and the delta to ADD:
 * the price of the config-only options, capped at (owed − charged) so a line
 * that was already charged them (the old SOFA edit page priced them right)
 * gets 0 — never a double charge, never a decrease, and a static-catalog price
 * that moved in Settings since the order was taken is NOT re-priced.
 */
export function repriceSavedSpecialsLine(
  line: {
    specialOrder: string | null | undefined;
    customSpecials?: CustomSpecialInput[] | null;
    chargedSen: number;
  },
  rawCfg: unknown,
): { text: string; owedSen: number; deltaSen: number } {
  const cfg = toCfgSpecials(rawCfg);
  const inCatalog = (t: string) => specialOrderOptions.some((o) => o.name === t);
  const inCfg = (t: string) => !!cfg?.some((e) => e.value === t);
  const original = String(line.specialOrder ?? "");
  const tokens = original.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  const fixed = tokens.map((t) =>
    /^OTHER\s*:/i.test(t) || inCatalog(t) || inCfg(t) ? t : specialNameForCode(t, cfg) ?? t,
  );
  const text = fixed.some((t, i) => t !== tokens[i]) ? fixed.join("; ") : original;

  const configOnly = new Set(
    parseSpecialOrderTokens(text).filter((t) => !inCatalog(t) && inCfg(t)),
  );
  const configOnlySen = [...configOnly].reduce((s, t) => s + priceOfSen(t, cfg), 0);
  const owedSen = deriveSpecialOrderSurchargeSen(text, line.customSpecials, cfg);
  const deltaSen = Math.max(0, Math.min(configOnlySen, owedSen - line.chargedSen));
  return { text, owedSen, deltaSen };
}

/**
 * The write-path decision. Returns the surcharge to STORE for one posted item.
 * Trusts any client-supplied number (see TRUST MODEL above); only derives when
 * the field was omitted entirely.
 */
export function resolveSpecialOrderPriceSen(
  item: {
    specialOrderPriceSen?: number | string | null;
    specialOrder?: string | null;
    customSpecials?: CustomSpecialInput[] | null;
  },
  cfgSpecials?: CfgSpecial[] | null,
): number {
  if (item.specialOrderPriceSen !== undefined && item.specialOrderPriceSen !== null) {
    return Number(item.specialOrderPriceSen) || 0;
  }
  return deriveSpecialOrderSurchargeSen(
    item.specialOrder,
    item.customSpecials,
    cfgSpecials,
  );
}
