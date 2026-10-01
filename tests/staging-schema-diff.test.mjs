// Staging-only: never PR this into main.
// diffSchema behind the /staging-schema page. Fixture data only, no DB.
// Run: node --import tsx/esm --test tests/staging-schema-diff.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { diffSchema } from "../src/api/lib/staging-schema-diff.ts";

const col = (table, column, dataType = "text") => ({ table, column, dataType });

test("matching schema reports nothing", () => {
  const d = diffSchema(
    { users: ["id", "is_active"] },
    { users: ["is_active"] },
    [col("users", "id"), col("users", "is_active", "boolean")],
  );
  assert.deepEqual(d.missingTables, []);
  assert.deepEqual(d.missingColumns, []);
  assert.deepEqual(d.booleanMismatches, []);
  assert.deepEqual(d.extraTables, []);
  assert.deepEqual(d.extraColumns, []);
  assert.equal(d.expectedColumns, 2);
  assert.equal(d.actualColumns, 2);
});

test("missing table is listed once, its columns are not repeated", () => {
  const d = diffSchema({ a: ["id"], b: ["id", "x"] }, {}, [col("a", "id")]);
  assert.deepEqual(d.missingTables, ["b"]);
  assert.deepEqual(d.missingColumns, []);
});

test("missing and extra columns, sorted", () => {
  const d = diffSchema(
    { users: ["id", "photo_file_id", "email"], workers: ["id", "b_col"] },
    {},
    [col("workers", "id"), col("users", "id"), col("users", "staging_only"), col("audit", "id")],
  );
  assert.deepEqual(d.missingColumns, [
    { table: "users", column: "email" },
    { table: "users", column: "photo_file_id" },
    { table: "workers", column: "b_col" },
  ]);
  assert.deepEqual(d.extraColumns, [{ table: "users", column: "staging_only" }]);
  assert.deepEqual(d.extraTables, ["audit"]);
});

test("boolean mismatch both ways", () => {
  const d = diffSchema(
    { workers: ["pcb_enabled", "is_outsource"] },
    { workers: ["pcb_enabled"] },
    [col("workers", "pcb_enabled", "integer"), col("workers", "is_outsource", "boolean")],
  );
  assert.deepEqual(d.booleanMismatches, [
    { table: "workers", column: "is_outsource", expected: "not boolean", actual: "boolean" },
    { table: "workers", column: "pcb_enabled", expected: "boolean", actual: "integer" },
  ]);
});

test("the bundled fixtures diff clean against themselves", () => {
  const schema = JSON.parse(readFileSync("tests/db-schema.json", "utf8"));
  const bools = JSON.parse(readFileSync("tests/db-boolean-columns.json", "utf8"));
  const rows = Object.entries(schema).flatMap(([t, cols]) =>
    cols.map((c) => col(t, c, bools[t]?.includes(c) ? "boolean" : "text")),
  );
  const d = diffSchema(schema, bools, rows);
  assert.equal(d.missingTables.length + d.missingColumns.length + d.booleanMismatches.length, 0);
  assert.equal(d.extraTables.length + d.extraColumns.length, 0);
});
