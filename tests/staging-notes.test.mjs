// /staging-notes lists merged PRs carrying the `staging` label, read with gh.
// (Replaces the git-history version and its BUG-2026-09-29-215 shallow-clone
// guard: the notes no longer depend on checkout depth.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the notes script filters merged PRs by the staging label", () => {
  const src = readFileSync("scripts/gen-staging-notes.mjs", "utf8");
  assert.match(src, /'--label', 'staging'/);
  assert.match(src, /'--state', 'merged'/);
});

test("the staging deploy step gives gh a token", () => {
  const yml = readFileSync(".github/workflows/deploy.yml", "utf8");
  const step = yml.split(/- name: Staging patch notes/)[1]?.split(/\r?\n\s*- /)[0] ?? "";
  assert.match(step, /GH_TOKEN: \$\{\{ github\.token \}\}/);
});
