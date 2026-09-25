// ---------------------------------------------------------------------------
// sequence-lock-side-doors — every way a job card's status can be written is
// either gated, admin-only, or provably not a completion (PRD T-013 R4/R5).
//
// The lock was measured correct and then found to refuse nothing, because the
// paths it did not cover were never counted: the Google Sheets webhook and the
// data-repair endpoints could complete any card in any order, and the test
// that claimed "all four paths are gated" read two files and could not see
// them. This test does not read two files. It walks src/api, finds EVERY
// `UPDATE job_cards ... SET ... status = ...`, and requires each file to be in
// exactly one of three lists — with the reason written down. A new writer in
// a file not listed here fails the build, which is the point.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = join(ROOT, "src", "api");

const read = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Every `UPDATE job_cards ... SET <clause> WHERE` whose SET clause writes status. */
function statusWrites(src) {
  const out = [];
  const re = /UPDATE\s+job_cards\b([\s\S]*?)\bWHERE\b/gi;
  let m;
  while ((m = re.exec(src))) {
    const setClause = m[1];
    if (/\bstatus\s*=/.test(setClause)) {
      out.push({ index: m.index, setClause: setClause.replace(/\s+/g, " ").trim() });
    }
  }
  return out;
}

// The gated everyday paths: each must call the ONE shared gate.
const GATED = {
  "src/api/routes/production-orders/_helpers.ts": "applyPoUpdate — the grid, bulk-patch and the batch date stamp",
  "src/api/routes/production-orders.ts": "the sticker scan and both fan-out scans",
  "src/api/routes/sheets-sync.ts": "the Google Sheets webhook (R3)",
};

// Repair tools: every handler in the file that writes status is admin-only.
const ADMIN_ONLY = {
  "src/api/routes/import-completion/completion-cascades.ts": "job-card-completion, cascade-upstream-completion, cascade-leak-pass, clear-future-completions (found beyond the PRD's seven)",
  "src/api/routes/import-completion/wip-fixes.ts": "uph-pofold-backfill, fab-cut-pofold-backfill",
  "src/api/routes/import-completion/so-co-do-backfills.ts": "migrate-do-from-excel, backfill-complete-stray-jc-co2606002",
  "src/api/routes/import-completion/fg-fabric.ts": "backfill-fab-cut-merge (found beyond the PRD's seven)",
};

// A shared writer with no handler of its own: gated through its only caller.
const VIA_CALLER = {
  "src/api/routes/import-completion/_shared.ts": {
    fn: "processRow(",
    caller: "src/api/routes/import-completion/completion-cascades.ts",
  },
};

