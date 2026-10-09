// ============================================================================
// merge-prod-into-staging.mjs
//
// Non-destructive prod -> staging refresh. Copies prod rows that staging does
// not have yet and NEVER deletes or overwrites anything already in staging, so
// test data (new documents, edited rows) survives a refresh.
//
// How: for every public table present in both databases, COPY prod's rows into
// a temp table on staging, then INSERT ... ON CONFLICT DO NOTHING. Any unique
// key (primary key or not) that already exists on staging wins, staging's row is
// kept. Only columns present on BOTH sides are copied, so a staging-only column
// keeps its default and a prod-only column is ignored.
//
// Compare with sync-staging.yml mode=reset, which DROPs the whole schema.
//
// KNOWN LIMITS (deliberate, ponytail)
// * A prod row a tester deleted on staging comes back (nothing marks deletions).
// * Serial/identity sequences are not advanced. This ERP keys rows with text ids,
//   so it does not bite today; add a setval pass if a serial PK table is used.
// * A table with no unique index is only filled if it is empty on staging,
//   otherwise every run would duplicate its rows.
// * Schema is NOT touched. If prod has a table/column staging lacks, it is
//   skipped; merge main into staging (deploy) to pick the schema up.
//
// The merged rows are raw prod data: the workflow runs sanitize-staging.mjs
// straight afterwards, and credential tables are never copied at all (SKIP).
//
// USAGE
//   node scripts/merge-prod-into-staging.mjs            # report only, no writes
//   node scripts/merge-prod-into-staging.mjs --apply    # merge
//
// Env: PROD_DATABASE_URL (only ever read), STAGING_DATABASE_URL (written).
// ============================================================================

import postgres from "postgres";
import { pipeline } from "node:stream/promises";
import { projectRef } from "./_db.mjs";

const APPLY = process.argv.includes("--apply");

// From the environment (GitHub secrets), never from this public source file.
const STAGING_REF = projectRef("staging");
const PROD_REF = projectRef("prod");

// Never copied: sanitize-staging.mjs deletes these anyway, so skip them rather
// than land live prod credentials / queued customer mail even briefly.
// _migrations: copying it would mark migrations staging never ran as applied.
const SKIP = new Set([
  "_migrations",
  "user_sessions",
  "worker_tokens",
  "password_reset_tokens",
  "user_invites",
  "kpi_survey_tokens",
  "outbox_emails",
]);

const prodUrl = process.env.PROD_DATABASE_URL;
const stgUrl = process.env.STAGING_DATABASE_URL;
if (!prodUrl || !stgUrl) {
  console.error("PROD_DATABASE_URL and STAGING_DATABASE_URL must both be set.");
  process.exit(1);
}
// Same paranoia as sanitize-staging.mjs: assert both ends positively, so a swapped
// or mistyped secret can never make prod the write target.
if (!prodUrl.includes(PROD_REF) || prodUrl.includes(STAGING_REF)) {
  console.error("REFUSING: PROD_DATABASE_URL must contain the prod ref and not the staging ref.");
  process.exit(1);
}
if (!stgUrl.includes(STAGING_REF) || stgUrl.includes(PROD_REF)) {
  console.error("REFUSING: STAGING_DATABASE_URL must contain the staging ref and not the prod ref.");
  process.exit(1);
}

const conn = (url) =>
  postgres(url, { ssl: { rejectUnauthorized: false }, max: 1, idle_timeout: 20, connect_timeout: 30 });
