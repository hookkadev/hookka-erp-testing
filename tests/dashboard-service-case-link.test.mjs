// dashboard-service-case-link.test.mjs — the dashboard Service tab's links into
// the real Service Cases module: list + per-case hrefs on desktop and /m, and the
// "no id -> no link" rule that keeps a row as plain text.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SERVICE_CASES_NAV_HREF, serviceCaseHref, serviceCasesHref,
} from "../src/pages/dashboards/service-case-link-lib.ts";

test("list hrefs: desktop sidebar entry and the /m module slug", () => {
  assert.equal(serviceCasesHref(), "/service-cases");
  assert.equal(serviceCasesHref("desktop"), "/service-cases");
  assert.equal(serviceCasesHref("m"), "/m/servicecases");
  assert.equal(SERVICE_CASES_NAV_HREF, "/service-cases");
});

test("case href = list href + the encoded service_cases.id", () => {
  assert.equal(serviceCaseHref("sc_123"), "/service-cases/sc_123");
  assert.equal(serviceCaseHref("sc_123", "m"), "/m/servicecases/sc_123");
  assert.equal(serviceCaseHref("a/b c", "m"), "/m/servicecases/a%2Fb%20c");
});

test("a row without an id never becomes a link", () => {
  for (const id of [null, undefined, "", "   "]) {
    assert.equal(serviceCaseHref(id), null);
    assert.equal(serviceCaseHref(id, "m"), null);
  }
});

// The hrefs are only right while the routes they point at exist. Pin them to the
// router sources so renaming a route fails here instead of 404ing in the app.
test("the target routes exist in the routers", () => {
  const desktop = readFileSync(new URL("../src/dashboard-routes.tsx", import.meta.url), "utf8");
  assert.ok(desktop.includes("path: '/service-cases',"));
  assert.ok(desktop.includes("path: '/service-cases/:id',"));
  const modules = readFileSync(new URL("../src/pages/m/config/modules.ts", import.meta.url), "utf8");
  assert.ok(modules.includes('slug: "servicecases"'));
  assert.ok(modules.includes("detailPath: (vm) => `/m/servicecases/${encodeURIComponent(vm.id)}`"));
});
