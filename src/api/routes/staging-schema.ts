// Staging-only: never PR this into main.
// GET /api/staging-schema compares the schema snapshot the code is tested
// against (tests/db-schema.json, refreshed by scripts/refresh-db-schema-fixture.mjs)
// with what the staging database actually has. Read-only: one SELECT on
// information_schema, never DDL, never fixes anything. 404 off staging,
// SUPER_ADMIN only on staging.
import { Hono } from "hono";
import type { Env } from "../worker";
import { requireSuperAdmin } from "../lib/rbac";
import { isStagingRequest } from "../lib/staging-gate";
import { diffSchema, type SchemaMap } from "../lib/staging-schema-diff";
import expected from "../../../tests/db-schema.json" with { type: "json" };
import expectedBooleans from "../../../tests/db-boolean-columns.json" with { type: "json" };

const app = new Hono<Env>();

app.get("/", async (c) => {
  if (!isStagingRequest(c)) return c.json({ success: false, error: "Not found" }, 404);
  const denied = requireSuperAdmin(c);
  if (denied) return denied;

  // information_schema identifiers are not in the rename map, so the SQL
  // passes through unchanged; result keys come back camelCased by postgres.js
  // (see archive-union.ts), so read both spellings.
  const res = await c.var.DB.prepare(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public'`,
  ).all<Record<string, string | undefined>>();
  const rows = (res.results ?? []).map((r) => ({
    table: String(r.tableName ?? r.table_name ?? ""),
    column: String(r.columnName ?? r.column_name ?? ""),
    dataType: String(r.dataType ?? r.data_type ?? ""),
  }));

  return c.json({
    success: true,
    data: diffSchema(expected as SchemaMap, expectedBooleans as SchemaMap, rows),
  });
});

export default app;
