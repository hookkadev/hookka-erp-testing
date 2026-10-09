// DEV-37 (2026-10-06): every staff login opens /kpi and sees their OWN card,
// never anyone else's. Violet: "Just open the module for them to view, but
// only their own kpi"; only Super Admin assigns.
//
// The page used to sit behind `kpi:read`, a resource no role held, so only
// Super Admin ever reached it. The gate is gone; what keeps one person out of
// another's figures is requireSuperAdmin on every cross-user /api/kpi route.
// This file holds both halves: the door stays open, the other rooms stay shut.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { resourceForNav, hiddenNavPrefixes } from "../src/api/lib/nav-permissions.ts";
import { permissionsForRole, ALL_RESOURCES } from "../src/api/lib/role-policy.ts";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

test("the KPI menu link is shown to every login", () => {
  assert.equal(resourceForNav("/kpi"), null, "a /kpi row in NAV_RESOURCE hides people's own card");
  for (const role of ["OFFICE", "SALES", "QA", "R_AND_D", "HR"]) {
    assert.ok(!hiddenNavPrefixes(permissionsForRole(role)).includes("/kpi"), `${role} must see KPI`);
  }
  // A database role, or an account with its own permission list, holds none
  // of the code roles' grants. It still has a card.
  assert.ok(!hiddenNavPrefixes(new Set()).includes("/kpi"));
});

test("the /kpi page has no permission gate", () => {
  const routes = read("src/dashboard-routes.tsx");
  const block = routes.slice(routes.indexOf("path: '/kpi'"), routes.indexOf("path: '/agents'"));
  assert.ok(block.length > 0, "the /kpi route must exist");
  assert.doesNotMatch(block, /RequirePermission|RequireRole/);
});

test("kpi is not a grantable resource any more", () => {
  // A box in the per-user editor that changes nothing is worse than no box.
  assert.ok(!ALL_RESOURCES.includes("kpi"));
});

test("every KPI route that is not your own card is Super Admin only", () => {
  const src = read("src/api/routes/kpi.ts");
  const handlers = [...src.matchAll(/^app\.(get|post|put|delete)\("([^"]+)"/gm)];
  assert.ok(handlers.length >= 15, "the handler scan found too few routes");

  // These read the caller's own card and only switch to someone else for a
  // Super Admin; checked separately below. Ticking a checklist item is a WRITE
  // to a score and is Super Admin only (Violet 2026-10-06: "super admin only
  // can tick. staff can view only"), so PUT /checklist is not in this list.
  const own = new Set(["GET /me", "GET /checklist/:kpiKey", "GET /survey/:kpiKey"]);
  for (let i = 0; i < handlers.length; i++) {
    const [, verb, path] = handlers[i];
    const name = `${verb.toUpperCase()} ${path}`;
    if (own.has(name)) continue;
    const body = src.slice(handlers[i].index, handlers[i + 1]?.index ?? src.length);
    assert.match(body, /const denied = requireSuperAdmin\(c\);\s*if \(denied\) return denied;/, `${name} must be Super Admin only`);
  }
});

test("the own-card routes take the user from the session, not the request", () => {
  const src = read("src/api/routes/kpi.ts");
  const me = src.slice(src.indexOf('app.get("/me"'), src.indexOf('app.get("/users/:id"'));
  assert.match(me, /ctxGet\(c, "userId"\)/);
  assert.doesNotMatch(me, /c\.req\.(query|param)\("userId"\)|body\.userId/);
  // ?userId= / body.userId is honoured only for a Super Admin.
  for (const [start, end] of [
    ['app.get("/checklist/:kpiKey"', 'app.post("/survey/:kpiKey"'],
    ['app.get("/survey/:kpiKey"', 'app.get("/library"'],
  ]) {
    const body = src.slice(src.indexOf(start), src.indexOf(end));
    assert.ok(body.length > 0, `${start} not found`);
    assert.match(body, /&& isAdmin \? /, `${start} must only follow a requested userId for a Super Admin`);
  }
});

test("a non-admin page asks only for its own card", () => {
  const page = read("src/pages/kpi/index.tsx");
  // Everything that lists other people is fetched only for a Super Admin.
  for (const url of ['"/api/users"', "`/api/kpi/library", "`/api/kpi/people", '"/api/departments"']) {
    const at = page.indexOf(url);
    assert.ok(at > 0, `${url} not found`);
    assert.match(page.slice(at - 60, at), /isSuperAdmin/, `${url} must only load for a Super Admin`);
  }
  assert.match(page, /`\/api\/kpi\/me\?period=\$\{period\}`/);
});

test("only a Super Admin can tick a checklist item, on the page too", () => {
  const page = read("src/pages/kpi/index.tsx");
  assert.match(page, /canTick=\{isSuperAdmin\}/);
  assert.match(page, /disabled=\{locked \|\| !canTick\}/);
});
