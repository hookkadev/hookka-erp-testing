// BUG-2026-09-23-184 — after a deploy, open tabs stayed on old code. The
// dashboard's one-shot "Reload?" prompt, once dismissed, never asked again,
// and the phone layout (/m) never checked for a new deploy at all. So a
// deployed fix (e.g. a pricing fix) silently didn't reach those operators.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const hook = readFileSync("src/lib/use-version-check.ts", "utf8");

test("a new deploy reloads on the next page change (never mid-form)", () => {
  assert.match(hook, /export function useAutoUpdateOnNavigate/);
  assert.match(
    hook,
    /useEffect\(\(\) => \{\s*if \(staleRef\.current\) window\.location\.reload\(\);\s*\}, \[pathname\]\);/,
  );
});

test("the poll isn't restarted by an inline callback", () => {
  assert.match(hook, /\}, \[intervalMs\]\);/);
  assert.match(hook, /onNewVersionRef\.current\(\)/);
});

test("every app shell picks up a new deploy", () => {
  for (const f of ["src/layouts/DashboardLayout.tsx", "src/pages/m/MobileLayout.tsx"]) {
    assert.match(readFileSync(f, "utf8"), /useAutoUpdateOnNavigate\(/, f);
  }
  // The worker portal reloads immediately on detection (no long forms there).
  assert.match(
    readFileSync("src/layouts/WorkerLayout.tsx", "utf8"),
    /useVersionCheck\(\{ onNewVersion: \(\) => window\.location\.reload\(\) \}\)/,
  );
});
