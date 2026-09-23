// service-exchange-approval.test.mjs — a 1-to-1 exchange (STOCK_SWAP / REPRODUCE
// replacement unit) cannot proceed until the case's EXCHANGE approval is
// APPROVED; a missing request is auto-filed; REPAIR is never gated. Plus the
// overdue-age rule the Service dashboard tab uses.
import test from "node:test";
import assert from "node:assert/strict";
import {
  exchangeGateVerdict, gateExchange, isExchangeMode, _resetApprovalColumnsForTests,
} from "../src/api/lib/service-approval.ts";
import { caseAging, SERVICE_OVERDUE_DAYS } from "../src/api/lib/dashboard-service-slice.ts";

// Minimal fake context + DB: records SQL, answers the gate's SELECT.
function fakeCtx(row) {
  const sql = [];
  const stmt = (q) => ({
    bind: () => stmt(q),
    run: async () => { sql.push(q); },
    first: async () => row,
    all: async () => ({ results: [] }),
  });
  const DB = { prepare: (q) => stmt(q) };
  return { c: { var: { DB }, get: () => "u1", req: { header: () => null } }, sql };
}

test("verdicts", () => {
  assert.equal(exchangeGateVerdict(null), "needs-request");
  assert.equal(exchangeGateVerdict({ approval_kind: "GENERAL", approval_status: "APPROVED" }), "needs-request");
  assert.equal(exchangeGateVerdict({ approval_kind: "EXCHANGE", approval_status: "PENDING" }), "pending");
  assert.equal(exchangeGateVerdict({ approval_kind: "EXCHANGE", approval_status: "REJECTED" }), "rejected");
  assert.equal(exchangeGateVerdict({ approval_kind: "EXCHANGE", approval_status: "APPROVED" }), "allow");
});

test("only replacement modes are exchanges", () => {
  assert.ok(isExchangeMode("STOCK_SWAP") && isExchangeMode("REPRODUCE"));
  assert.ok(!isExchangeMode("REPAIR") && !isExchangeMode(null));
});

test("gate: REPAIR passes untouched; approved passes; missing files a PENDING request; pending/rejected block", async () => {
  _resetApprovalColumnsForTests();
  let f = fakeCtx(null);
  assert.equal(await gateExchange(f.c, "case1", "REPAIR"), null);
  assert.equal(f.sql.length, 0, "REPAIR must not touch the DB");

  f = fakeCtx({ approval_kind: "EXCHANGE", approval_status: "APPROVED" });
  assert.equal(await gateExchange(f.c, "case1", "STOCK_SWAP"), null);

  f = fakeCtx({ approval_kind: null, approval_status: null });
  const blocked = await gateExchange(f.c, "case1", "REPRODUCE");
  assert.equal(blocked?.status, 409);
  assert.ok(f.sql.some((q) => /UPDATE service_cases[\s\S]*approval_status = 'PENDING'/.test(q)), "files a PENDING request");

  f = fakeCtx({ approval_kind: "EXCHANGE", approval_status: "PENDING" });
  assert.equal((await gateExchange(f.c, "case1", "STOCK_SWAP"))?.status, 409);
  assert.ok(!f.sql.some((q) => /^\s*UPDATE service_cases/.test(q)), "pending is not re-filed");

  f = fakeCtx({ approval_kind: "EXCHANGE", approval_status: "REJECTED" });
  assert.match((await gateExchange(f.c, "case1", "STOCK_SWAP")).error, /rejected/);
});

test("overdue: only OPEN/IN_PROGRESS, strictly more than the threshold", () => {
  const now = new Date("2026-09-21T12:00:00Z");
  const ago = (d) => new Date(now.getTime() - d * 86400000).toISOString();
  assert.equal(SERVICE_OVERDUE_DAYS, 3);
  assert.equal(caseAging("OPEN", ago(3), now).daysOverdue, 0);
  assert.deepEqual(caseAging("IN_PROGRESS", ago(5), now), { ageDays: 5, daysOverdue: 2 });
  assert.equal(caseAging("CLOSED", ago(30), now).daysOverdue, 0);
  assert.equal(caseAging("CANCELLED", ago(30), now).ageDays, null);
});
