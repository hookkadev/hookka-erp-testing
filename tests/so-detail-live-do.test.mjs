// ---------------------------------------------------------------------------
// so-detail-live-do.test.mjs — BUG-2026-09-30-224 (class C21, first-one-wins).
//
// GET /api/sales-orders/:id builds linkedPOs[].deliveryDoNo / deliveryStatus
// from delivery_order_items, which come back in no chosen order. It kept the
// first DO seen per production order, so a PO whose DO was cancelled and
// replaced could show the CANCELLED DO. Seen on staging with SO-2609-397:
// DO-2609-090 cancelled, DO-2609-091 created, the page said DO-2609-090.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPoDeliveryMap } from "../src/api/routes/sales-orders/_helpers.ts";

const DOS = [
  { id: "do-90", doNo: "DO-2609-090", status: "CANCELLED" },
  { id: "do-91", doNo: "DO-2609-091", status: "DRAFT" },
];

test("the live DO wins when the cancelled DO's row comes first", () => {
  const m = buildPoDeliveryMap(
    [
      { productionOrderId: "po-1", deliveryOrderId: "do-90" },
      { productionOrderId: "po-1", deliveryOrderId: "do-91" },
    ],
    DOS,
  );
  assert.deepEqual(m.get("po-1"), { doNo: "DO-2609-091", status: "DRAFT" });
});

test("the live DO wins when its row comes first", () => {
  const m = buildPoDeliveryMap(
    [
      { productionOrderId: "po-1", deliveryOrderId: "do-91" },
      { productionOrderId: "po-1", deliveryOrderId: "do-90" },
    ],
    DOS,
  );
  assert.deepEqual(m.get("po-1"), { doNo: "DO-2609-091", status: "DRAFT" });
});

test("a cancelled DO still shows when no live DO exists", () => {
  const m = buildPoDeliveryMap(
    [{ productionOrderId: "po-1", deliveryOrderId: "do-90" }],
    DOS,
  );
  assert.deepEqual(m.get("po-1"), { doNo: "DO-2609-090", status: "CANCELLED" });
});

test("rows for DOs not linked to the SO are ignored", () => {
  const m = buildPoDeliveryMap(
    [{ productionOrderId: "po-1", deliveryOrderId: "do-other" }],
    DOS,
  );
  assert.equal(m.has("po-1"), false);
});

test("the SO detail route builds the map through the helper", () => {
  const src = readFileSync(
    new URL("../src/api/routes/sales-orders.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    src,
    /poDeliveryMap\s*=\s*buildPoDeliveryMap\(diRes\.results \?\? \[\],\s*linkedDOs\)/,
  );
  assert.doesNotMatch(src, /!poDeliveryMap\.has\(/);
});
