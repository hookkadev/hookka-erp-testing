// ---------------------------------------------------------------------------
// worker-penalties.test.mjs — DEV-22 Worker Penalty (built 2026-10-01).
//
// Asserts what the money does, not that functions exist:
//
//   1. Payroll month: an approval lands in its own month, or the first month
//      after it whose payroll is not yet approved (Dec rolls into Jan).
//      Malaysia's date decides the month, not UTC.
//   2. The deduction: a penalty comes off net pay AFTER statutory, alongside an
//      advance, and is NOT clamped at zero.
//   3. Drift: approving a payroll month is refused while a stored payslip
//      disagrees with the penalties approved for it; a worker with no payslip
//      is not a disagreement.
//   4. Posting: approving a month posts each line against its worker's payslip,
//      rolls a line whose worker has no payslip to the next month, and only
//      marks the penalty POSTED once every line is posted. Back to DRAFT
//      un-posts.
//   5. Rights: `worker-penalties` is a resource; HR and Office hold it.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles the .ts import on newer Node.
}
register("./tests/_alias-loader.mjs", pathToFileURL("./"));

const src = (p) => pathToFileURL(resolve(process.cwd(), p)).href;
const lib = await import(src("src/api/lib/worker-penalties.ts"));

// ---- 1. payroll month ------------------------------------------------------
test("approval lands in its own month when that payroll is open", () => {
  assert.equal(lib.payrollPeriodForApproval("2026-10-15", new Set()), "2026-10");
});

test("approval rolls past every already-approved month, across the year end", () => {
  const locked = new Set(["2026-11", "2026-12"]);
  assert.equal(lib.payrollPeriodForApproval("2026-11-03", locked), "2027-01");
  assert.equal(lib.nextPeriod("2026-12"), "2027-01");
  assert.equal(lib.nextPeriod("2026-09"), "2026-10");
});

test("the approval month is Malaysia's date, not UTC's", () => {
  // 17:30 UTC on 30 Sep is 01:30 on 1 Oct in Kuala Lumpur.
  assert.equal(lib.todayYmdMalaysia(new Date("2026-09-30T17:30:00Z")), "2026-10-01");
  assert.equal(lib.todayYmdMalaysia(new Date("2026-09-30T15:59:00Z")), "2026-09-30");
});

test("the raiser cannot approve their own penalty, unless they are a Super Admin", () => {
  assert.equal(lib.selfApprovalBlocked("u1", "u1", "HR"), true);
  assert.equal(lib.selfApprovalBlocked("u1", "u1", "OFFICE"), true);
  assert.equal(lib.selfApprovalBlocked("u1", "u1", "ADMIN"), true);
  assert.equal(lib.selfApprovalBlocked("u1", "u1", "SUPER_ADMIN"), false);
  assert.equal(lib.selfApprovalBlocked("u1", "u1", "super_admin"), false);
  assert.equal(lib.selfApprovalBlocked("u2", "u1", "HR"), false, "a second person is always fine");
});

// ---- 2. the deduction ------------------------------------------------------
test("a penalty comes off after statutory, with the advance, and is not clamped", () => {
  // gross 2,000.00, statutory 250.00, advance 300.00, penalty 150.00
  assert.equal(lib.netPayAfterAdvanceAndPenaltySen(200000, 25000, 30000, 15000), 130000);
  // more taken than earned: a debt, shown as a negative, never written off
  assert.equal(lib.netPayAfterAdvanceAndPenaltySen(50000, 5000, 0, 60000), -15000);
});

test("penalty lines sum per worker, in integer sen, even when a driver hands back text", () => {
  const lines = [
    lib.rowToPenaltyLine({ id: "l1", worker_id: "w1", amount_sen: "5000" }),
    lib.rowToPenaltyLine({ id: "l2", workerId: "w1", amountSen: 2550 }),
    lib.rowToPenaltyLine({ id: "l3", worker_id: "w2", amount_sen: 10000 }),
  ];
  const m = lib.sumPenaltySenByWorker(lines);
  assert.equal(m.get("w1"), 7550);
  assert.equal(m.get("w2"), 10000);
  const rec = lib.rowToPenalty({ id: "p1", penalty_no: "WP-2610-001", status: "APPROVED" }, lines);
  assert.equal(rec.totalSen, 17550);
  assert.equal(rec.penaltyNo, "WP-2610-001");
});

