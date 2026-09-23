// Flattens a purchase order's line items into one searchable string so the PO
// list's global search can find an order by what was BOUGHT on it — internal
// code, supplier SKU or description (staff ask 2026-09-22: "which PO was this
// raw material purchased under?"). The DataGrid searches `String(row[key])`,
// and `String(items)` is "[object Object]", so the array itself is unsearchable.
export type PoSearchItem = {
  materialCode?: string | null;
  supplierSKU?: string | null;
  supplierSku?: string | null;
  materialName?: string | null;
};

export function poItemsSearchText(items: ReadonlyArray<PoSearchItem> | null | undefined): string {
  if (!items?.length) return "";
  const parts: string[] = [];
  for (const it of items) {
    for (const v of [it.materialCode, it.supplierSKU ?? it.supplierSku, it.materialName]) {
      const s = String(v ?? "").trim();
      if (s) parts.push(s);
    }
  }
  return parts.join(" | ");
}
