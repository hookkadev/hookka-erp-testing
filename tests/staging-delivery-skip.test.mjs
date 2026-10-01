// Staging-only "delivery and billing skip" tool: the pure next-step planner,
// the runner against a stubbed fetch (no network), and pins that the card
// stays staging-host-only and writes only through operator endpoints.
// Staging-only: never PR this into main.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nextStep, runDeliverySkip } from "../src/lib/staging-delivery-skip.ts";

const base = { customerId: "c1", readyPoIds: [], dos: [], invoices: [] };
const DO = (id, status) => ({ id, doNo: id.toUpperCase(), status });
const INV = (id, status, totalSen, paidAmount = 0) => ({ id, invoiceNo: id.toUpperCase(), status, totalSen, paidAmount });

test("finished POs off any live DO get a DO first, whatever the target", () => {
  assert.deepEqual(nextStep({ ...base, readyPoIds: ["p1", "p2"] }, "DO"), { kind: "createDo", poIds: ["p1", "p2"] });
  assert.equal(nextStep({ ...base, readyPoIds: ["p1"] }, "PAID").kind, "createDo");
});

test("target DO stops at the draft", () => {
  assert.equal(nextStep({ ...base, dos: [DO("d1", "DRAFT")] }, "DO"), null);
});

test("delivered: DRAFT is dispatched, LOADED / IN_TRANSIT delivered, CANCELLED skipped", () => {
  assert.equal(nextStep({ ...base, dos: [DO("d0", "CANCELLED"), DO("d1", "DRAFT")] }, "DELIVERED").kind, "dispatch");
  assert.deepEqual(nextStep({ ...base, dos: [DO("d1", "LOADED")] }, "DELIVERED"), { kind: "deliver", doId: "d1", doNo: "D1" });
  assert.equal(nextStep({ ...base, dos: [DO("d1", "IN_TRANSIT")] }, "DELIVERED").kind, "deliver");
  assert.equal(nextStep({ ...base, dos: [DO("d1", "DELIVERED")] }, "DELIVERED"), null);
});

test("invoiced: a DELIVERED DO is invoiced, an INVOICED one is left", () => {
  assert.equal(nextStep({ ...base, dos: [DO("d1", "DELIVERED")] }, "INVOICED").kind, "invoice");
  assert.equal(nextStep({ ...base, dos: [DO("d1", "INVOICED")] }, "INVOICED"), null);
});

test("paid: pays the balance in sen of the first live invoice that owes", () => {
  const s = { ...base, dos: [DO("d1", "INVOICED")], invoices: [INV("i0", "CANCELLED", 500), INV("i1", "PAID", 900, 900), INV("i2", "PARTIALLY_PAID", 12345, 345)] };
  assert.deepEqual(nextStep(s, "PAID"), { kind: "pay", invoiceId: "i2", invoiceNo: "I2", amountSen: 12000 });
  assert.equal(nextStep(s, "INVOICED"), null);
  assert.equal(nextStep({ ...s, invoices: [INV("i1", "PAID", 900, 900)] }, "PAID"), null);
});

// A tiny fake server: the SO read reflects every write the runner made.
function fakeServer({ failOn } = {}) {
  const st = { pos: [{ id: "p1", status: "COMPLETED" }, { id: "p2", status: "IN_PROGRESS" }], dos: [], invoices: [], linked: [] };
  const calls = [];
  const res = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const f = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (method !== "GET") calls.push({ method, url, body, idem: !!init.headers?.["Idempotency-Key"] });
    if (failOn && method !== "GET" && url.startsWith(failOn)) return res(409, { success: false, error: "Credit limit reached", ref: "E1" });
    if (url === "/api/sales-orders/so1") return res(200, { success: true, data: { customerId: "c1" }, linkedPOs: st.pos, linkedDOs: st.dos, linkedInvoices: st.invoices });
    if (url === "/api/delivery-orders/linked-po-ids") return res(200, { poIds: st.linked });
    if (url === "/api/delivery-orders" && method === "POST") {
      st.dos.push({ id: "d1", doNo: "DO-1", status: "DRAFT" });
      st.linked.push(...body.productionOrderIds);
      return res(201, { success: true, data: { id: "d1", doNo: "DO-1" } });
    }
    if (url === "/api/delivery-orders/d1" && method === "PUT") {
      st.dos[0].status = body.status;
      // The DELIVERED cascade raises and posts the invoice and flips the DO.
      if (body.status === "DELIVERED") {
        st.dos[0].status = "INVOICED";
        st.invoices.push({ id: "i1", invoiceNo: "INV-1", status: "SENT", totalSen: 250000, paidAmount: 0 });
      }
      return res(200, { success: true });
    }
    if (url === "/api/payments" && method === "POST") {
      st.invoices[0].paidAmount += body.allocations[0].amount;
      st.invoices[0].status = "PAID";
      return res(201, { success: true, data: { receiptNumber: "OR-1" } });
    }
    return res(404, { success: false, error: `no stub for ${method} ${url}` });
  };
  return { f, calls };
}

