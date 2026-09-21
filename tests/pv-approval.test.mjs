// ---------------------------------------------------------------------------
// pv-approval.test.mjs — the payment-voucher four-tier ladder
// (owner 2026-09-22, adopted from the Houzs trading ERP).
//
//   Draft → Prepared → Checked → Approved
//
// The rules this pins, house source-scan style (a deleted guard fails loudly):
//   · a voucher saved as DRAFT writes NO ledger legs at birth;
//   · the GL posting happens exactly once, at APPROVE, through the SAME
//     builder the legacy immediate path uses (pvPostingStatements) — the two
//     roads can never post differently;
//   · the formal number is minted at CHECK (drafts carry DRAFT-*, so a
//     torn-up draft never burns a number);
//   · reject requires a reason;
//   · void/delete of an unposted voucher never touches applyLifecycle (there
//     are no legs to reverse) and restate refuses unposted vouchers;
//   · legacy rows are backfilled APPROVED, so every pre-tier voucher keeps
//     behaving exactly as before.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const src = readFileSync("src/api/routes/accounting.ts", "utf8");

function handler(route) {
  const start = src.indexOf(route);
  assert.notEqual(start, -1, `route ${route} not found`);
  const end = src.indexOf("\napp.", start + 1);
  return src.slice(start, end === -1 ? undefined : end);
}

test("draft create writes no posting; immediate path still posts at birth", () => {
  const body = handler('app.post("/payment-vouchers", async (c) => {');
  assert.match(body, /const asDraft = body\.saveAs === "draft";/);
  // The posting statements are added ONLY on the non-draft branch.
  assert.match(body, /if \(!asDraft\) \{\s*\n\s*statements\.push\(\.\.\.await pvPostingStatements\(/);
  // A draft's number is a placeholder, not an issued document number.
  assert.match(body, /\$\{PV_DRAFT_PREFIX\}/);
});

test("the ledger legs have exactly ONE builder, used by create and approve", () => {
  const calls = src.match(/await pvPostingStatements\(/g) ?? [];
  assert.equal(calls.length, 2, `expected exactly 2 pvPostingStatements call sites (create + approve), saw ${calls.length}`);
});

test("approve is the posting moment and only from CHECKED", () => {
  const start = src.indexOf("async function pvApprovalCore(");
  assert.notEqual(start, -1, "pvApprovalCore not found");
  const body = src.slice(start, src.indexOf("\napp.", start));
  assert.match(body, /if \(state !== "CHECKED"\) return fail\(`Only a checked voucher can be approved/);
  assert.match(body, /approval_state = 'APPROVED', status = 'POSTED'/);
});

test("check mints the formal number from the draft placeholder", () => {
  const start = src.indexOf("async function pvApprovalCore(");
  const body = src.slice(start, src.indexOf("\napp.", start));
  assert.match(body, /if \(formalNo\.startsWith\(PV_DRAFT_PREFIX\)\) \{/);
  assert.match(body, /formalNo = await issueDocNumber\(/);
});

test("reject requires a reason; check and approve carry their own permission keys", () => {
  const start = src.indexOf("async function pvApprovalCore(");
  const body = src.slice(start, src.indexOf("\napp.", start));
  assert.match(body, /if \(!reason\.trim\(\)\) return fail\("A reject needs a reason"\);/);
  assert.match(src, /reject: "check", check: "check", approve: "approve"/);
});

test("lifecycle: an unposted voucher is a plain status flip, never applyLifecycle", () => {
  const body = handler('app.post("/payment-vouchers/:id/lifecycle", async (c) => {');
  const unposted = body.indexOf('if (pvApState !== "APPROVED") {');
  const lifecycle = body.indexOf("applyLifecycle(");
  assert.notEqual(unposted, -1, "unposted branch missing");
  assert.ok(unposted < lifecycle, "unposted branch must return before applyLifecycle");
});

test("restate refuses a voucher that has not posted", () => {
  const body = handler('app.post("/payment-vouchers/:id/restate", async (c) => {');
  assert.match(body, /Not posted yet — edit the draft directly/);
});

test("legacy vouchers are backfilled APPROVED", () => {
  assert.match(src, /UPDATE payment_vouchers SET approval_state = 'APPROVED' WHERE approval_state IS NULL/);
});

test("draft edit is allowed only before CHECK", () => {
  const body = handler('app.put("/payment-vouchers/:id", async (c) => {');
  assert.match(body, /if \(state !== "DRAFT" && state !== "PREPARED"\)/);
  assert.match(body, /Checked vouchers are locked/);
});

// Found on prod 2026-09-22: migration 0159's `status CHECK (status IN
// ('POSTED','VOID'))` refused the draft road's status 'DRAFT' — every
// "Save as draft" 400'd with the generic "is migration 0159 applied?" text.
// Same class as BUG-2026-09-18-001 (PCN void 'CANCELLED'). The self-apply
// must widen the constraint, and the create path must surface the DB's own
// error instead of a canned guess.
test("self-apply widens the status CHECK to admit DRAFT", () => {
  const start = src.indexOf("function ensurePvApprovalCols(");
  const body = src.slice(start, src.indexOf("\nconst PV_DRAFT_PREFIX", start));
  assert.match(body, /DROP CONSTRAINT IF EXISTS payment_vouchers_status_check/);
  assert.match(body, /CHECK \(status IN \('POSTED','VOID','DRAFT'\)\)/);
});

test("PV create surfaces the database's own failure text", () => {
  const body = handler('app.post("/payment-vouchers", async (c) => {');
  assert.match(body, /Failed to save the payment: \$\{cause\.slice\(0, 300\)\}/);
  assert.doesNotMatch(body, /is migration 0159 applied\?/);
});
