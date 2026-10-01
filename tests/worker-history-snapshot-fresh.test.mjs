// ---------------------------------------------------------------------------
// worker-history-snapshot-fresh.test.mjs — BUG-2026-10-01-245.
//
// Staging 2026-10-01, worker TEST-001: clocked in, clocked out (the broken-
// punch rule wrote a 9h working_hour_entries row). GET /api/worker/today
// showed the punch-out and the 9h; GET /api/worker/history for the same day
// still showed clockOut null, 0 working minutes and no department rows.
//
// /history is served through withWorkerSnapshot. Its freshness probe and its
// rebuild reads were plain SELECTs, which Hyperdrive caches and never
// invalidates on a write. The probe is the same parameterless SQL every call,
// so its cached copy hid the new row; and a rebuild that did run could read
// cached pre-write rows and store them under the new signature.
//
//   1. With a DB whose plain reads return pre-write rows (Hyperdrive's cache)
//      and whose `batch` reads return the live rows, the snapshot rebuilds and
//      the rebuild sees the punch-out.
//   2. A DB without `batch` is used as is.
//   3. Every UPDATE of attendance_records / working_hour_entries in src/api
//      bumps updated_at. The clock-out UPDATE did not, so a punch-out that adds
//      no row moved nothing the probe reads.
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles the .ts import on newer Node.
}
register("./tests/_alias-loader.mjs", pathToFileURL("./"));

const { withWorkerSnapshot, freshReads } = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/worker-perf.ts")).href
);

const T0 = "2026-10-01T08:14:05.000Z";

// One state of the database: the attendance row, the source-table rows and
// the stored snapshot.
function state({ clockOut, wheRows, snapshot }) {
  return { clockOut, wheRows, snapshot };
}

// A Hyperdrive stand-in: plain reads answer from `cached`, reads inside a
// transaction (`batch`) answer from `live`. Writes land in `live`.
function hyperdriveDb(cached, live, { withBatch = true } = {}) {
  const plainReads = [];
  const answer = (sql, args, s) => {
    if (/information_schema\.columns/.test(sql)) {
      return [
        { tableName: "attendance_records", columnName: "updated_at" },
        { tableName: "working_hour_entries", columnName: "updated_at" },
      ];
    }
    if (/UNION ALL/.test(sql)) {
      return [
        { t: T0, n: 1 },
        { t: T0, n: s.wheRows },
      ];
    }
    if (/FROM worker_history_snapshot/.test(sql)) {
      return s.snapshot ? [s.snapshot] : [];
    }
    if (/FROM attendance_records/.test(sql)) {
      return [{ id: args[0], clockOut: s.clockOut }];
    }
    throw new Error(`unexpected read: ${sql}`);
  };
  const stmt = (sql, args = []) => ({
    sql,
    args,
    bind: (...a) => stmt(sql, a),
    all: async () => {
      plainReads.push(sql);
      return { results: answer(sql, args, cached) };
    },
    first: async () => {
      plainReads.push(sql);
      return answer(sql, args, cached)[0] ?? null;
    },
    run: async () => {
      if (/INSERT INTO worker_history_snapshot/.test(sql)) {
        live.snapshot = {
          org_id: args[0],
          cache_key: args[1],
          data: args[2],
          built_from: args[3],
          source_rows: args[5],
        };
      }
      return { success: true, meta: { changes: 1 } };
    },
  });
  const db = { prepare: (sql) => stmt(sql), plainReads };
  if (withBatch) {
    db.batch = async (stmts) =>
      stmts.map((s) => ({ results: answer(s.sql, s.args, live) }));
  }
  return db;
}

const OPTS = {
  tableName: "worker_history_snapshot",
  sourceTables: ["attendance_records", "working_hour_entries"],
  orgId: "hookka",
  cacheKey: "TEST-001:2026-10-01:2026-10-01",
};

const compute = async (db) => {
  const row = await db
    .prepare("SELECT * FROM attendance_records WHERE id = ?")
    .bind("att-1")
    .first();
  return { clockOut: row?.clockOut ?? null };
};

test("THE BUG: after clock-out, /history rebuilds from the live rows, not Hyperdrive's cached ones", async () => {
  // Snapshot built at clock-in: no clock-out, no working-hours row.
  const atClockIn = {
    org_id: "hookka",
    cache_key: OPTS.cacheKey,
    data: JSON.stringify({ clockOut: null }),
    built_from: T0,
    source_rows: 1,
  };
  const cached = state({ clockOut: null, wheRows: 0, snapshot: atClockIn });
  // Clock-out: clockOut set, the broken-punch rule inserted one 9h row.
  const live = state({ clockOut: "16:14", wheRows: 1, snapshot: atClockIn });
  const db = hyperdriveDb(cached, live);

  const out = await withWorkerSnapshot(db, OPTS, compute);

  assert.equal(out.clockOut, "16:14", "the rebuild must see the punch-out");
  assert.equal(
    JSON.parse(live.snapshot.data).clockOut,
    "16:14",
    "the stored snapshot must carry the punch-out, not the cached pre-write row",
  );
  assert.equal(live.snapshot.source_rows, 2, "stored under the live row count");
  assert.deepEqual(db.plainReads, [], "no read may go through Hyperdrive's cache");
});

test("an unchanged source is still served from the snapshot (no needless rebuild)", async () => {
  const snapRow = {
    org_id: "hookka",
    cache_key: OPTS.cacheKey,
    data: JSON.stringify({ clockOut: "16:14" }),
    built_from: T0,
    source_rows: 2,
  };
  const s = state({ clockOut: "16:14", wheRows: 1, snapshot: snapRow });
  const db = hyperdriveDb(s, s);
  let computed = 0;
  const out = await withWorkerSnapshot(db, OPTS, async (d) => {
    computed++;
    return compute(d);
  });
  assert.equal(out.clockOut, "16:14");
  assert.equal(computed, 0);
});

test("a DB without batch is used as is", () => {
  const db = hyperdriveDb(state({}), state({}), { withBatch: false });
  assert.equal(freshReads(db), db);
});

// ---- 3. every writer bumps updated_at --------------------------------------
function tsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("every UPDATE of attendance_records / working_hour_entries bumps updated_at", () => {
  const missing = [];
  let seen = 0;
  for (const file of tsFiles(resolve(process.cwd(), "src/api"))) {
    const text = readFileSync(file, "utf8");
    const re = /UPDATE\s+(attendance_records|working_hour_entries)\b/gi;
    let m;
    while ((m = re.exec(text))) {
      seen++;
      const rest = text.slice(m.index);
      const where = rest.search(/\bWHERE\b/i);
      const setClause = rest.slice(0, where === -1 ? 400 : where);
      if (!/updated_?at|BUMP_UPDATED_AT/i.test(setClause)) {
        const line = text.slice(0, m.index).split("\n").length;
        missing.push(`${file.slice(process.cwd().length + 1)}:${line}`);
      }
    }
  }
  assert.ok(seen >= 9, `expected the known writers, found ${seen}`);
  assert.deepEqual(missing, [], "these UPDATEs leave updated_at untouched");
});
