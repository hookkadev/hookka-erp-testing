// WIP component types offered in the BOM editor's type dropdown.
//
// The six built-in types carry factory rules keyed by their code (department
// chains in bom-wip-breakdown.ts, the SOFA_ sofa-set scan fan-out, foam
// bonding planning), so they are fixed. Extra types (e.g. Sandback) are typed
// as plain names in Products > Maintenance > BOM > WIP Types and saved in
// variants-config.wipTypes. An extra type has no fixed rules: its departments
// come from the BOM's own processes.

export type WipTypeStyle = { label: string; color: string };

export const BUILT_IN_WIP_TYPES: Record<string, WipTypeStyle> = {
  HEADBOARD: { label: "Headboard", color: "#7C3AED" },
  DIVAN: { label: "Divan", color: "#0891B2" },
  SOFA_BASE: { label: "Sofa Base", color: "#059669" },
  SOFA_CUSHION: { label: "Back Cushion", color: "#D97706" },
  SOFA_ARMREST: { label: "Sofa Armrest", color: "#DC2626" },
  SOFA_HEADREST: { label: "Sofa Headrest", color: "#7C3AED" },
};

const EXTRA_COLOR = "#6B7280";

// Used until Maintenance is saved with its own list. A saved empty list means
// "no extras" and is kept as is.
export const DEFAULT_EXTRA_WIP_TYPES = ["Sandback"];

// "Sandback" -> "SANDBACK", "Sofa Foot Rest" -> "SOFA_FOOT_REST".
export function wipTypeCode(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// Built-ins first, then each saved extra name (the defaults when nothing is
// saved). A name whose code is blank or already taken is skipped.
export function buildWipTypes(extraNames: unknown): Record<string, WipTypeStyle> {
  const out: Record<string, WipTypeStyle> = { ...BUILT_IN_WIP_TYPES };
  for (const n of Array.isArray(extraNames) ? extraNames : DEFAULT_EXTRA_WIP_TYPES) {
    if (typeof n !== "string") continue;
    const code = wipTypeCode(n);
    if (code && !out[code]) out[code] = { label: n.trim(), color: EXTRA_COLOR };
  }
  return out;
}
