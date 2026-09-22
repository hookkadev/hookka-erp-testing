// ---------------------------------------------------------------------------
// check-efficiency-day-gate.mjs — READ-ONLY.
//
// Prove, against the live database, what the day-intersection gate
// (fix/efficiency-worked-day-intersection, 2026-09-22) does to the Efficiency %
// numerator. For a date range it computes, per worker, BOTH:
//
//   OLD  the numerator that shipped before this change — every completed job
//        card credited to its PIC(s) on completedDate, with NO check that the
//        worker clocked hours that day (src/api/routes/job-cards.ts /summary,
//        pre-gate). PIC halving + FAB_CUT per-set + ×wipQty preserved.
//
//   NEW  the same numerator, but a card counts for a worker ONLY on a
//        completedDate where that worker also has a PRODUCTION working_hour_entry
//        (the gate this branch adds). Non-production hours never gate output in.
//
// It then prints Efficiency % both ways (numerator ÷ clocked production hours)
// and lists every worker whose figure moves, loudest first — the >100% rows are
// the inflation the gate removes. Nothing is written.
//
//   HOOKKA_PROD_DB_URL='...' node scripts/check-efficiency-day-gate.mjs 2026-09-01 2026-09-21
//   HOOKKA_STAGING_DB_URL='...' node scripts/check-efficiency-day-gate.mjs --staging 2026-09-01 2026-09-21
//
// WHY THIS SCRIPT EXISTS RATHER THAN A NUMBER IN THE PR: this change was
// developed WITHOUT live Hookka database access (its DB — project ref
// vpwdqtsxexpiqxzweivd — is not reachable from the dev session). Prod impact is
// therefore UNMEASURED at the time of writing. This is the measurement, for
// whoever holds the credential. Do NOT describe the deploy as "no-op" until it
// has been run: the healthy expectation is that in a fully-entered period NEW
// equals OLD for (almost) every worker, and only periods with unentered Working
// Hours show OLD > NEW (the old inflation). If NEW drops for a worker whose
// hours ARE entered, that is a signal to investigate, not to ship.
// ---------------------------------------------------------------------------
import postgres from "postgres";
import { prodUrl, stagingUrl } from "./_db.mjs";

const args = process.argv.slice(2);
const useStaging = args.includes("--staging");
const positional = args.filter((a) => !a.startsWith("--"));
const today = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const from = positional[0] ?? iso(new Date(today.getTime() - 29 * 86400000));
const to = positional[1] ?? iso(today);

const url = useStaging ? stagingUrl() : prodUrl();
const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 10 });

// Per-worker clocked PRODUCTION minutes in range (the Efficiency % denominator).
const prodHoursQ = sql`
  SELECT whe.workerId AS worker_id,
         SUM(whe.hours) * 60 AS prod_minutes
    FROM working_hour_entries whe
    JOIN departments d ON d.code = whe.departmentCode
   WHERE whe.date >= ${from} AND whe.date <= ${to}
     AND d.isProduction
   GROUP BY whe.workerId
`;

// jc_total_min mirrors src/api/routes/job-cards.ts exactly: FAB_CUT stores the
// per-set total (no ×wipQty), every other dept is per-unit (× wipQty).
const jcTotalMin = `CASE WHEN departmentCode = 'FAB_CUT'
      THEN COALESCE(productionTimeMinutes, 0)
      ELSE COALESCE(productionTimeMinutes, 0) * GREATEST(1, COALESCE(wipQty, 1)) END`;

// OLD numerator — ungated (pre-fix /summary), pic1 + pic2 union, halving.
const oldNumeratorQ = sql.unsafe(`
  SELECT wid AS worker_id, SUM(contrib_min) AS prod_minutes
    FROM (
      SELECT pic1Id AS wid,
             CASE WHEN pic2Id IS NOT NULL AND pic2Id != '' THEN (${jcTotalMin})/2.0 ELSE (${jcTotalMin}) END AS contrib_min
        FROM job_cards
       WHERE pic1Id IS NOT NULL AND pic1Id != '' AND status IN ('COMPLETED','TRANSFERRED')
         AND completedDate IS NOT NULL AND completedDate >= $1 AND completedDate <= $2
      UNION ALL
      SELECT pic2Id AS wid,
             CASE WHEN pic1Id IS NOT NULL AND pic1Id != '' THEN (${jcTotalMin})/2.0 ELSE (${jcTotalMin}) END AS contrib_min
        FROM job_cards
       WHERE pic2Id IS NOT NULL AND pic2Id != '' AND status IN ('COMPLETED','TRANSFERRED')
         AND completedDate IS NOT NULL AND completedDate >= $1 AND completedDate <= $2
    ) s
   WHERE wid IS NOT NULL AND wid != ''
   GROUP BY wid
`, [from, to]);

