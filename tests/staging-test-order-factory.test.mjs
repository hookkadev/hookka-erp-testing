// Staging-only "test order factory": the pure payload builder and cleanup
// filter, with a stubbed fetch. Staging-only: never PR this into main.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildLine,
  buildTestSoPayload,
  checkDownstream,
  filterVoidable,
  testMarker,
  voidOrders,
} from "../src/lib/staging-test-order-factory.ts";

const SOFA = {
  id: "p-sofa", code: "5530-2A", name: "Sofa 2A", category: "SOFA", baseModel: "5530",
  sizeCode: "2A", sizeLabel: "2A", status: "ACTIVE",
  seatHeightPrices: [
    { height: '28"', priceSen: 100000, tier: "PRICE_2" },
    { height: '28"', priceSen: 120000, tier: "PRICE_1" },
  ],
  defaultVariants: { seatHeight: '28"', legHeight: '6"' },
};
const BED = {
  id: "p-bed", code: "BF-Q", name: "Bedframe Q", category: "BEDFRAME", baseModel: "BF",
  sizeCode: "Q", sizeLabel: "Queen", status: "ACTIVE", basePriceSen: 80000, price1Sen: 90000,
  defaultVariants: { fabricCode: "FAB-1", divanHeight: '10"', legHeight: '4"', gap: '8"' },
};
const ACC = { id: "p-acc", code: "PIL", name: "Pillow", category: "ACCESSORY", baseModel: "", sizeCode: "", sizeLabel: "", status: "ACTIVE", basePriceSen: 5000 };
const FABRICS = [
  { fabricCode: "FAB-1", priceTier: "PRICE_2", sofaPriceTier: "PRICE_1", bedframePriceTier: "PRICE_1" },
  { fabricCode: "FAB-2", priceTier: "PRICE_2" },
];
const zero = () => 0;

test("marker carries date and user", () => {
  assert.equal(testMarker("2026-10-01", "u1"), "[TEST 2026-10-01 by u1]");
});

test("sofa line: seat from defaults, tier price by fabric, qty forced to 1, size = seat, no leg sent", () => {
  const l = buildLine(SOFA, 2, undefined, FABRICS, zero); // rand 0 picks FAB-1 (sofa PRICE_1)
  assert.equal(l.fabricCode, "FAB-1");
  assert.equal(l.basePriceSen, 120000);
  assert.equal(l.quantity, 1);
  assert.equal(l.seatHeight, '28"');
  assert.equal(l.sizeCode, "28");
  assert.equal(l.sizeLabel, '28"');
  assert.equal(l.legHeightInches, null);
  // surcharges are left for the server to derive
  for (const k of ["divanPriceSen", "legPriceSen", "specialOrderPriceSen", "totalHeightPriceSen"]) assert.ok(!(k in l));
});

test("sofa tier falls back to PRICE_2, then any cell for the height", () => {
  assert.equal(buildLine(SOFA, 1, undefined, [FABRICS[1]], zero).basePriceSen, 100000);
});

test("customer price row wins for the seed", () => {
  const cp = { productId: "p-sofa", basePriceSen: null, price1Sen: null, seatHeightPrices: [{ height: '28"', priceSen: 70000 }] };
  assert.equal(buildLine(SOFA, 1, cp, FABRICS, zero).basePriceSen, 70000);
  const cpBed = { productId: "p-bed", basePriceSen: 60000, price1Sen: 65000, seatHeightPrices: null };
  assert.equal(buildLine(BED, 1, cpBed, FABRICS, zero).basePriceSen, 65000); // PRICE_1 fabric
});

test("bedframe: default fabric, PRICE_1 uses price1, heights from defaults", () => {
  const l = buildLine(BED, 2, undefined, FABRICS, () => 0.9);
  assert.equal(l.fabricCode, "FAB-1");
  assert.equal(l.basePriceSen, 90000);
  assert.equal(l.quantity, 2);
  assert.deepEqual([l.divanHeightInches, l.legHeightInches, l.gapInches], [10, 4, 8]);
  const p2 = buildLine({ ...BED, defaultVariants: {} }, 1, undefined, [FABRICS[1]], zero);
  assert.equal(p2.basePriceSen, 80000);
});

test("accessory sends 0 so the server falls back to the product price", () => {
  assert.equal(buildLine(ACC, 1, undefined, FABRICS, zero).basePriceSen, 0);
});