// Not completions: CANCELLED, BLOCKED, or the undo of a cancel. None of these
// moves stock, so none of them needs the gate.
const NOT_A_COMPLETION = {
  "src/api/routes/consignment-orders.ts": /status = 'CANCELLED'/,
  "src/api/routes/import-completion/procurement-backfills.ts": /status = 'CANCELLED'/,
  "src/api/routes/qc-pending.ts": /status = 'BLOCKED'/,
  "src/api/routes/sales-orders/_helpers.ts": /status = (COALESCE\(pre_cancel_status|'CANCELLED')/,
  "src/api/routes/production-orders/_helpers.ts": /status = (COALESCE\(pre_cancel_status|'CANCELLED')/,
};

const files = walk(API).map((p) => relative(ROOT, p).replace(/\\/g, "/"));

test("every job_cards status writer in src/api is accounted for, by name", () => {
  const unlisted = [];
  for (const rel of files) {
    const writes = statusWrites(read(rel));
    if (writes.length === 0) continue;
    const listed = rel in GATED || rel in ADMIN_ONLY || rel in VIA_CALLER || rel in NOT_A_COMPLETION;
    if (!listed) unlisted.push(`${rel}: ${writes.map((w) => w.setClause.slice(0, 60)).join(" | ")}`);
  }
  assert.deepEqual(
    unlisted,
    [],
    "a new file writes job_cards.status — route it through gateJobCardSequence, or list it here with a reason",
  );
});

test("the gated paths call the ONE shared gate, and the count is pinned", () => {
  const helpers = read("src/api/routes/production-orders/_helpers.ts");
  const po = read("src/api/routes/production-orders.ts");
  const sheets = read("src/api/routes/sheets-sync.ts");

  // One definition.
  assert.equal((helpers.match(/export async function gateJobCardSequence\(/g) ?? []).length, 1);
  // Desktop: applyPoUpdate covers the grid AND bulk-patch, which loops back into it.
  assert.equal((helpers.match(/await gateJobCardSequence\(db, c, \{/g) ?? []).length, 1);
  assert.match(helpers, /if \(transitionConsumesUpstream\(body\.status\)\) \{/);
  // Shop floor: the sticker scan directly, both fan-outs through the thin wrapper.
  assert.equal((po.match(/await gateJobCardSequence\(db, c, \{/g) ?? []).length, 2);
  assert.equal(
    (po.match(/gateFanOutSequence\(db, c, poId, cards, body, worker\)/g) ?? []).length,
    2,
    "scan-complete-dept AND scan-complete-shared, each passing the worker as the actor",
  );
  // The spreadsheet.
  assert.equal((sheets.match(/await gateJobCardSequence\(db, c, \{/g) ?? []).length, 1);
  assert.match(sheets, /autoUnlock: \{/);
  assert.match(sheets, /code: "SHEETS_SYNC"/);

  // No file keeps a private copy of the refusal: the only places that build a
  // 409 UPSTREAM_INCOMPLETE are the gate and its write-guard companion.
  assert.equal((helpers.match(/code: "UPSTREAM_INCOMPLETE"/g) ?? []).length, 2);
  assert.equal((po.match(/code: "UPSTREAM_INCOMPLETE"/g) ?? []).length, 0);
  assert.equal((sheets.match(/code: "UPSTREAM_INCOMPLETE"/g) ?? []).length, 0);
  assert.equal(/sequenceBlockers\(/.test(po), false, "the route file must not re-run the rule itself");
});

test("every status-writing handler in a repair file is admin-only (R4)", () => {
  for (const [rel, why] of Object.entries(ADMIN_ONLY)) {
    const src = read(rel);
    const writes = statusWrites(src);
    assert.ok(writes.length > 0, `${rel} should still contain a status write (${why})`);
    for (const w of writes) {
      // The handler this write lives in: the nearest app.post( above it.
      const start = src.lastIndexOf("app.post(", w.index);
      assert.ok(start >= 0, `${rel}: status write at ${w.index} is not inside a handler`);
      const head = src.slice(start, start + 900);
      const route = head.match(/app\.post\("([^"]+)"/)?.[1] ?? "?";
      assert.match(
        head,
        /const denied = requireAdmin\(c\);/,
        `${rel} ${route}: writes job_cards.status but is not requireAdmin — the grid permission must not reach a bulk completion`,
      );
      assert.equal(
        /requirePermission\(c, "production-orders", "update"\)/.test(head.slice(0, head.indexOf("requireAdmin(c)"))),
        false,
        `${rel} ${route}: still checks the everyday permission before the admin gate`,
      );
    }
  }
});

test("the shared import writer is reachable only through an admin-only handler", () => {
  for (const [rel, { fn, caller }] of Object.entries(VIA_CALLER)) {
    assert.ok(statusWrites(read(rel)).length > 0, `${rel} should contain the shared writer`);
    // Nobody else in src/api calls it.
    const callers = files.filter((f) => f !== rel && read(f).includes(fn));
    assert.deepEqual(callers, [caller], `${fn} gained a caller — it must stay behind requireAdmin`);
    const src = read(caller);
    const at = src.indexOf(fn);
    const start = src.lastIndexOf("app.post(", at);
    assert.match(src.slice(start, start + 900), /const denied = requireAdmin\(c\);/);
  }
});

test("the non-completion writers only ever write CANCELLED / BLOCKED / the undo", () => {
  for (const [rel, allowed] of Object.entries(NOT_A_COMPLETION)) {
    const src = read(rel);
    for (const w of statusWrites(src)) {
      // The gated file also holds the cancel/undo pair; skip its gated write.
      if (rel in GATED && /status = \?, completedDate = \?/.test(w.setClause)) continue;
      assert.match(w.setClause, allowed, `${rel}: ${w.setClause.slice(0, 80)}`);
    }
  }
});

test("requireAdmin is a role gate, not a permission row that could be granted", () => {
  const rbac = read("src/api/lib/rbac.ts");
  const fn = rbac.slice(rbac.indexOf("export function requireAdmin("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /role !== "SUPER_ADMIN" && role !== "ADMIN"/);
  assert.equal(/getRolePermissions|permitted\(/.test(body), false);
});
