// ---------------------------------------------------------------------------
// sequence-unlock-reasons — a reason is required and validated on the server,
// and it classifies into the code the weekly review groups by (PRD T-013
// R9, R11, R12).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  UNLOCK_REASONS,
  UNLOCK_REASON_OPTIONS,
  OTHER_PREFIX,
  classifyUnlockReason,
  validateUnlockReason,
  isRecordingGap,
} from "../src/api/lib/sequence-unlock-reasons.ts";

test("an empty unlock is refused", () => {
  for (const bad of [undefined, null, "", "   ", 42, {}, "ok"]) {
    const r = validateUnlockReason(bad);
    assert.equal(r.ok, false, `accepted ${JSON.stringify(bad)}`);
  }
});

test("the bare word Other is refused; Other with text is accepted as OTHER", () => {
  assert.equal(validateUnlockReason("Other").ok, false);
  assert.equal(validateUnlockReason(`${OTHER_PREFIX}`).ok, false);
  assert.equal(validateUnlockReason(`${OTHER_PREFIX}  `).ok, false);
  const r = validateUnlockReason(`${OTHER_PREFIX}foam bonding machine was down`);
  assert.equal(r.ok, true);
  assert.equal(r.code, "OTHER");
});

test("every picker label classifies to its own code", () => {
  for (const o of UNLOCK_REASON_OPTIONS) {
    if (o.code === "OTHER") continue;
    const r = validateUnlockReason(o.label);
    assert.equal(r.ok, true, o.label);
    assert.equal(r.code, o.code);
    assert.equal(classifyUnlockReason(o.label), o.code);
  }
  assert.deepEqual(UNLOCK_REASONS, UNLOCK_REASON_OPTIONS.map((o) => o.label));
});

test("only the recording gap is a recording gap", () => {
  assert.equal(isRecordingGap("RECORDING_GAP"), true);
  for (const c of ["REAL_SKIP", "NOT_APPLICABLE", "OTHER", "SHEETS_SYNC"]) {
    assert.equal(isRecordingGap(c), false, c);
  }
});

test("whitespace is normalised and the length is bounded", () => {
  const r = validateUnlockReason("  Earlier   step was finished but not recorded  ");
  assert.equal(r.ok, true);
  assert.equal(r.reason, "Earlier step was finished but not recorded");
  assert.equal(r.code, "RECORDING_GAP");
  assert.equal(validateUnlockReason("x".repeat(301)).ok, false);
});

test("the server validates INSIDE the gate, before any audit row is written", () => {
  const helpers = readFileSync("src/api/routes/production-orders/_helpers.ts", "utf8");
  const gate = helpers.slice(
    helpers.indexOf("export async function gateJobCardSequence("),
    helpers.indexOf("export function sequenceGuardIdsFor("),
  );
  const check = gate.indexOf("validateUnlockReason(unlock?.reason)");
  const record = gate.indexOf("recordSequenceUnlock(db, {");
  assert.ok(check > 0 && record > check, "validation precedes the audit write");
  assert.match(gate, /code: "UNLOCK_REASON_REQUIRED"/);
});

test("who may unlock is decided in ONE place on the server, not three hardcoded trues", () => {
  const helpers = readFileSync("src/api/routes/production-orders/_helpers.ts", "utf8");
  const po = readFileSync("src/api/routes/production-orders.ts", "utf8");
  const code = (src) => src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal((code(helpers).match(/canSelfUnlock: true/g) ?? []).length, 0);
  assert.equal((code(po).match(/canSelfUnlock: true/g) ?? []).length, 0);
  assert.equal((helpers.match(/export function canSequenceUnlock\(/g) ?? []).length, 1);
  assert.match(helpers, /canSelfUnlock: canUnlock,/);
});

test("the shop-floor unlock names the worker, never 'unknown'", () => {
  const po = readFileSync("src/api/routes/production-orders.ts", "utf8");
  // Every scan path hands the resolved worker to the actor resolver.
  assert.equal((po.match(/resolveSequenceActor\(db, c, worker\)/g) ?? []).length, 2);
  const helpers = readFileSync("src/api/routes/production-orders/_helpers.ts", "utf8");
  const resolver = helpers.slice(
    helpers.indexOf("export async function resolveSequenceActor("),
    helpers.indexOf("export function canSequenceUnlock("),
  );
  assert.match(resolver, /kind: "WORKER", id: worker\.id, name: worker\.name/);
  assert.match(resolver, /SELECT displayName, email FROM users WHERE id = \?/);
});

test("the phone offers the same reasons as the desktop", () => {
  const phone = readFileSync("src/pages/worker/scan.tsx", "utf8");
  const dialog = readFileSync("src/components/sequence-unlock-dialog.tsx", "utf8");
  for (const src of [phone, dialog]) {
    assert.match(src, /UNLOCK_REASONS\.map\(\(r\) => \(/);
    assert.match(src, /OTHER_PREFIX/);
  }
  assert.equal(/"Released on the shop floor"/.test(phone), false, "the fixed reason string is gone");
});
