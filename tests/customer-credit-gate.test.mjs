// BUG-34 — customer credit gate (src/api/lib/customer-credit.ts).
// Pure rules via decideCredit + structural pins that every goods-release
// path runs the SAME gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const { decideCredit } = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/customer-credit.ts")).href
);

const base = {
  customerId: "c1",
  name: "Acme",
  creditTerms: "NET30",
  limitSen: 0,
  outstandingSen: 0,
  pendingDoSen: 0,
  unpaid: [],
};
const inv = (invoiceDate, balanceSen = 10000) => ({ invoiceNo: `INV-${invoiceDate}`, invoiceDate, balanceSen });

test("NET30: January bill is fine through Feb 28, blocked from Mar 1", () => {
  const s = { ...base, unpaid: [inv("2026-01-15")] };
  assert.equal(decideCredit(s, 0, "2026-02-28"), null);
  const b = decideCredit(s, 0, "2026-03-01");
  assert.equal(b.code, "PAYMENT_OVERDUE");
  assert.equal(b.details.overdue[0].dueDate, "2026-02-28");
  assert.equal(b.details.overdueSen, 10000);
});

test("NET60: January bill blocks from Apr 1; COD blocks from the next month", () => {
  const s60 = { ...base, creditTerms: "NET60", unpaid: [inv("2026-01-15")] };
  assert.equal(decideCredit(s60, 0, "2026-03-31"), null);
  assert.equal(decideCredit(s60, 0, "2026-04-01").code, "PAYMENT_OVERDUE");
  const cod = { ...base, creditTerms: "COD", unpaid: [inv("2026-01-15")] };
  assert.equal(decideCredit(cod, 0, "2026-01-31"), null);
  assert.equal(decideCredit(cod, 0, "2026-02-01").code, "PAYMENT_OVERDUE");
});

test("fully paid / zero-balance / undated invoices never block", () => {
  const s = { ...base, unpaid: [inv("2025-01-01", 0), inv("", 5000)] };
  assert.equal(decideCredit(s, 0, "2026-09-28"), null);
});

test("limit: outstanding + undelivered DOs + this DO", () => {
  const s = { ...base, limitSen: 100000, outstandingSen: 50000, pendingDoSen: 30000 };
  assert.equal(decideCredit(s, 20000, "2026-09-28"), null, "exactly at the limit passes");
  const b = decideCredit(s, 20001, "2026-09-28");
  assert.equal(b.code, "CREDIT_LIMIT_EXCEEDED");
  assert.equal(b.details.projected, 100001);
  assert.equal(b.details.pendingDo, 30000);
});

test("limit 0 = no quota check (overdue still applies)", () => {
  const s = { ...base, limitSen: 0, outstandingSen: 9e9 };
  assert.equal(decideCredit(s, 9e9, "2026-09-28"), null);
  assert.equal(decideCredit({ ...s, unpaid: [inv("2026-01-15")] }, 0, "2026-09-28").code, "PAYMENT_OVERDUE");
});

test("overdue wins over the limit", () => {
  const s = { ...base, limitSen: 1, outstandingSen: 5, unpaid: [inv("2026-01-15")] };
  assert.equal(decideCredit(s, 0, "2026-09-28").code, "PAYMENT_OVERDUE");
});

test("structural: DO create, packing-list-first and dispatch all run the shared gate", () => {
  const helpers = readFileSync("src/api/routes/delivery-orders/_helpers.ts", "utf8");
  const routes = readFileSync("src/api/routes/delivery-orders.ts", "utf8");
  const core = helpers.slice(helpers.indexOf("export async function createDeliveryOrderForPOs("));
  assert.match(core.slice(0, core.indexOf("genDoId()")), /gateCredit\(\s*c,\s*await checkCustomerCredit\(/);
  const upd = helpers.slice(helpers.indexOf("export async function applyDeliveryOrderUpdate("));
  assert.match(upd, /body\.status === "LOADED" && existing\.status === "DRAFT"[\s\S]{0,200}checkCustomerCredit\(/);
  const pl = routes.slice(routes.indexOf('app.post("/packing-list-first"'));
  assert.ok(pl.indexOf("checkCustomerCredit(") < pl.indexOf("body.preview === true"), "credit check before preview");
  assert.match(pl, /creditOverride: body\.creditOverride/, "override reaches the core");
  // No second copy of the old inline limit maths anywhere in the DO routes.
  assert.doesNotMatch(helpers + routes, /projectedOutstanding|projectCreditFailure/);
});

// BUG-2026-10-07-263: the Sales "Transfer to Delivery Order" box swallowed the
// credit block into "Failed to create Delivery Order", and read the ready list
// from the serve-stale snapshot ("Nothing ready" for a just-finished order).
test("structural: Sales transfer box shows the credit dialog and reads a fresh ready list", () => {
  const sales = readFileSync("src/pages/sales/index.tsx", "utf8");
  const routes = readFileSync("src/api/routes/delivery-orders.ts", "utf8");
  const box = sales.slice(sales.indexOf('fetchJson("/api/delivery-orders", DOMutationSchema'));
  assert.match(box.slice(0, 1500), /isCreditBlock\(eb\)[\s\S]{0,200}askCreditOverride\(confirm, toast, eb\)/);
  assert.match(box.slice(0, 1500), /creditOverride: \{ reason \}/);
  assert.match(sales, /ready-planning\?fresh=1/);
  const rp = routes.slice(routes.indexOf('app.get("/ready-planning"'));
  assert.match(rp.slice(0, 400), /c\.req\.query\("fresh"\) === "1"/);
  assert.match(routes, /staleWhileRevalidate: !fresh/);
  assert.match(routes, /const db = fresh \? freshReads\(c\.var\.DB\) : c\.var\.DB;/);
});
