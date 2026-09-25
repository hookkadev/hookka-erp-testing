// ---------------------------------------------------------------------------
// measure-sequence-lock-no-branch.mjs — PRD T-013 R16, read-only.
//
// The sequence lock reads `job_cards.branch_key`, which `bom-wip-breakdown.ts`
// stamps from the BOM tree. A card with an EMPTY branch key is treated as a
// convergence step. That is right for UPHOLSTERY / PACKING on a sofa — but a
// product whose cards ALL carry an empty branch key (older builds, BOMs with
// no branch structure) collapses to one strictly linear chain by `sequence`,
// and if that product really has parallel branches, wood will wait for fabric.
//
// This measures how much of that exists on production TODAY, so the answer is
// a number and not a guess:
//
//   · how many (order, wipKey) groups have no branch information at all;
//   · how many OPEN cards in those groups the lock would refuse right now;
//   · which department pairs those refusals are (blocked ← must finish first),
//     so a wrong pair — e.g. WOOD_CUT waiting on FAB_SEW — is visible by name;
//   · the same figures for groups WITH branch information, for comparison.
//
// It writes nothing. It reads job cards of orders that are not finished.
//
// USAGE
//   export HOOKKA_PROD_DB_URL='postgresql://...'   (see scripts/_db.mjs)
//   node --import tsx/esm scripts/measure-sequence-lock-no-branch.mjs [--limit 40]
// ---------------------------------------------------------------------------
import postgres from "postgres";
import { prodUrl } from "./_db.mjs";
import { sequenceBlockers } from "../src/api/lib/sequence-lock.ts";

const argv = process.argv.slice(2);
const limitIdx = argv.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(argv[limitIdx + 1] || 40) : 40;

const DONE = new Set(["COMPLETED", "TRANSFERRED"]);
const DEAD = new Set(["CANCELLED"]);
const up = (s) => String(s ?? "").toUpperCase();

// `prepare: false` so the SAME url works whether it is the direct connection
// (db.<ref>.supabase.co:5432) or the pooler (…pooler.supabase.com:6543).
// Supavisor in transaction mode rejects prepared statements — the same
// footgun as BUG-2026-04-27-029. This script only reads, so either is fine.
const sql = postgres(prodUrl(), {
  ssl: "require",
  max: 1,
  idle_timeout: 5,
  prepare: false,
});

try {
  const jcs = await sql`
    SELECT jc.id, jc.production_order_id AS "productionOrderId",
           jc.department_code AS "departmentCode", jc.sequence, jc.status,
           jc.wip_key AS "wipKey", jc.branch_key AS "branchKey"
      FROM job_cards jc
      JOIN production_orders po ON po.id = jc.production_order_id
     WHERE po.status NOT IN ('COMPLETED', 'TRANSFERRED', 'CANCELLED')`;

  const byPo = new Map();
  for (const jc of jcs) {
    const list = byPo.get(jc.productionOrderId) ?? [];
    list.push(jc);
    byPo.set(jc.productionOrderId, list);
  }

  // One bucket per (order, wipKey): the unit the rule reasons over.
  const stats = {
    noBranch: { groups: 0, cards: 0, open: 0, blocked: 0, pairs: new Map(), samples: [] },
    branched: { groups: 0, cards: 0, open: 0, blocked: 0, pairs: new Map(), samples: [] },
  };

  for (const [poId, cards] of byPo) {
    const byWip = new Map();
    for (const c of cards) {
      const k = String(c.wipKey ?? "");
      const list = byWip.get(k) ?? [];
      list.push(c);
      byWip.set(k, list);
    }
    for (const [wipKey, group] of byWip) {
      const hasBranch = group.some((c) => String(c.branchKey ?? "").trim() !== "");
      const s = hasBranch ? stats.branched : stats.noBranch;
      s.groups += 1;
      s.cards += group.length;
      for (const card of group) {
        const st = up(card.status);
        if (DONE.has(st) || DEAD.has(st)) continue;
        s.open += 1;
        const blockers = sequenceBlockers(card, cards).filter(
          (b) => !DONE.has(up(b.status)) && !DEAD.has(up(b.status)),
        );
        if (blockers.length === 0) continue;
        s.blocked += 1;
        for (const b of blockers) {
          const key = `${card.departmentCode} <- ${b.departmentCode}`;
          s.pairs.set(key, (s.pairs.get(key) ?? 0) + 1);
        }
        if (s.samples.length < LIMIT) {
          s.samples.push({
            poId,
            wipKey,
            dept: card.departmentCode,
            seq: card.sequence,
            waitsOn: blockers.map((b) => `${b.departmentCode}@${b.sequence}`).join(", "),
          });
        }
      }
    }
  }

  const pct = (n, d) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
  const report = (label, s) => {
    console.log(`\n${label}`);
    console.log(`  (order, wipKey) groups  : ${s.groups}`);
    console.log(`  cards                   : ${s.cards}`);
    console.log(`  open cards              : ${s.open}`);
    console.log(`  open cards blocked now  : ${s.blocked}  (${pct(s.blocked, s.open)} of open)`);
    const pairs = [...s.pairs.entries()].sort((a, b) => b[1] - a[1]);
    if (pairs.length) {
      console.log(`  blocked <- must finish first   count`);
      for (const [k, n] of pairs.slice(0, 25)) console.log(`    ${k.padEnd(28)} ${n}`);
      if (pairs.length > 25) console.log(`    … and ${pairs.length - 25} more pairs`);
    }
  };

  console.log(`Sequence lock — over-blocking measurement (read-only)`);
  console.log(`  job cards read (unfinished orders) : ${jcs.length}`);
  console.log(`  production orders                  : ${byPo.size}`);
  report("Groups WITH branch information (the normal case)", stats.branched);
  report("Groups with NO branch information (every card branch_key empty)", stats.noBranch);

  if (stats.noBranch.samples.length) {
    console.log(`\n  First ${stats.noBranch.samples.length} no-branch refusals (--limit to change):`);
    for (const x of stats.noBranch.samples) {
      console.log(
        `    PO ${x.poId}  wip ${x.wipKey || "(blank)"}  ${String(x.dept).padEnd(12)} seq ${x.seq}  waits on ${x.waitsOn}`,
      );
    }
  }

  // The pairs the 2026-09-06 plan called WRONG under a flat order. If they
  // show up in the no-branch bucket, that bucket is over-blocked and the
  // fix is to stamp branch_key on those cards, not to change the rule.
  const wrong = ["WOOD_CUT <- FAB_SEW", "FRAMING <- FAB_SEW", "WEBBING <- FAB_SEW", "WOOD_CUT <- FAB_CUT", "FRAMING <- FAB_CUT"];
  const hits = wrong.filter((k) => stats.noBranch.pairs.has(k));
  console.log(
    hits.length
      ? `\n  Wood-waits-for-fabric pairs present in the no-branch bucket: ${hits.map((k) => `${k} (${stats.noBranch.pairs.get(k)})`).join(", ")}`
      : `\n  No wood-waits-for-fabric pair in the no-branch bucket.`,
  );
} finally {
  await sql.end();
}
