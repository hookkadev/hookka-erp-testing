// ---------------------------------------------------------------------------
// Pay-rule versions — storage + loader.
//
// Columns are deliberately ALL-LOWERCASE: runtime DDL goes through the
// d1-compat adapter whose identifier rewrite only knows the static rename map,
// so unknown camelCase identifiers get folded to lowercase by Postgres anyway
// (BUG-2026-06-11-007). Naming them lowercase from the start keeps DDL, DML
// and SELECT * keys identical — no dual-key reads needed.
// ---------------------------------------------------------------------------
import {
  type PayRuleVersion,
  type PayRulesConfig,
  normalizePayRules,
  resolvePayRulesAsOf,
} from "../../lib/pay-rules";

let _mig = false;
export async function ensurePayRuleVersions(db: D1Database): Promise<void> {
  if (_mig) return;

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS pay_rule_versions (
         id TEXT PRIMARY KEY,
         effectivefrom TEXT NOT NULL,
         rulesjson TEXT NOT NULL,
         note TEXT,
         createdat TEXT,
         createdby TEXT
       )`,
    )
    .run();
  // A failed seed is retried on the next call (the flag stays unset) but never
  // breaks the caller: every pay screen loads versions through here.
  try {
    await seedHoursOnlyRule(db);
  } catch (e) {
    console.error("[pay-rules] hours-only seed failed, retried on the next call:", e);
    return;
  }
  _mig = true;
}

type Row = {
  id: string;
  effectivefrom: string;
  rulesjson: string;
  note: string | null;
  createdat: string | null;
  createdby: string | null;
};

function toVersion(r: Row): PayRuleVersion {
  let raw: unknown = {};
  try {
    raw = JSON.parse(r.rulesjson || "{}");
  } catch {
    raw = {};
  }
  return {
    id: r.id,
    effectiveFrom: r.effectivefrom,
    rules: normalizePayRules(raw),
    createdAt: r.createdat ?? undefined,
    createdBy: r.createdby ?? null,
    note: r.note ?? null,
  };
}

// Owner ruling 2026-10-08: the hourly rate is day rate ÷ working hours, lunch
// NOT counted (÷26 ÷ 9). The saved 2026-07-01 rule says "hours + lunch" (÷10),
// and a saved rule beats the code default, so the ruling has to be a dated
// rule of its own. It is written once, from 2026-10-01 (October was not paid
// yet; September and earlier keep ÷10), as an ordinary row that the Pay Rules
// panel lists with this note. Once it exists this is a no-op: a later change
// is a newer scheduled rule, never an edit here. BUG-2026-10-08-269.
export const HOURS_ONLY_SEED = {
  id: "prv-owner-20261008-hours-only",
  effectiveFrom: "2026-10-01",
  note: "Owner ruling 2026-10-08: hourly rate = day rate ÷ working hours, lunch not counted. Added automatically on deploy.",
  createdBy: "system",
} as const;

/** The rules the seed writes: whatever is in force on its date (grace, blocks,
 *  multipliers, statutory rates all kept), with only the hour divisor switched
 *  to hours-only. Null when hours-only is already the rule on that date. */
export function hoursOnlySeedRules(versions: PayRuleVersion[]): PayRulesConfig | null {
  const inForce = resolvePayRulesAsOf(versions, HOURS_ONLY_SEED.effectiveFrom);
  if (inForce.hourRateDivisorMode === "hoursOnly") return null;
  return { ...inForce, hourRateDivisorMode: "hoursOnly" };
}

export async function seedHoursOnlyRule(db: D1Database): Promise<void> {
  // Read through a batch, not a plain SELECT: this decides pay, and Hyperdrive
  // serves a plain SELECT from its cache (BUG-CLASSES C29).
  const stmt = db.prepare("SELECT * FROM pay_rule_versions");
  const batch = (db as { batch?: D1Database["batch"] }).batch;
  const rows =
    typeof batch === "function"
      ? (((await db.batch([stmt]))[0]?.results ?? []) as Row[])
      : ((await stmt.all<Row>()).results ?? []);
  const rules = hoursOnlySeedRules(rows.map(toVersion));
  if (!rules) return;
  const res = await db
    .prepare(
      `INSERT INTO pay_rule_versions (id, effectivefrom, rulesjson, note, createdat, createdby)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
    )
    .bind(
      HOURS_ONLY_SEED.id,
      HOURS_ONLY_SEED.effectiveFrom,
      JSON.stringify(rules),
      HOURS_ONLY_SEED.note,
      new Date().toISOString(),
      HOURS_ONLY_SEED.createdBy,
    )
    .run();
  if ((res.meta?.changes ?? 0) === 0) return;
  console.log(`[pay-rules] seeded ${HOURS_ONLY_SEED.id}: hours-only from ${HOURS_ONLY_SEED.effectiveFrom}`);
  // Every pay_rule_versions write wipes the worker pay snapshots (see
  // routes/pay-rules.ts). The table is global, so every org's rows go.
  for (const table of ["worker_payslips_snapshot", "worker_history_snapshot"]) {
    try {
      await db.prepare(`DELETE FROM ${table}`).run();
    } catch (e) {
      console.warn(`[pay-rules] ${table} wipe after the seed failed:`, e);
    }
  }
}

/** All versions, defaults-normalised, unsorted. Resilient: any failure →
 *  empty list → every consumer falls back to DEFAULT_PAY_RULES. */
export async function loadPayRuleVersions(
  db: D1Database,
): Promise<PayRuleVersion[]> {
  try {
    await ensurePayRuleVersions(db);
    const res = await db
      .prepare("SELECT * FROM pay_rule_versions")
      .all<Row>();
    return (res.results ?? []).map(toVersion);
  } catch (e) {
    console.warn("[pay-rules] load skipped (defaults apply):", e);
    return [];
  }
}
