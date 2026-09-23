// ---------------------------------------------------------------------------
// pv-ap-payment.test.mjs — Payment Vouchers "AP Payment" (owner 2026-09-22,
// Houzs adoption: 「ap payment 和 payment voucher 一起」).
//
// A voucher of kind AP pays a creditor's bills and walks the same four-tier
// ladder as an expense voucher. The rules this pins, source-scan style:
//   · the settlement is posted by the SAME builders the payment pages use
//     (buildSupplierPaymentCreate / buildOtherPartyPaymentCreate) — exactly
//     two call sites each: the page route + the voucher road;
//   · an AP voucher never goes through pvPostingStatements (it owns no legs);
//   · the settlement document is born under the voucher's own number
//     (paymentNo: pv.pvNo) — aging / bank reco / GL see an ordinary payment;
//   · a draft's ticks count as "reserved" for other vouchers (a bill can't be
//     promised twice on the ladder), and the voucher being edited is excluded;
//   · foreign-currency invoices are refused (payment-day rate lives on the
//     Supplier Payment page); an advance is supplier-only;
//   · void/delete/unvoid of a posted AP voucher IS the settlement document's
//     lifecycle (one core, two doors); restate refuses a posted AP voucher;
//   · the Supplier Payment POST route still mints the number itself and
//     batches what the shared builder returns (behaviour-preserving refactor).
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

// CRLF-normalised so the block slicers below can key on "\n}\n".
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const acc = read("src/api/routes/accounting.ts");
const sp = read("src/api/routes/supplier-payments.ts");
const ui = read("src/pages/accounting/index.tsx");

function handler(src, route) {
  const start = src.indexOf(route);
  assert.notEqual(start, -1, `route ${route} not found`);
  const end = src.indexOf("\napp.", start + 1);
  return src.slice(start, end === -1 ? undefined : end);
}
function fn(src, name) {
  const start = src.indexOf(name);
  assert.notEqual(start, -1, `${name} not found`);
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end === -1 ? undefined : end + 3);
}

