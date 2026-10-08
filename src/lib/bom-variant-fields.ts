// Variant fields offered in the BOM WIP code builder, per product type.
//
// Each field is a token the sales order fills in at apply time (see
// resolveWipTokens in bom-wip-breakdown.ts and the code builder in bom.tsx),
// so only these known fields can be offered. Which of them each product type
// shows is ticked in Products > Maintenance > BOM > Variant Fields and saved
// in variants-config.bomVariantFields.

export type VariantField = { category: string; label: string };

// One fixed order; each type shows the ticked fields in this order.
export const VARIANT_FIELDS: VariantField[] = [
  { category: "PRODUCT_CODE", label: "Product Code" },
  { category: "MODEL", label: "Model" },
  { category: "SIZE", label: "Size" },
  { category: "SEAT_SIZE", label: "Seat Size" },
  { category: "MODULE", label: "Module" },
  { category: "DIVAN_HEIGHT", label: "Divan Height" },
  { category: "LEG_HEIGHT", label: "Leg Height" },
  { category: "TOTAL_HEIGHT", label: "Total Height" },
  { category: "FABRIC", label: "Fabric" },
  { category: "SPECIAL", label: "Special" },
];

export const BOM_PRODUCT_TYPES = [
  { key: "BEDFRAME", label: "Bedframe" },
  { key: "SOFA", label: "Sofa" },
  { key: "ACCESSORY", label: "Accessory" },
];

export const DEFAULT_VARIANT_FIELDS: Record<string, string[]> = {
  BEDFRAME: ["PRODUCT_CODE", "SIZE", "DIVAN_HEIGHT", "LEG_HEIGHT", "TOTAL_HEIGHT", "FABRIC", "SPECIAL"],
  SOFA: ["PRODUCT_CODE", "MODEL", "SEAT_SIZE", "MODULE", "FABRIC", "SPECIAL"],
  ACCESSORY: ["PRODUCT_CODE", "MODEL", "SIZE", "FABRIC"],
};

// A type that is not BEDFRAME or SOFA reads the ACCESSORY list. A type with
// no saved list uses its default; a saved empty list stays empty.
export function variantFieldsFor(category: string | undefined, saved: unknown): VariantField[] {
  const key = category === "BEDFRAME" || category === "SOFA" ? category : "ACCESSORY";
  const list = (saved as Record<string, unknown> | null | undefined)?.[key];
  const ticked = new Set(Array.isArray(list) ? list : DEFAULT_VARIANT_FIELDS[key]);
  return VARIANT_FIELDS.filter((f) => ticked.has(f.category));
}
