// BUG-2026-09-29-216: sync-staging.yml ran on a nightly cron and DROPped staging's
// whole public schema, so every test record vanished at 02:00 SGT. Pin: no
// schedule, the destructive path is opt-in, the default mode keeps data.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

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

test("merge and sanitiser take the project refs from the environment, not source", () => {
  for (const code of [merge, sanitize]) {
    assert.match(code, /const STAGING_REF = projectRef\("staging"\);/);
    assert.match(code, /const PROD_REF = projectRef\("prod"\);/);
  }
});

// The repo is public, so no tracked file may name a Supabase project. The refs
// live in .env / GitHub secrets; this test only holds their SHA-256, so it can
// spot one without publishing it. (prod, staging, sandbox, retired staging)
const REF_SHA256 = new Set([
  "b1cdde1c3417c0f9bb8e3f80633c7516d8498ce94de1c91f81d99a318f749493",
  "9aabb29425b34eeb93a613a1fa843f43ab94c4156e0376ea2ebddddaa2bd4384",
  "6d0fc6201c8a3f17b779c7eb864bc051bfffff1874d15860131f84851acfc31a",
  "386e462c18d9c12c0fa9f1eabdee4319d577bd9efb1164e7dd068131a2c9adc3",
]);
// Any ref-shaped host, username or MCP ref, known or not.
const REF_IN_CONTEXT = /\bdb\.[a-z]{20}\.supabase\.co|\bpostgres\.[a-z]{20}\b|project_ref=[a-z]{20}\b|\b[a-z]{20}\.supabase\.co/;

test("no tracked file names a Supabase project ref", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const hits = [];
  for (const f of files) {
    let text;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    if (text.includes("\0")) continue; // binary
    if (REF_IN_CONTEXT.test(text)) hits.push(`${f}: ref-shaped Supabase host/user`);
    for (const tok of new Set(text.match(/\b[a-z]{20}\b/g) ?? [])) {
      if (REF_SHA256.has(createHash("sha256").update(tok).digest("hex"))) hits.push(`${f}: names a project ref`);
    }
  }
  assert.deepEqual(hits, []);
});
