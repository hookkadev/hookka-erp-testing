// bom_templates.category can only hold BEDFRAME | SOFA (DB CHECK + the
// /api/bom/templates write coercions), so an ACCESSORY product's BOM comes
// back as BEDFRAME. The product row is the source of truth for category
// (same rule as routes/bom.ts `productCategory ?? templateCategory`), so the
// BOM page overlays it on every template it holds.
// ponytail: display overlay only; widen the column CHECK + API coercions if a
// server consumer ever needs the stored value to read ACCESSORY.
export function withProductCategory<T extends { productCode: string; category: string }>(
  templates: T[],
  products: { code: string; category?: string | null }[],
): T[] {
  const byCode = new Map(products.map((p) => [p.code, p.category]));
  return templates.map((t) => {
    const cat = byCode.get(t.productCode);
    return cat && cat !== t.category ? ({ ...t, category: cat } as T) : t;
  });
}
