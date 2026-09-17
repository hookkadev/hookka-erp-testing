// ---------------------------------------------------------------------------
// leadership-allowance.test.mjs — the leadership allowance gate
// (src/api/lib/leadership-allowance.ts, migration 0233, DEV-06), plus
// structural guards pinning the payroll wire sites so a refactor can't
// silently drop the bonus or reintroduce a threshold gate.
//
// Unlike Efficiency Allowance, Leadership Allowance has NO threshold — owner
// decision (2026-09): "不设门槛,只按出勤比例" (no gate, attendance ratio
// only). A configured flat amount always pays, pro-rated by attendance.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on Node 22+.
}

const lead = await import(
  pathToFileURL(
    resolve(process.cwd(), "src/api/lib/leadership-allowance.ts"),
  ).href
);

// ── resolveLeadershipAllowanceSen ────────────────────────────────────────────

test("pays the full configured amount when no attendance is passed (live estimate)", () => {
  assert.equal(lead.resolveLeadershipAllowanceSen(15000), 15000);
  assert.equal(lead.resolveLeadershipAllowanceSen(15000, undefined), 15000);
});

test("pays nothing when unconfigured (0, null, undefined, or negative)", () => {
  assert.equal(lead.resolveLeadershipAllowanceSen(0), 0);
  assert.equal(lead.resolveLeadershipAllowanceSen(null), 0);
  assert.equal(lead.resolveLeadershipAllowanceSen(undefined), 0);
  assert.equal(lead.resolveLeadershipAllowanceSen(-500), 0);
});

test("full attendance (no absences) pays the full amount", () => {
  assert.equal(
    lead.resolveLeadershipAllowanceSen(15000, { workingDays: 26, absentDays: 0 }),
    15000,
  );
});

test("pro-rates by worked / workingDays — same formula as efficiency allowance", () => {
  // 26 working days, 2 absent → 24/26 of RM150 (15000 sen)
  const got = lead.resolveLeadershipAllowanceSen(15000, {
    workingDays: 26,
    absentDays: 2,
  });
  assert.equal(got, Math.round((15000 * 24) / 26));
});

test("NO threshold gate — pays even at very low attendance, just scaled down", () => {
  // 26 working days, 25 absent → 1/26 of the amount, but still > 0.
  const got = lead.resolveLeadershipAllowanceSen(26000, {
    workingDays: 26,
    absentDays: 25,
  });
  assert.equal(got, Math.round((26000 * 1) / 26));
  assert.ok(got > 0, "leadership allowance has no eligibility gate, unlike efficiency allowance");
});

test("fully absent the whole month pays 0 via proration, not a threshold rejection", () => {
  assert.equal(
    lead.resolveLeadershipAllowanceSen(15000, { workingDays: 26, absentDays: 26 }),
    0,
  );
});

test("zero or negative workingDays falls back to the full amount (can't divide by zero)", () => {
  assert.equal(
    lead.resolveLeadershipAllowanceSen(15000, { workingDays: 0, absentDays: 0 }),
    15000,
  );
});

test("negative absentDays / workingDays are clamped to 0 rather than inflating the payout", () => {
  const got = lead.resolveLeadershipAllowanceSen(15000, {
    workingDays: 26,
    absentDays: -5,
  });
  assert.equal(got, 15000); // clamps absentDays to 0 → worked = 26 → full amount
});

// ── Structural guards on the payroll wire sites ──────────────────────────────

const WORKERS = readFileSync(resolve(process.cwd(), "src/api/routes/workers.ts"), "utf8");
const WORKER = readFileSync(resolve(process.cwd(), "src/api/routes/worker.ts"), "utf8");
const PAYSLIPS = readFileSync(resolve(process.cwd(), "src/api/routes/payslips.ts"), "utf8");
const PROJECTION = readFileSync(resolve(process.cwd(), "src/api/lib/labour-projection.ts"), "utf8");

test("workers CRUD reads/writes leadershipAllowanceSen (create + update)", () => {
  assert.ok(
    WORKERS.includes("leadershipAllowanceSen"),
    "workers.ts must handle the leadershipAllowanceSen field",
  );
  const insertCount = (WORKERS.match(/leadershipAllowanceSen/g) || []).length;
  assert.ok(
    insertCount >= 4,
    `expected leadershipAllowanceSen wired through GET normalize + POST + PUT (create/validate/insert, update/validate/merge), found ${insertCount} references`,
  );
});

test("worker my-pay computes the bonus via the gate, folded into estimatedGrossSen", () => {
  assert.ok(
    WORKER.includes("resolveLeadershipAllowanceSen("),
    "my-pay must compute the leadership allowance via the gate",
  );
  assert.ok(
    WORKER.includes("estimatedGrossSen") &&
      /estimatedGrossSen:\s*[\s\S]{0,120}leadershipAllowanceSen/.test(WORKER),
    "estimatedGrossSen must include leadershipAllowanceSen",
  );
});

test("BOTH payslips paths (projected + stored) run leadership allowance through the gate", () => {
  const gateCalls = (PAYSLIPS.match(/resolveLeadershipAllowanceSen\(/g) || []).length;
  assert.ok(
    gateCalls >= 2,
    `expected the leadership allowance gate in both the projected and POST paths, found ${gateCalls}`,
  );
});

test("payslips loads leadershipAllowanceSen from the workers table", () => {
  const workerSelect = /SELECT [^"]*FROM workers WHERE \(status = 'ACTIVE'/.exec(PAYSLIPS)?.[0] ?? "";
  assert.ok(workerSelect, "the projected/generate worker SELECT should be findable");
  assert.ok(
    workerSelect.includes("leadershipAllowanceSen"),
    "the worker SELECT must pull leadershipAllowanceSen",
  );
});

test("labour-projection (P&L dry run) includes leadership allowance in the cost projection", () => {
  assert.ok(
    PROJECTION.includes("resolveLeadershipAllowanceSen("),
    "projectedLabourByDept must run the leadership allowance through the gate",
  );
  assert.ok(
    PROJECTION.includes("leadershipAllowanceSen"),
    "the projection's worker SELECT must pull leadershipAllowanceSen",
  );
});
