// Scan PO serves two pages. The modal builds a Sales Order body; opened from the
// Consignment Orders page it must create a Consignment Order instead, so the
// same body is re-shaped for POST /api/consignment-orders (BUG-2026-10-09-271:
// the CO page used to post to /api/sales-orders, so every scanned consignment
// order landed as a DRAFT Sales Order).
//
// What a CO cannot hold, and is therefore dropped: the customer's S/O No.
// (customerSOId), the PO page image, isUrgent / terms / yourRefNo (the SO save
// drops those too), and custom specials. Custom specials carry a surcharge the
// CO save would lose, so the modal refuses them up front (hasCustomSpecials)
// rather than silently under-pricing the line.

export type ScanTarget = "SO" | "CO";

type ScanSoItem = {
  itemCategory?: string | null;
  sizeLabel?: string | null;
  sizeCode?: string | null;
  customSpecials?: unknown;
  transferredFromSO?: unknown;
  [k: string]: unknown;
};

type ScanSoBody = {
  customerId: string | null;
  customerPOId?: string | null;
  reference?: string | null;
  deliveryHubId?: string | null;
  companySODate?: string | null;
  customerDeliveryDate?: string | null;
  hookkaExpectedDD?: string | null;
  items: ScanSoItem[];
};

export function toConsignmentOrderBody(so: ScanSoBody, hubName: string | null) {
  return {
    customerId: so.customerId,
    customerCOId: so.customerPOId ?? null,
    reference: so.reference ?? null,
    hubId: so.deliveryHubId ?? null,
    hubName,
    companyCODate: so.companySODate ?? null,
    customerDeliveryDate: so.customerDeliveryDate ?? null,
    hookkaExpectedDD: so.hookkaExpectedDD ?? null,
    items: so.items.map((item) => {
      const { customSpecials: _cs, transferredFromSO: _tf, ...rest } = item;
      void _cs;
      void _tf;
      // The SO save fills an empty sofa sizeCode from its sizeLabel; the CO
      // save stores what it is sent. Send the bare seat height, the same value
      // the CO create page puts in sizeCode.
      const sizeCode =
        rest.itemCategory === "SOFA" && !rest.sizeCode
          ? String(rest.sizeLabel ?? "").replace(/"/g, "").trim()
          : rest.sizeCode;
      return { ...rest, sizeCode };
    }),
  };
}

export function hasCustomSpecials(
  items: { customSpecials?: { description: string }[] | null }[],
): boolean {
  return items.some((it) =>
    (it.customSpecials ?? []).some((cs) => cs.description.trim().length > 0),
  );
}