// ---- 3. drift --------------------------------------------------------------
test("a payslip that does not carry the approved penalty is drift; a worker with no slip is not", () => {
  const expected = new Map([["w1", 5000], ["w2", 3000], ["w9", 1000]]);
  const slips = [
    { employeeId: "w1", employeeName: "Ali", penaltyDeductionSen: 5000 },
    { employeeId: "w2", employeeName: "Bala", penaltyDeductionSen: 0 },
    { employeeId: "w3", employeeName: "Chong", penaltyDeductionSen: 2000 },
  ];
  const drift = lib.computePenaltyDrift(expected, slips);
  assert.deepEqual(
    drift.map((d) => [d.workerId, d.expectedSen, d.onPayslipSen]),
    [["w2", 3000, 0], ["w3", 0, 2000]],
  );
});

// ---- 4. posting ------------------------------------------------------------
// A small in-memory stand-in for the four statements postPenaltiesForPeriod
// issues. Anything else throws, so a new statement shows up as a failure.
function makeDb({ headers, lines, payslips }) {
  const H = new Map(headers.map((h) => [h.id, { ...h }]));
  const L = new Map(lines.map((l) => [l.id, { posted_at: null, payslip_id: null, ...l }]));
  const stmt = (sql, args) => ({
    async all() {
      if (/FROM worker_penalty_lines l\s+JOIN worker_penalties p/.test(sql)) {
        const [period] = args;
        return {
          results: [...L.values()].filter(
            (l) => l.payroll_period === period && ["APPROVED", "POSTED"].includes(H.get(l.penalty_id)?.status),
          ),
        };
      }
      if (/SELECT id, employeeId FROM payslips WHERE period = \?/.test(sql)) {
        return { results: payslips.filter((p) => p.period === args[0]) };
      }
      if (/COUNT\(\*\) AS total, COUNT\(posted_at\) AS posted/.test(sql)) {
        const mine = [...L.values()].filter((l) => l.penalty_id === args[0]);
        return { results: [{ total: mine.length, posted: mine.filter((l) => l.posted_at).length }] };
      }
      throw new Error(`unexpected all(): ${sql}`);
    },
    async first() {
      if (/COUNT\(\*\) AS total, COUNT\(posted_at\) AS posted/.test(sql)) {
        const mine = [...L.values()].filter((l) => l.penalty_id === args[0]);
        return { total: mine.length, posted: mine.filter((l) => l.posted_at).length };
      }
      throw new Error(`unexpected first(): ${sql}`);
    },
    async run() {
      if (/SET payslip_id = \?, posted_at = now\(\) WHERE id = \?/.test(sql)) {
        const l = L.get(args[1]);
        l.payslip_id = args[0];
        l.posted_at = "now";
      } else if (/SET payroll_period = \?, payslip_id = NULL, posted_at = NULL WHERE id = \?/.test(sql)) {
        const l = L.get(args[1]);
        l.payroll_period = args[0];
        l.payslip_id = null;
        l.posted_at = null;
      } else if (/SET posted_at = NULL WHERE id = \?/.test(sql)) {
        L.get(args[0]).posted_at = null;
      } else if (/UPDATE worker_penalties SET status = \?/.test(sql)) {
        const h = H.get(args[1]);
        if (["APPROVED", "POSTED"].includes(h.status) && h.status !== args[2]) h.status = args[0];
      } else {
        throw new Error(`unexpected run(): ${sql}`);
      }
      return {};
    },
  });
  return {
    H,
    L,
    prepare(sql) {
      return { bind: (...args) => stmt(sql, args), ...stmt(sql, []) };
    },
  };
}

