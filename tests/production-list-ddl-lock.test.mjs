// ---------------------------------------------------------------------------
// production-list-ddl-lock.test.mjs — BUG-2026-10-07-264.
//
// Production sheets (Foam Bonding most of all) sat on "loading…" forever.
// Measured on staging 2026-10-07: `/api/production-orders` hung for over ten
// minutes while every other endpoint answered in under 0.5 s, and the slowest
// SQL on that route over 24 h was a NO-OP DDL:
//   ALTER TABLE production_orders_list_snapshot ADD COLUMN IF NOT EXISTS
//   source_rows BIGINT   — avg 10.5 s, p95 25 s.
// Postgres takes ACCESS EXCLUSIVE before it checks IF NOT EXISTS, and every new
// read of the table queues behind the waiting ALTER. The page's 8 s poll then
// aborted each read before it could land (8001 / 8002 ms in the network log)
// and started another one.
//
// Guards: (1) self-apply asks the catalog first and runs no DDL when the schema
// already matches; (2) the production-orders memo is a boolean; (3) the poll
// and tab-return refetch skip while the orders read is in flight.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseSelfApplyStmt,
  selfApplyAlreadyDone,
  runSelfApply,
} from "../src/api/lib/self-apply.ts";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

/** Fake DB: answers the two catalog probes from `schema`, records DDL. */
function db({ columns = [], indexes = [], probeFails = false } = {}) {
  const ran = [];
  return {
    ran,
    prepare(sql) {
      const isProbe = /information_schema\.columns|pg_indexes/.test(sql);
      return {
        bind() {
          return {
            async all() {
              if (probeFails) throw new Error("connection reset");
              if (/pg_indexes/.test(sql)) return { results: indexes.map((indexname) => ({ indexname })) };
              return {
                results: columns.map(([t, c, type = "text"]) => ({
                  tableName: t, columnName: c, dataType: type,
                })),
              };
            },
          };
        },
        async run() {
          if (isProbe) throw new Error("probe must use all()");
          ran.push(sql);
          return {};
        },
      };
    },
  };
}

const SNAP_DDL = "ALTER TABLE production_orders_list_snapshot ADD COLUMN IF NOT EXISTS source_rows BIGINT";

test("an existing column means NO ALTER is sent — the no-op ALTER is what queued for the lock", async () => {
  const d = db({ columns: [["production_orders_list_snapshot", "source_rows", "bigint"]] });
  await runSelfApply(d, "t", [SNAP_DDL]);
  assert.deepEqual(d.ran, []);
});

test("a missing column still gets its ALTER", async () => {
  const d = db({ columns: [["production_orders_list_snapshot", "data"]] });
  await runSelfApply(d, "t", [SNAP_DDL]);
  assert.deepEqual(d.ran, [SNAP_DDL]);
});

test("a failed probe falls back to running the DDL, never to skipping it", async () => {
  const d = db({ probeFails: true });
  await runSelfApply(d, "t", [SNAP_DDL]);
  assert.deepEqual(d.ran, [SNAP_DDL]);
});

test("one statement the parser does not know runs the whole round as before", async () => {
  const d = db({ columns: [["production_orders_list_snapshot", "source_rows", "bigint"]] });
  assert.equal(await selfApplyAlreadyDone(d, [SNAP_DDL, "UPDATE x SET y = 1"]), false);
});

test("camelCase names are checked under their physical (renamed) name", () => {
  const c = parseSelfApplyStmt("ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS distributedAt TEXT");
  assert.deepEqual(c, { kind: "column", table: "job_cards", column: "distributed_at" });
});

test("type change, table and index shapes are understood and checked", async () => {
  const stmts = [
    "ALTER TABLE wip_cascade_log ALTER COLUMN org_id TYPE TEXT USING org_id::text",
    "CREATE TABLE IF NOT EXISTS wip_cascade_log (id UUID PRIMARY KEY)",
    "DROP INDEX IF EXISTS uniq_old",
    "CREATE UNIQUE INDEX IF NOT EXISTS uniq_new ON wip_cascade_log (org_id)",
  ];
  const good = db({ columns: [["wip_cascade_log", "org_id", "text"]], indexes: ["uniq_new"] });
  assert.equal(await selfApplyAlreadyDone(good, stmts), true);
  const wrongType = db({ columns: [["wip_cascade_log", "org_id", "uuid"]], indexes: ["uniq_new"] });
  assert.equal(await selfApplyAlreadyDone(wrongType, stmts), false);
  const oldIndexLeft = db({ columns: [["wip_cascade_log", "org_id", "text"]], indexes: ["uniq_new", "uniq_old"] });
  assert.equal(await selfApplyAlreadyDone(oldIndexLeft, stmts), false);
});

test("every production-orders self-apply statement is one the catalog check understands", () => {
  // One unknown shape would silently turn the check off for the whole list read.
  const src = read("src/api/routes/production-orders/_helpers.ts");
  const fn = src.slice(src.indexOf("export async function ensurePendingMigrations"));
  const arr = fn
    .slice(fn.indexOf("const stmts = ["), fn.indexOf("];"))
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  const literals = [...arr.matchAll(/"([^"]+)"|`([^`]+)`/g)].map((m) => m[1] ?? m[2]);
  assert.ok(literals.length >= 15, `found ${literals.length} statements`);
  for (const sql of literals) assert.ok(parseSelfApplyStmt(sql), sql);
});

test("the production-orders memo is a boolean, not a shared in-flight promise", () => {
  const src = read("src/api/routes/production-orders/_helpers.ts");
  assert.match(src, /let migrationsApplied = false;/);
  assert.doesNotMatch(src, /export let pendingMigrations: Promise/);
});

test("the snapshot source_rows column is checked in the catalog before any ALTER", () => {
  const src = read("src/api/lib/snapshot.ts");
  const fn = src.slice(src.indexOf("export async function ensureSourceRowsColumn"));
  assert.ok(fn.indexOf("selfApplyAlreadyDone") < fn.indexOf(".run()"));
});

test("/production poll and tab-return refetch skip while the orders read is in flight", () => {
  const src = read("src/pages/production/index.tsx");
  const guards = src.match(/if \(ordersUrl && isInflight\(ordersUrl\)\) return;/g) ?? [];
  assert.equal(guards.length, 2);
  const poll = src.slice(src.indexOf("const POLL_INTERVAL_MS = 8_000;"));
  assert.ok(poll.indexOf("isInflight(ordersUrl)") < poll.indexOf("fetchOrders();"));
});
