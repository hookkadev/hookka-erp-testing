// ---------------------------------------------------------------------------
// route-titles-settings.test.mjs — every /settings/* and /admin/* page has its
// own breadcrumb title. Without one, titleForPath falls back to the FIRST
// segment, so /settings/email-reports read "Settings > Settings" (2026-09-29).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { titleForPath } from "../src/lib/route-titles.ts";

test("settings/admin sub-pages get their own breadcrumb title", () => {
  const src = readFileSync("src/dashboard-routes.tsx", "utf8");
  const paths = [...src.matchAll(/path: '(\/(?:settings|admin)\/[a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(paths.includes("/settings/email-reports"));
  const generic = paths.filter((p) => ["Settings", "Admin"].includes(titleForPath(p)));
  assert.deepEqual(generic, []);
});