test("approving a month posts lines with a payslip, rolls the rest, and POSTED waits for every line", async () => {
  const db = makeDb({
    headers: [
      { id: "p1", status: "APPROVED" }, // two workers, both paid in Oct
      { id: "p2", status: "APPROVED" }, // one paid, one resigned (no Oct slip)
      { id: "p3", status: "PENDING_APPROVAL" }, // not approved: untouched
    ],
    lines: [
      { id: "a", penalty_id: "p1", worker_id: "w1", amount_sen: 5000, payroll_period: "2026-10" },
      { id: "b", penalty_id: "p1", worker_id: "w2", amount_sen: 5000, payroll_period: "2026-10" },
      { id: "c", penalty_id: "p2", worker_id: "w1", amount_sen: 2000, payroll_period: "2026-10" },
      { id: "d", penalty_id: "p2", worker_id: "w9", amount_sen: 2000, payroll_period: "2026-10" },
      { id: "e", penalty_id: "p3", worker_id: "w1", amount_sen: 9900, payroll_period: "2026-10" },
    ],
    payslips: [
      { id: "PS-2610-001", employeeId: "w1", period: "2026-10" },
      { id: "PS-2610-002", employeeId: "w2", period: "2026-10" },
    ],
  });
  const r = await lib.postPenaltiesForPeriod(db, "2026-10", true);
  assert.deepEqual(r, { posted: 3, rolled: 1 });
  assert.equal(db.L.get("a").payslip_id, "PS-2610-001");
  assert.equal(db.L.get("b").payslip_id, "PS-2610-002");
  assert.equal(db.L.get("d").payroll_period, "2026-11", "no Oct slip for w9 -> next month");
  assert.equal(db.L.get("d").posted_at, null);
  assert.equal(db.L.get("e").posted_at, null, "a pending penalty is never posted");
  assert.equal(db.H.get("p1").status, "POSTED");
  assert.equal(db.H.get("p2").status, "APPROVED", "one line still waiting -> not POSTED");
  assert.equal(db.H.get("p3").status, "PENDING_APPROVAL");

  // Month back to DRAFT: un-posted, header back to APPROVED. The rolled line stays rolled.
  await lib.postPenaltiesForPeriod(db, "2026-10", false);
  assert.equal(db.L.get("a").posted_at, null);
  assert.equal(db.H.get("p1").status, "APPROVED");
  assert.equal(db.L.get("d").payroll_period, "2026-11");
});

test("a month with no penalties posts nothing and touches nothing", async () => {
  const db = makeDb({ headers: [], lines: [], payslips: [] });
  assert.deepEqual(await lib.postPenaltiesForPeriod(db, "2026-10", true), { posted: 0, rolled: 0 });
  assert.deepEqual(await lib.postPenaltiesForPeriod(db, "bad", true), { posted: 0, rolled: 0 });
});

// ---- 4b. fresh reads ---------------------------------------------------------
test("payroll reads go through batch (uncached by Hyperdrive) when the DB has it", async () => {
  const calls = [];
  const stmt = {
    async all() { calls.push("all"); return { results: [{ period: "2026-09" }] }; },
    async first() { return null; },
    async run() { return {}; },
  };
  const withBatch = {
    prepare: () => ({ ...stmt, bind: () => stmt }),
    async batch(stmts) { calls.push(`batch:${stmts.length}`); return [{ results: [{ period: "2026-10" }] }]; },
  };
  const locked = await lib.loadLockedPayrollPeriods(withBatch);
  assert.deepEqual([...locked], ["2026-10"], "the batch (fresh) result is used");
  assert.deepEqual(calls, ["batch:1"], "no plain cached read was issued");

  const noBatch = { prepare: () => ({ ...stmt, bind: () => stmt }) };
  calls.length = 0;
  assert.deepEqual([...(await lib.loadLockedPayrollPeriods(noBatch))], ["2026-09"]);
  assert.deepEqual(calls, ["all"], "a stub without batch falls back to a plain read");
});

// ---- 5. rights -------------------------------------------------------------
// On `main` there is no per-account Permissions tab (that lives on staging),
// so there is no catalog to check; the role policy is the whole grant.
test("worker-penalties is a resource; HR and Office hold it (approve included via *)", async () => {
  const { ALL_RESOURCES, permissionsForRole } = await import(src("src/api/lib/role-policy.ts"));
  assert.ok(ALL_RESOURCES.includes("worker-penalties"));
  assert.ok(permissionsForRole("HR").has("worker-penalties:*"));
  assert.ok(permissionsForRole("OFFICE").has("worker-penalties:*"));
  assert.ok(!permissionsForRole("SALES").has("worker-penalties:*"));
});
