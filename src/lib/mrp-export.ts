// ---------------------------------------------------------------------------
// mrp-export — the /planning/mrp Excel workbook: one sheet per table tab,
// built from exactly the rows each tab shows (Material Requirements after its
// status filter + sort; Fabric Planning from the same either/or the tab uses).
// Idea taken from the Houzs ERP "MRP stock status" workbook, 2026-10-09.
// ---------------------------------------------------------------------------

import type { Aoa } from "./export-report";
import type { MaterialRequirement } from "@/types";

export type MrpFabricDetail = {
  code: string;
  name: string;
  category: string;
  sohMeters: number;
  poOutstanding: number;
  weeklyUsage: number;
  twoWeekUsage: number;
  monthlyUsage: number;
  shortage: boolean;
};

export const MRP_REQUIREMENT_HEADERS = [
  "Material", "Category", "Unit", "This Wk", "Next Wk", "2-4 Wk", "4+ Wk",
  "Total Req", "On Hand", "On Order", "Net Req", "Status", "Sugg. PO", "MOQ",
  "Supplier", "Lead Time (days)", "Order By",
] as const;

export function buildMrpRequirementsAoa(reqs: MaterialRequirement[]): Aoa {
  const body = reqs.map((r) => {
    const b = r.byBucket ?? {};
    return [
      r.materialName,
      r.materialCategory,
      r.unit,
      b.THIS_WEEK || 0,
      b.NEXT_WEEK || 0,
      b.WEEK_3_4 || 0,
      b.BEYOND || 0,
      r.grossRequired,
      r.onHand,
      r.onOrder,
      r.netRequired,
      r.status,
      r.suggestedPOQty,
      // Blank, never a made-up number, when the supplier binding states none (BUG-2026-08-13-145).
      r.moq ?? "",
      r.preferredSupplierName ?? "",
      r.leadTimeDays ?? "",
      r.suggestedOrderDate ?? "",
    ];
  });
  return [[...MRP_REQUIREMENT_HEADERS], ...body];
}

export const MRP_FABRIC_DETAIL_HEADERS = [
  "Fabric Code", "Description", "Category", "SOH (m)", "PO Outstanding",
  "1 Week Usage", "2 Week Usage", "1 Month Usage", "Status",
] as const;

export const MRP_FABRIC_SUMMARY_HEADERS = [
  "Fabric Material", "Category", "SOH (m)", "Gross Required", "Net Required",
  "Status", "Sugg. PO Qty", "Unit",
] as const;

export function buildMrpFabricAoa(
  fabricDetail: MrpFabricDetail[],
  fabricRequirements: MaterialRequirement[],
): Aoa {
  if (fabricDetail.length > 0) {
    return [
      [...MRP_FABRIC_DETAIL_HEADERS],
      ...fabricDetail.map((f) => [
        f.code, f.name, f.category.replace("_", " "), f.sohMeters, f.poOutstanding,
        f.weeklyUsage, f.twoWeekUsage, f.monthlyUsage, f.shortage ? "SHORTAGE" : "OK",
      ]),
    ];
  }
  return [
    [...MRP_FABRIC_SUMMARY_HEADERS],
    ...fabricRequirements.map((r) => [
      r.materialName, r.materialCategory.replace("_", " "), r.onHand, r.grossRequired,
      r.netRequired, r.status, r.suggestedPOQty, r.unit,
    ]),
  ];
}
