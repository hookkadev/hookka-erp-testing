// BUG-2026-09-29-215 — /staging-notes showed 0 PRs. deploy.yml used
// `fetch-depth: ${{ ... && 0 || 1 }}`; a bare 0 is falsy in Actions
// expressions, so staging got a depth-1 clone with no merge history.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("staging checkout asks for full history with a quoted '0'", () => {
  const yml = readFileSync(".github/workflows/deploy.yml", "utf8");
  const line = yml.split(/\r?\n/).find((l) => /^\s*fetch-depth:/.test(l));
  assert.ok(line, "deploy.yml has a fetch-depth line");
  assert.match(line, /refs\/heads\/staging' && '0' \|\| /);
});

test("the notes script refuses a shallow checkout instead of writing 0 PRs", () => {
  const src = readFileSync("scripts/gen-staging-notes.mjs", "utf8");
  assert.match(src, /--is-shallow-repository/);
  assert.match(src, /process\.exit\(1\)/);
});
