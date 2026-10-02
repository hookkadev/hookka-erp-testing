// card-padding-phone.test.mjs — BUG-2026-10-02-252.
//
// A card that sets its own padding (`<CardContent className="p-3">`) lost its
// top padding on phones: the base classes carried `max-md:p-[…] max-md:pt-0`,
// and tailwind-merge cannot know a plain `p-3` should beat a `max-md:` variant.
// Measured on staging: every dashboard number tile had 0px top / 12px bottom
// below 768px. The phone default now goes through a CSS variable, so the base
// has no `max-md:` padding class left for a caller to lose to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { cn } = await import("../src/lib/utils.ts");
const { KPI_ROW } = await import("../src/pages/dashboards/dashboard-shared-lib.ts");

function baseClasses(component) {
  const src = readFileSync(new URL("../src/components/ui/card.tsx", import.meta.url), "utf8");
  const block = src.slice(src.indexOf(`const ${component} =`));
  return block.match(/cn\("([^"]+)"/)[1];
}

for (const component of ["CardContent", "CardHeader"]) {
  test(`${component}: a caller's own padding wins at every width`, () => {
    const merged = cn(baseClasses(component), "p-3").split(/\s+/);
    assert.ok(merged.includes("p-3"));
    const stray = merged.filter((c) => /^(max-|sm:|md:|lg:|xl:)[^:]*:p[trblxy]?-/.test(c));
    assert.deepEqual(stray, [], "a breakpoint padding class would override the caller's p-3 there");
    assert.ok(!merged.includes("pt-0"), "p-3 must also clear the base pt-0");
  });
}

test("CardContent with no padding of its own keeps the old look (pt-0, phone default by variable)", () => {
  const merged = cn(baseClasses("CardContent")).split(/\s+/);
  assert.ok(merged.includes("pt-0"));
  assert.ok(merged.some((c) => c.startsWith("max-md:[--card-pad-auto:")));
});

test("number-tile rows fill the row's own width and let tiles shrink", () => {
  assert.match(KPI_ROW, /flex-wrap/);
  assert.match(KPI_ROW, /\[&>\*\]:min-w-0/);
  assert.match(KPI_ROW, /\[&>\*\]:flex-\[1_1_10rem\]/);
});
