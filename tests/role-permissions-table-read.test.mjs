// ---------------------------------------------------------------------------
// role-permissions-table-read.test.mjs — GET /api/auth/role-permissions/:role
// answers for TABLE-defined roles too (FINANCE, PROCUREMENT, … seeded by
// 0045), with the SAME join the gate runs (rbac.ts loadRolePermissions:
// roles.name = users.role TEXT). Owner 2026-09-22 「我要确定 finance@hookka.com
// 的 user 有什么权限」— a prod-state question needs a measurement, and before
// this the only way to see a table role's grants was to log in as it.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const AUTH = read("src/api/routes/auth.ts");
const RBAC = read("src/api/lib/rbac.ts");

const block = AUTH.slice(AUTH.indexOf('app.get("/role-permissions/:role"'), AUTH.indexOf('app.get("/invite/:token"'));
const GATE_JOIN = /FROM role_permissions rp\s+JOIN roles r\s+ON r\.id\s+= rp\.roleId\s+JOIN permissions p ON p\.id\s+= rp\.permissionId\s+WHERE r\.name = \?/;

test("a table role is read with the gate's own join, not a different one", () => {
  assert.match(block, GATE_JOIN, "the endpoint must run the same join as rbac.ts");
  assert.match(RBAC, GATE_JOIN, "…and rbac.ts must still run it (the anchor this test relies on)");
});

test("zero rows is reported as the gate's fallback, never as 'no permissions'", () => {
  assert.match(block, /role === "SUPER_ADMIN" \|\| role === "ADMIN" \? \["\*:\*"\] : \["\*:read"\]/);
  assert.match(block, /source: joinFailed \? "join-failed-fallback" : fallback \? "no-rows-fallback" : "role_permissions"/);
});

test("still gated on users:read and still says codedPolicy for both kinds", () => {
  assert.match(block, /requirePermission\(c, "users", "read"\)/);
  assert.match(block, /codedPolicy: false/);
  assert.match(block, /codedPolicy: true/);
  assert.doesNotMatch(block, /INSERT|UPDATE|DELETE/, "a diagnostic must not write");
});