test("runner to PAID: DO, dispatch, deliver, pay, through the operator endpoints only", async () => {
  const { f, calls } = fakeServer();
  const log = await runDeliverySkip("so1", "PAID", "2026-10-01", f);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    "POST /api/delivery-orders",
    "PUT /api/delivery-orders/d1",
    "PUT /api/delivery-orders/d1",
    "POST /api/payments",
  ]);
  assert.deepEqual(calls[0].body, { productionOrderIds: ["p1"], salesOrderId: "so1", deliveryDate: "2026-10-01" });
  assert.ok(calls[0].idem && calls[3].idem);
  assert.equal(calls[1].body.status, "LOADED");
  assert.equal(calls[2].body.status, "DELIVERED");
  assert.deepEqual(calls[3].body, {
    customerId: "c1",
    amount: 250000,
    method: "BANK_TRANSFER",
    reference: "Staging test tool",
    date: "2026-10-01",
    allocations: [{ invoiceId: "i1", amount: 250000 }],
  });
  assert.equal(log.at(-1), "Done.");
});

test("runner to DO makes one write", async () => {
  const { f, calls } = fakeServer();
  await runDeliverySkip("so1", "DO", "2026-10-01", f);
  assert.equal(calls.length, 1);
});

test("runner stops at the first refused write and shows the server's error", async () => {
  const { f, calls } = fakeServer({ failOn: "/api/delivery-orders/d1" });
  const log = await runDeliverySkip("so1", "PAID", "2026-10-01", f);
  assert.equal(calls.length, 2);
  assert.equal(log.at(-1), "dispatch failed: Credit limit reached (ref E1)");
});

test("a write that does not move the order stops the run instead of looping", async () => {
  const calls = [];
  const f = async (url, init = {}) => {
    if (init.method) calls.push(url);
    const body = url.startsWith("/api/sales-orders")
      ? { data: { customerId: "c1" }, linkedPOs: [], linkedDOs: [DO("d1", "DELIVERED")], linkedInvoices: [] }
      : url.endsWith("linked-po-ids") ? { poIds: [] } : { success: true };
    return { ok: true, status: 200, json: async () => body };
  };
  const log = await runDeliverySkip("so1", "INVOICED", "d", f);
  assert.deepEqual(calls, ["/api/invoices"]);
  assert.match(log.at(-1), /did not change the order/);
});

test("card is staging-host-only, warns about email, and never calls notify-customer", () => {
  const card = readFileSync(new URL("../src/components/staging-delivery-skip.tsx", import.meta.url), "utf8");
  const lib = readFileSync(new URL("../src/lib/staging-delivery-skip.ts", import.meta.url), "utf8");
  assert.match(card, /if \(!window\.location\.hostname\.startsWith\("staging\."\)\) return null;/);
  assert.match(card, /This sends real email/);
  for (const src of [card, lib]) {
    assert.doesNotMatch(src, /notify-customer|creditOverride|csrfHeaders/);
  }
  const writes = [...lib.matchAll(/send\(\s*(`[^`]*`|"[^"]*")/g)].map((m) => m[1].replace(/\$\{[^}]*\}/, ":id"));
  assert.deepEqual([...new Set(writes)].sort(), ['"/api/delivery-orders"', '"/api/invoices"', '"/api/payments"', "`/api/delivery-orders/:id`"]);
});