// NEW numerator — gated: the PIC must have a PRODUCTION working_hour_entry on
// the card's completedDate. This is the branch's /summary logic verbatim.
const gate = (pic) => `AND EXISTS (SELECT 1 FROM working_hour_entries whe
                JOIN departments d ON d.code = whe.departmentCode
               WHERE whe.workerId = job_cards.${pic}
                 AND whe.date = job_cards.completedDate
                 AND d.isProduction)`;
const newNumeratorQ = sql.unsafe(`
  SELECT wid AS worker_id, SUM(contrib_min) AS prod_minutes
    FROM (
      SELECT pic1Id AS wid,
             CASE WHEN pic2Id IS NOT NULL AND pic2Id != '' THEN (${jcTotalMin})/2.0 ELSE (${jcTotalMin}) END AS contrib_min
        FROM job_cards
       WHERE pic1Id IS NOT NULL AND pic1Id != '' AND status IN ('COMPLETED','TRANSFERRED')
         AND completedDate IS NOT NULL AND completedDate >= $1 AND completedDate <= $2
         ${gate("pic1Id")}
      UNION ALL
      SELECT pic2Id AS wid,
             CASE WHEN pic1Id IS NOT NULL AND pic1Id != '' THEN (${jcTotalMin})/2.0 ELSE (${jcTotalMin}) END AS contrib_min
        FROM job_cards
       WHERE pic2Id IS NOT NULL AND pic2Id != '' AND status IN ('COMPLETED','TRANSFERRED')
         AND completedDate IS NOT NULL AND completedDate >= $1 AND completedDate <= $2
         ${gate("pic2Id")}
    ) s
   WHERE wid IS NOT NULL AND wid != ''
   GROUP BY wid
`, [from, to]);

try {
  const [denom, oldNum, newNum, names] = await Promise.all([
    prodHoursQ,
    oldNumeratorQ,
    newNumeratorQ,
    sql`SELECT id, name FROM workers`,
  ]);
  const nameById = new Map(names.map((r) => [r.id, r.name]));
  const denomBy = new Map(denom.map((r) => [r.worker_id, Number(r.prod_minutes) || 0]));
  const oldBy = new Map(oldNum.map((r) => [r.worker_id, Number(r.prod_minutes) || 0]));
  const newBy = new Map(newNum.map((r) => [r.worker_id, Number(r.prod_minutes) || 0]));

  const ids = new Set([...denomBy.keys(), ...oldBy.keys(), ...newBy.keys()]);
  const rows = [];
  for (const id of ids) {
    const d = denomBy.get(id) ?? 0;
    const o = oldBy.get(id) ?? 0;
    const n = newBy.get(id) ?? 0;
    const effOld = d > 0 ? (o / d) * 100 : null;
    const effNew = d > 0 ? (n / d) * 100 : null;
    rows.push({ id, name: nameById.get(id) ?? id, d, o, n, effOld, effNew });
  }
  // Loudest efficiency movement first.
  rows.sort((a, b) => Math.abs((b.effOld ?? 0) - (b.effNew ?? 0)) - Math.abs((a.effOld ?? 0) - (a.effNew ?? 0)));

  const moved = rows.filter((r) => Math.round(r.effOld ?? -1) !== Math.round(r.effNew ?? -1));
  const inflatedOld = rows.filter((r) => (r.effOld ?? 0) > 100);
  const inflatedNew = rows.filter((r) => (r.effNew ?? 0) > 100);

  console.log(`\nEfficiency day-gate check — ${useStaging ? "STAGING" : "PROD"} — ${from} … ${to}`);
  console.log(`workers with any figure: ${rows.length}`);
  console.log(`efficiency MOVED (rounded %): ${moved.length}`);
  console.log(`>100% BEFORE gate: ${inflatedOld.length}   >100% AFTER gate: ${inflatedNew.length}`);
  console.log("\n  worker                         prodHrs   OLD%    NEW%   Δ");
  console.log("  " + "-".repeat(62));
  for (const r of moved.slice(0, 40)) {
    const fmtH = (m) => (m / 60).toFixed(1).padStart(6);
    const fmtP = (p) => (p == null ? "  —  " : p.toFixed(0).padStart(5));
    const delta = (r.effOld != null && r.effNew != null) ? (r.effNew - r.effOld).toFixed(0).padStart(5) : "  —  ";
    console.log(`  ${(r.name).slice(0, 28).padEnd(28)} ${fmtH(r.d)}  ${fmtP(r.effOld)}  ${fmtP(r.effNew)}  ${delta}`);
  }
  if (moved.length === 0) {
    console.log("  (no worker's rounded Efficiency % changed — this range is fully entered; gate is a no-op here.)");
  }
  console.log("");
} finally {
  await sql.end({ timeout: 5 });
}