test("the supplier payment has ONE builder, used by the page route and the voucher road", () => {
  assert.match(sp, /export async function buildSupplierPaymentCreate\(/);
  const route = handler(sp, 'app.post("/", async (c) => {');
  assert.match(route, /const payNo = await issueDocNumber\(/, "the route still mints its own number");
  assert.match(route, /await buildSupplierPaymentCreate\(c\.var\.DB, \{/);
  assert.match(route, /await c\.var\.DB\.batch\(statements\);/);
  // Legs, rows and PI bumps moved INTO the builder — the normal branch of the
  // route (after the TF-repayment branch, which keeps its own rows) has none.
  const normal = route.slice(route.indexOf("// 2. Issue the payment voucher number"), route.indexOf("// 7. Execute the whole batch"));
  assert.ok(normal.length > 0);
  assert.doesNotMatch(normal, /INSERT INTO supplier_payments/);
  assert.doesNotMatch(normal, /UPDATE purchase_invoices/);
  const b = fn(sp, "export async function buildSupplierPaymentCreate(");
  assert.match(b, /INSERT INTO supplier_payments/);
  assert.match(b, /UPDATE purchase_invoices/);
  assert.match(b, /accountCode: AP_CONTROL,/);
  assert.match(b, /bumpSupplierPaymentsRev\(db\)/);
  const calls = (sp.match(/await buildSupplierPaymentCreate\(/g) ?? []).length + (acc.match(/await buildSupplierPaymentCreate\(/g) ?? []).length;
  assert.equal(calls, 2, `expected exactly 2 buildSupplierPaymentCreate call sites (route + voucher), saw ${calls}`);
  assert.match(sp, /export \{ buildSupplierPaymentLifecycle \};/);
});

test("the other-party payment has ONE builder, used by the page route and the voucher road", () => {
  const route = handler(acc, 'app.post("/other-party-payments", async (c) => {');
  assert.match(route, /await validateOtherPartyPaymentAllocs\(/);
  assert.match(route, /await buildOtherPartyPaymentCreate\(c\.var\.DB, \{/);
  assert.doesNotMatch(route, /INSERT INTO other_party_payments/);
  const b = fn(acc, "async function buildOtherPartyPaymentCreate(");
  assert.match(b, /INSERT INTO other_party_payments/);
  assert.match(b, /UPDATE other_party_bills/);
  assert.match(b, /buildPaymentLegs\(/);
  const calls = (acc.match(/await buildOtherPartyPaymentCreate\(/g) ?? []).length;
  assert.equal(calls, 2, `expected exactly 2 buildOtherPartyPaymentCreate call sites, saw ${calls}`);
});

test("an AP voucher posts through the settlement builders, never through pvPostingStatements", () => {
  const s = fn(acc, "async function pvApSettlementStatements(");
  assert.match(s, /buildSupplierPaymentCreate\(db, \{/);
  assert.match(s, /paymentNo: pv\.pvNo,/, "supplier settlement is born under the voucher's number");
  assert.match(s, /buildOtherPartyPaymentCreate\(db, \{/);
  assert.match(s, /allocs: allocsIn, paymentNo: pv\.pvNo,/, "other-party settlement is born under the voucher's number");
  assert.doesNotMatch(s, /pvPostingStatements/);
  assert.match(s, /lenderSupplierId === pv\.partyId/, "a trade-finance lender is refused (repayments stay on the Supplier Payment page)");
  // The approve rung branches on kind BEFORE the expense posting.
  const core = acc.slice(acc.indexOf("async function pvApprovalCore("), acc.indexOf("\napp.", acc.indexOf("async function pvApprovalCore(")));
  const apBranch = core.indexOf('=== PV_KIND_AP) {');
  const expensePost = core.indexOf("await pvPostingStatements(");
  assert.ok(apBranch !== -1 && apBranch < expensePost, "AP branch must come before the expense posting in approve");
  assert.match(core, /approval_state = 'APPROVED', status = 'POSTED', totalSen = \?, approved_at = \?, approved_by = \?, reject_reason = NULL, updated_at = \? WHERE id = \?",\s*\)\.bind\(built\.totalSen/);
});

test("create: AP kind writes allocs (no lines); Post now adds the settlement in the same batch", () => {
  const body = handler(acc, 'app.post("/payment-vouchers", async (c) => {');
  const ap = body.slice(body.indexOf("if (body.kind === PV_KIND_AP) {"), body.indexOf("const v = validateDocLines(coa, body.lines);"));
  assert.ok(ap.length > 0, "AP branch missing");
  assert.match(ap, /await validatePvAp\(c\.var\.DB, orgId, coa, body as Record<string, unknown>, null\)/);
  assert.match(ap, /\.\.\.pvAllocStatements\(c\.var\.DB, id, ap\.v\.allocs\)/);
  assert.doesNotMatch(ap, /payment_voucher_lines/);
  assert.match(ap, /if \(!asDraft\) \{[\s\S]*?await pvApSettlementStatements\(/);
  assert.match(ap, /pv_kind, party_kind, party_id, advance_sen/);
});

test("validation: reservations, foreign refusal, supplier-only advance", () => {
  const v = fn(acc, "async function validatePvAp(");
  assert.match(v, /pvOpenBillsFor\(db, orgId, partyKind, partyId, exclude\)/, "the voucher being edited is excluded from reservations");
  assert.match(v, /if \(bill\.foreign\) return \{ ok: false/);
  assert.match(v, /amountSen > bill\.availableSen/);
  assert.match(v, /advanceSen > 0 && partyKind !== "SUPPLIER"/);
  const r = fn(acc, "async function pvReservedByDoc(");
  assert.match(r, /COALESCE\(v\.approval_state, 'APPROVED'\) <> 'APPROVED'/, "only UNPOSTED vouchers reserve");
  assert.match(r, /v\.status <> 'VOID'/);
  const o = fn(acc, "async function pvOpenBillsFor(");
  assert.match(o, /availableSen: Math\.max\(0, outstanding - \(rsv\?\.sen \?\? 0\)\)/);
  assert.match(o, /status IN \('CONFIRMED','APPROVED','PARTIAL_PAID'\)/);
  assert.match(o, /b\.status IN \('OPEN','PARTIAL_PAID'\) AND \(dl\.state IS NULL OR dl\.state = 'ACTIVE'\)/);
});

test("lifecycle of a posted AP voucher delegates to the settlement document's core; restate refuses", () => {
  const lc = handler(acc, 'app.post("/payment-vouchers/:id/lifecycle", async (c) => {');
  const unposted = lc.indexOf('if (pvApState !== "APPROVED") {');
  const ap = lc.indexOf("=== PV_KIND_AP) {");
  const legacy = lc.indexOf("applyLifecycle(");
  assert.ok(unposted !== -1 && ap !== -1 && legacy !== -1);
  assert.ok(unposted < ap && ap < legacy, "unposted flip → AP delegation → expense applyLifecycle, in that order");
  assert.match(lc, /await buildSupplierPaymentLifecycle\(c\.var\.DB, orgId, pv\.pvNo, action, actorUserId\)/);
  assert.match(lc, /await buildOtherPartyPaymentLifecycle\(c\.var\.DB, orgId, pv\.pvNo, action, actorUserId\)/);
  const rs = handler(acc, 'app.post("/payment-vouchers/:id/restate", async (c) => {');
  assert.match(rs, /A posted AP payment cannot be edited — cancel it and raise a new one\./);
  const put = handler(acc, 'app.put("/payment-vouchers/:id", async (c) => {');
  assert.match(put, /DELETE FROM payment_voucher_allocs WHERE voucher_id = \?/, "draft edit replaces the ticks");
});

test("list: AP kind reads its lifecycle from the settlement document and reports open advance", () => {
  const g = handler(acc, 'app.get("/payment-vouchers", async (c) => {');
  assert.match(g, /sdl\.sourceType IN \('supplier_payment', 'other_party_payment'\)/);
  assert.match(g, /AND payment_vouchers\.pv_kind = 'AP'/);
  assert.match(g, /purchase_invoice_id IS NULL AND COALESCE\(method, ''\) = 'BANK_TRANSFER'/);
  assert.match(g, /status: apVoided \? "VOID" : r\.status/);
});

test("self-apply covers the four columns and the allocs table (records 0235/0216)", () => {
  const e = fn(acc, "function ensurePvApColumns(");
  for (const col of ["pv_kind TEXT", "party_kind TEXT", "party_id TEXT", "advance_sen INTEGER"]) assert.match(e, new RegExp(col));
  assert.match(e, /CREATE TABLE IF NOT EXISTS payment_voucher_allocs/);
  assert.match(readFileSync("migrations-postgres/0235_pv_ap_payment.sql", "utf8"), /payment_voucher_allocs/);
  assert.match(readFileSync("migrations/0216_pv_ap_payment.sql", "utf8"), /payment_voucher_allocs/);
  const schema = JSON.parse(readFileSync("tests/db-schema.json", "utf8"));
  for (const col of ["pv_kind", "party_kind", "party_id", "advance_sen"]) assert.ok(schema.payment_vouchers.includes(col), `fixture lacks payment_vouchers.${col}`);
  assert.deepEqual(schema.payment_voucher_allocs, ["amount_sen", "doc_id", "doc_kind", "id", "line_order", "voucher_id"]);
});

test("UI: two doors (New AP Payment / New Payment Voucher) and the Houzs status chips", () => {
  assert.match(ui, /> New AP Payment\s*<\/Button>/);
  assert.match(ui, /> New Payment Voucher\s*<\/Button>/);
  for (const k of ['"DRAFT"', '"PREPARED"', '"CHECKED"', '"APPROVED"', '"ADVANCE_OPEN"', '"CANCELLED"']) {
    assert.match(ui, new RegExp(`\\{ key: ${k}, label:`), `chip ${k} missing`);
  }
  // Foreign invoices cannot be ticked; a posted AP voucher has no in-place edit.
  assert.match(ui, /disabled=\{b\.foreign \|\| b\.availableSen <= 0\}/);
  assert.match(ui, /\{isPosted\(r\) && r\.pvKind !== "AP" && \(/);
  // The AP form posts kind: "AP" with allocations, never expense lines.
  const apStart = ui.indexOf("const handleSaveAp = async");
  const save = ui.slice(apStart, ui.indexOf("const handleSave = async", apStart));
  assert.match(save, /kind: "AP",/);
  assert.match(save, /allocations: apTicked\.map/);
  assert.doesNotMatch(save, /lines:/);
});