test("payload never mixes sofa with bedframe and skips inactive / seatless sofas", () => {
  let i = 0;
  const seq = [0, 0.99, 0.5, 0.99, 0.2, 0.7, 0.1, 0.4];
  const rand = () => seq[i++ % seq.length];
  const products = [SOFA, BED, ACC, { ...SOFA, id: "dead", status: "INACTIVE" }, { ...SOFA, id: "noseat", seatHeightPrices: [], defaultVariants: {} }];
  for (let n = 0; n < 20; n++) {
    const body = buildTestSoPayload({ customerId: "c1", count: 4, products, customerProducts: [], fabrics: FABRICS, marker: "[M]", rand });
    const cats = new Set(body.items.map((it) => it.itemCategory));
    assert.ok(!(cats.has("SOFA") && cats.has("BEDFRAME")));
    assert.ok(body.items.every((it) => it.productId !== "dead" && it.productId !== "noseat" && it.fabricCode));
    assert.equal(body.reference, "[M]");
    assert.equal(body.status, "DRAFT");
    assert.equal(body.items.length, 4);
  }
});

test("chosen product is used on every line; missing customer refuses", () => {
  const body = buildTestSoPayload({ customerId: "c1", count: 2, chosenId: "p-bed", products: [SOFA, BED], customerProducts: [], fabrics: FABRICS, marker: "[M]", rand: zero });
  assert.deepEqual(body.items.map((it) => it.productId), ["p-bed", "p-bed"]);
  assert.throws(() => buildTestSoPayload({ customerId: "", count: 1, products: [BED], customerProducts: [], fabrics: FABRICS, marker: "[M]" }));
});

const M = testMarker("2026-10-01", "u1");
const so = (id, over = {}) => ({ id, companySOId: id.toUpperCase(), customerName: "C", reference: M, status: "DRAFT", createdAt: "2026-10-01T02:00:00Z", ...over });

test("cleanup filter: marker AND this user AND today (MY time); cancelled drop out; late statuses skipped", () => {
  const rows = [
    so("a"),
    so("b", { reference: testMarker("2026-10-01", "u2") }),       // other user
    so("c", { reference: testMarker("2026-10-01", "u10") }),      // prefix-similar user id
    so("d", { createdAt: "2026-09-30T15:30:00Z" }),               // 23:30 MY on the 30th
    so("e", { createdAt: "2026-09-30T16:30:00Z" }),               // 00:30 MY on the 1st
    so("f", { status: "CANCELLED" }),
    so("g", { status: "READY_TO_SHIP" }),
    so("h", { createdAt: "" }),                                    // no date: fail closed
    so("i", { reference: "real order" }),
    so("j", { createdAt: undefined, created_at: "2026-10-01T01:00:00Z" }),
  ];
  const plan = filterVoidable(rows, M, "2026-10-01");
  assert.deepEqual(plan.toVoid.map((s) => s.id), ["a", "e", "j"]);
  assert.deepEqual(plan.skipped.map((s) => s.so.id), ["g"]);
});

test("downstream check skips orders with a live DO or invoice, keeps cancelled ones", async () => {
  const details = {
    a: { linkedDOs: [], linkedInvoices: [] },
    b: { linkedDOs: [{ doNo: "DO-1", status: "DRAFT" }] },
    c: { linkedDOs: [{ doNo: "DO-2", status: "CANCELLED" }], linkedInvoices: [{ status: "CANCELLED" }] },
    d: { linkedInvoices: [{ invoiceNo: "INV-1", status: "SENT" }] },
  };
  const f = async (url) => {
    const id = decodeURIComponent(url.split("/").pop());
    if (id === "e") return new Response("{}", { status: 500 });
    return new Response(JSON.stringify({ success: true, ...details[id] }), { status: 200 });
  };
  const plan = await checkDownstream({ toVoid: ["a", "b", "c", "d", "e"].map((id) => so(id)), skipped: [] }, f);
  assert.deepEqual(plan.toVoid.map((s) => s.id), ["a", "c"]);
  assert.deepEqual(plan.skipped.map((s) => s.so.id), ["b", "d", "e"]);
});

test("void goes through the status PUT only, never DELETE", async () => {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, method: init?.method, body: JSON.parse(init?.body ?? "{}") });
    return url.endsWith("/b")
      ? new Response(JSON.stringify({ success: false, error: "blocked" }), { status: 409 })
      : new Response(JSON.stringify({ success: true }), { status: 200 });
  };
  const r = await voidOrders([so("a"), so("b")], "Tester", f);
  assert.equal(r.done, 1);
  assert.deepEqual(r.errors, ["B: blocked"]);
  assert.ok(calls.every((c) => c.method === "PUT" && c.body.status === "CANCELLED" && c.body.changedBy === "Tester"));
});

test("tool renders only on the staging host and never hard-deletes", () => {
  const src = readFileSync(new URL("../src/components/staging-test-order-factory.tsx", import.meta.url), "utf8");
  assert.match(src, /const isStaging = window\.location\.hostname\.startsWith\("staging\."\);/);
  assert.match(src, /if \(!isStaging\) return null;/);
  const lib = readFileSync(new URL("../src/lib/staging-test-order-factory.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src + lib, /"DELETE"/);
});
