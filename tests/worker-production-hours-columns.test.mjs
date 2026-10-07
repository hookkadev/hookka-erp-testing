// ---------------------------------------------------------------------------
// worker-production-hours-columns.test.mjs
//
// The worker app names three different hour figures:
//   Working Hours                = every hour logged, non-production included
//   Production Hours             = hours in production departments only
//   Standard Production Duration = the BOM minutes credited from job cards
// Efficiency % = Standard Production Duration ÷ Production Hours, on the Home
// tiles and on each day of the History tab. Home once showed these labels
// swapped, and the History table divided by Working Hours instead.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on Node 22+.
}

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");
const ROUTE = read("src/api/routes/worker.ts");
const HOME = read("src/pages/worker/index.tsx");
const HISTORY = read("src/pages/worker/history.tsx");
const i18n = await import(pathToFileURL(resolve(process.cwd(), "src/lib/worker-i18n.ts")).href);

const historyHandler = ROUTE.slice(ROUTE.indexOf('app.get("/history"'), ROUTE.indexOf("const totals = {"));

test("each history day carries its production-department hours", () => {
  assert.match(historyHandler, /SELECT code, isProduction FROM departments/);
  assert.match(historyHandler, /if \(prodDeptCodes\.has\(code\)\) prodDeptMinutesByDate\.set/);
  assert.match(historyHandler, /prodDeptMinutes: prodDeptMinutesByDate\.get\(d\.date\) \?\? 0/);
  // The cached snapshot must not serve days without the new field.
  assert.match(historyHandler, /cacheKey: `v4:/);
});

test("Home tiles: Production Hours is prod-dept hours, Standard Production Duration is BOM", () => {
  assert.match(HOME, /label=\{t\("home\.workingHours"\)\}\s+value=\{mins2hrs\(hist\.totals\.workedMinutes\)\}/);
  assert.match(HOME, /label=\{t\("home\.productionHours"\)\}\s+value=\{mins2hrs\(hist\.totals\.prodDeptMinutes \?\? 0\)\}/);
  assert.match(HOME, /label=\{t\("home\.stdProductionDuration"\)\}\s+value=\{mins2hrs\(hist\.totals\.effProductionMinutes \?\? 0\)\}/);
});

test("History day efficiency divides by Production Hours, not Working Hours", () => {
  assert.match(HISTORY, /Math\.round\(\(r\.productionMinutes \/ prodHrsMins\) \* 100\)/);
  assert.doesNotMatch(HISTORY, /r\.productionMinutes \/ r\.workingMinutes/);
  assert.match(HISTORY, /t\("home\.colStdDuration"\)/);
});

test("the new labels exist in every worker language", () => {
  for (const key of ["home.workingHours", "home.stdProductionDuration", "home.colStdDuration"]) {
    for (const lang of ["en", "ms", "zh", "my"]) {
      const v = i18n.translateFor(lang, key);
      assert.notEqual(v, key, `no ${lang} string for ${key}`);
      assert.ok(v.trim().length > 0, `blank ${lang} for ${key}`);
    }
  }
});
