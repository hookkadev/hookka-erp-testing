// BUG-2026-10-09-271: Scan PO on the Consignment Orders page posted to
// /api/sales-orders, so every scanned consignment order landed as a DRAFT
// Sales Order. The page now opens the modal with target="CO", and the modal
// re-shapes its Sales Order body for POST /api/consignment-orders.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { toConsignmentOrderBody, hasCustomSpecials } from "../src/lib/scan-po-target.ts";

const soBody = {
  customerId: "cust-1",
  customerName: "X Sdn Bhd",
  customerState: "KL",
  customerPOId: "PO-123",
  reference: "REF-9",
  yourRefNo: "REF-9",
  customerSOId: "S/O-55",
  deliveryHubId: "hub-1",
  companySODate: "2026-10-09",
  customerDeliveryDate: "2026-10-30",
  isUrgent: true,
  customerPOImageB64: "AAAA",
  source: "PO_SCAN_CLAUDE",
  items: [
    { productCode: "S1", itemCategory: "SOFA", sizeLabel: "28", sizeCode: "", seatHeight: "28", basePriceSen: 0, customSpecials: [], transferredFromSO: null },
    { productCode: "B1", itemCategory: "BEDFRAME", sizeLabel: "", sizeCode: "", basePriceSen: 120000 },
  ],
};

test("SO body maps onto the CO create fields", () => {
  const co = toConsignmentOrderBody(soBody, "KL Hub");
  assert.equal(co.customerId, "cust-1");
  assert.equal(co.customerCOId, "PO-123");
  assert.equal(co.reference, "REF-9");
  assert.equal(co.hubId, "hub-1");
  assert.equal(co.hubName, "KL Hub");
  assert.equal(co.companyCODate, "2026-10-09");
  assert.equal(co.customerDeliveryDate, "2026-10-30");
  for (const k of ["customerPOId", "customerSOId", "deliveryHubId", "companySODate", "customerPOImageB64", "isUrgent", "source"]) {
    assert.ok(!(k in co), `${k} must not be sent to the CO create`);
  }
});

test("items pass through; sofa gets its seat height as sizeCode", () => {
  const co = toConsignmentOrderBody(soBody, null);
  assert.equal(co.items[0].seatHeight, "28");
  assert.equal(co.items[0].sizeLabel, "28");
  assert.equal(co.items[0].sizeCode, "28");
  assert.ok(!("customSpecials" in co.items[0]));
  assert.equal(co.items[1].sizeCode, "");
  assert.equal(co.items[1].basePriceSen, 120000);
});

test("custom specials are detected (CO would drop their surcharge)", () => {
  assert.equal(hasCustomSpecials([{ customSpecials: [] }, {}]), false);
  assert.equal(hasCustomSpecials([{ customSpecials: [{ description: "  " }] }]), false);
  assert.equal(hasCustomSpecials([{ customSpecials: [{ description: "Extra arm" }] }]), true);
});

test("the Consignment Orders page opens Scan PO in CO mode", () => {
  const src = fs.readFileSync("src/pages/consignment/index.tsx", "utf8");
  assert.match(src, /<ScanPOModal\s+target="CO"/);
  const modal = fs.readFileSync("src/components/scan-po-modal.tsx", "utf8");
  assert.match(modal, /fetch\(isCO \? "\/api\/consignment-orders" : "\/api\/sales-orders"/);
  assert.doesNotMatch(modal, /fetch\("\/api\/sales-orders", \{/, "every create call must branch on the target");
});