// Prod is only ever read; make the server refuse a write even if this file is edited badly.
async function prodConn() {
  const db = conn(prodUrl);
  await db.unsafe("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
  return db;
}
const prod = await prodConn();
const stg = conn(stgUrl);

console.log(`mode : ${APPLY ? "APPLY (insert-only into staging)" : "REPORT ONLY (no writes)"}\n`);

const q = (id) => `"${id}"`;

// table -> ordered list of insertable columns (skips generated columns).
async function columnsOf(db) {
  const rows = await db`
    SELECT c.table_name AS t, c.column_name AS col
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       AND c.is_generated = 'NEVER'
     ORDER BY c.table_name, c.ordinal_position`;
  const m = new Map();
  for (const r of rows) (m.get(r.t) ?? m.set(r.t, []).get(r.t)).push(r.col);
  return m;
}
const pcols = await columnsOf(prod);
const scols = await columnsOf(stg);

const hasUnique = new Set(
  (
    await stg`
      SELECT DISTINCT c.relname AS t
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND i.indisunique`
  ).map((r) => r.t),
);

// Parents before children so FK checks pass without needing superuser
// (session_replication_role). Tables inside a cycle are appended as one batch.
const tables = [...scols.keys()].filter((t) => pcols.has(t) && !SKIP.has(t));
const deps = new Map(tables.map((t) => [t, new Set()]));
for (const fk of await stg`
  SELECT cl.relname AS child, pl.relname AS parent
    FROM pg_constraint k
    JOIN pg_class cl ON cl.oid = k.conrelid
    JOIN pg_class pl ON pl.oid = k.confrelid
   WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace`) {
  if (fk.child !== fk.parent && deps.has(fk.child) && deps.has(fk.parent)) deps.get(fk.child).add(fk.parent);
}
const done = new Set();
const order = [];
while (order.length < tables.length) {
  const left = tables.filter((t) => !done.has(t));
  const ready = left.filter((t) => [...deps.get(t)].every((p) => done.has(p)));
  for (const t of ready.length ? ready : left) {
    done.add(t);
    order.push(t);
  }
}

let inserted = 0;
const failed = [];
for (const t of order) {
  const cols = pcols.get(t).filter((c) => scols.get(t).includes(c));
  if (!cols.length) continue;
  if (!hasUnique.has(t) && (await stg.unsafe(`SELECT 1 FROM public.${q(t)} LIMIT 1`)).length) {
    console.log(`${"-".padStart(9)}  ${t}   (no unique key and not empty on staging, skipped)`);
    continue;
  }
  const list = cols.map(q).join(", ");
  if (!APPLY) {
    const n = (await prod.unsafe(`SELECT COUNT(*)::int AS n FROM public.${q(t)}`))[0].n;
    console.log(`${String(n).padStart(9)}  ${t}   (prod rows, ${cols.length} cols)`);
    continue;
  }
  // A fresh prod connection per table: with postgres.js 3.4.9 a large COPY TO
  // STDOUT (~200 MB attendance_records) leaves its connection stuck, and the next
  // query on it never returns (BUG-2026-10-09-270).
  const source = await prodConn();
  try {
    const n = await stg.begin(async (tx) => {
      await tx.unsafe(
        `CREATE TEMP TABLE _in ON COMMIT DROP AS SELECT ${list} FROM public.${q(t)} WITH NO DATA`,
      );
      const src = await source.unsafe(`COPY (SELECT ${list} FROM public.${q(t)}) TO STDOUT`).readable();
      const dst = await tx.unsafe(`COPY _in (${list}) FROM STDIN`).writable();
      await pipeline(src, dst);
      const r = await tx.unsafe(
        `INSERT INTO public.${q(t)} (${list}) OVERRIDING SYSTEM VALUE
         SELECT ${list} FROM _in ON CONFLICT DO NOTHING`,
      );
      return r.count;
    });
    inserted += n;
    console.log(`${String(n).padStart(9)}  ${t}   (new rows)`);
  } catch (e) {
    failed.push(t);
    console.log(`${"FAILED".padStart(9)}  ${t}   ${e.message}`);
  } finally {
    await source.end({ timeout: 1 });
  }
}

await prod.end();
await stg.end();

console.log(`\n${APPLY ? `${inserted} new rows inserted.` : "Report only. Re-run with --apply."}`);
if (failed.length) {
  console.error(`${failed.length} table(s) failed: ${failed.join(", ")}`);
  process.exit(1);
}
