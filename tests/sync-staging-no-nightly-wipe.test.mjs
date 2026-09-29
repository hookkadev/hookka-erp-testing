// BUG-2026-09-29-216: sync-staging.yml ran on a nightly cron and DROPped staging's
// whole public schema, so every test record vanished at 02:00 SGT. Pin: no
// schedule, the destructive path is opt-in, the default mode keeps data.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const wf = readFileSync(".github/workflows/sync-staging.yml", "utf8");
const merge = readFileSync("scripts/merge-prod-into-staging.mjs", "utf8");
const sanitize = readFileSync("scripts/sanitize-staging.mjs", "utf8");

test("no cron trigger (a schedule on main wipes staging nightly)", () => {
  assert.doesNotMatch(wf, /^\s*schedule:/m);
  assert.doesNotMatch(wf, /^\s*- cron:/m);
});

test("default mode is the non-destructive merge; the DROP step is reset-only", () => {
  assert.match(wf, /default: merge/);
  const step = wf.slice(wf.lastIndexOf("- name:", wf.indexOf("DROP SCHEMA IF EXISTS")));
  assert.match(step.split("run:")[0], /if: inputs\.mode == 'reset'/);
  assert.match(wf, /mode=reset requires confirm input/);
});

test("merge never deletes or overwrites staging rows", () => {
  const code = merge.replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /ON CONFLICT DO NOTHING/);
  // (`ON COMMIT DROP` on the temp table is fine; only real drops/deletes count)
  assert.doesNotMatch(code, /\bDROP (TABLE|SCHEMA)\b|\bTRUNCATE\b|\bDELETE FROM\b|DO UPDATE/);
});

test("merge and sanitiser agree on the real staging project", () => {
  const ref = /const STAGING_REF = "([a-z]+)"/;
  assert.equal(merge.match(ref)[1], sanitize.match(ref)[1]);
  assert.equal(sanitize.match(ref)[1], "kahxgvbfanbraazetefr");
});
