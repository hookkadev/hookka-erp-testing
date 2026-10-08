// ---------------------------------------------------------------------------
// pay-rule-hours-only-seed.test.mjs — the one-time "hours only from
// 2026-10-01" pay rule (owner ruling 2026-10-08, BUG-2026-10-08-269).
//
// The seed must copy the rules in force on 2026-10-01 and change ONLY the hour
// divisor: the 2026-07-01 rule carries HR's corrections (grace 15, late block
// 1, OT floor 15, a 1-working-day absence grace where the default is 2), and
// a seed built from the defaults would silently undo them.
// It must write once, and clear the worker pay snapshots when it does.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* native type-stripping on Node 22+ */
}

const pr = await import(pathToFileURL(resolve(process.cwd(), "src/lib/pay-rules.ts")).href);
const store = await import(pathToFileURL(resolve(process.cwd(), "src/api/lib/pay-rules-store.ts")).href);

// The 2026-07-01 rule as shown in the Pay Rules panel: hours + lunch, with
// HR's corrections. absenceGraceWorkingDays 1 is the field that differs from
// the defaults, so it is the one that proves the seed copies, not resets.
const JULY = {
  ...pr.DEFAULT_PAY_RULES,
  hourRateDivisorMode: "hoursPlusLunch",
  lateGraceMin: 15,
  lateBlockMin: 1,
  otBlockMin: 15,
  absenceGraceWorkingDays: 1,
};
const julyRow = {
  id: "prv-july",
  effectivefrom: "2026-07-01",
  rulesjson: JSON.stringify(JULY),
  note: "HR correction",
  createdat: "2026-07-01T00:00:00Z",
  createdby: null,
};

// In-memory stand-in for the pay_rule_versions table and the two snapshots.
function fakeDb(rows) {
  const log = { inserts: 0, wiped: [] };
  const stmt = (sql) => ({
    args: [],
    bind(...a) { this.args = a; return this; },
    async all() { return { results: rows.map((r) => ({ ...r })) }; },
    async run() {
      if (sql.startsWith("INSERT")) {
        const [id, effectivefrom, rulesjson, note, createdat, createdby] = this.args;
        if (rows.some((r) => r.id === id)) return { meta: { changes: 0 } };
        rows.push({ id, effectivefrom, rulesjson, note, createdat, createdby });
        log.inserts++;
        return { meta: { changes: 1 } };
      }
      if (sql.startsWith("DELETE FROM")) log.wiped.push(sql.slice("DELETE FROM ".length));
      return { meta: { changes: 0 } };
    },
  });
  return {
    rows,
    log,
    prepare: stmt,
    async batch(stmts) { return Promise.all(stmts.map((s) => s.all())); },
  };
}

test("seed copies the rules in force on 2026-10-01 and changes only the hour divisor", () => {
  const versions = [{ id: "prv-july", effectiveFrom: "2026-07-01", rules: pr.normalizePayRules(JULY) }];
  const rules = store.hoursOnlySeedRules(versions);
  assert.equal(rules.hourRateDivisorMode, "hoursOnly");
  assert.equal(rules.lateGraceMin, 15);
  assert.equal(rules.lateBlockMin, 1);
  assert.equal(rules.otBlockMin, 15);
  assert.equal(rules.absenceGraceWorkingDays, 1); // the default is 2
  assert.deepEqual({ ...rules, hourRateDivisorMode: "hoursPlusLunch" }, pr.normalizePayRules(JULY));
});

test("seed is not needed when hours-only is already the rule on 2026-10-01", () => {
  const versions = [
    { id: "prv-july", effectiveFrom: "2026-07-01", rules: pr.normalizePayRules(JULY) },
    { id: "prv-hand", effectiveFrom: "2026-09-15", rules: pr.normalizePayRules({ ...JULY, hourRateDivisorMode: "hoursOnly" }) },
  ];
  assert.equal(store.hoursOnlySeedRules(versions), null);
});

test("no saved rules: the seed is the defaults with hours only", () => {
  assert.deepEqual(store.hoursOnlySeedRules([]), { ...pr.DEFAULT_PAY_RULES, hourRateDivisorMode: "hoursOnly" });
});

test("seed writes one row dated 2026-10-01, once, and wipes the pay snapshots only then", async () => {
  const db = fakeDb([julyRow]);
  await Promise.all([store.seedHoursOnlyRule(db), store.seedHoursOnlyRule(db)]); // two isolates at once
  await store.seedHoursOnlyRule(db); // a later boot
  assert.equal(db.log.inserts, 1);
  assert.deepEqual(db.log.wiped, ["worker_payslips_snapshot", "worker_history_snapshot"]);
  const seeded = db.rows.find((r) => r.id === store.HOURS_ONLY_SEED.id);
  assert.equal(seeded.effectivefrom, "2026-10-01");
  assert.equal(JSON.parse(seeded.rulesjson).hourRateDivisorMode, "hoursOnly");
  assert.match(seeded.note, /Owner ruling 2026-10-08/);
});

test("after the seed: September keeps ÷10, October pays the owner's ÷9 (RM 2,050, 2h OT = RM 26.28)", async () => {
  const db = fakeDb([julyRow]);
  await store.seedHoursOnlyRule(db);
  const versions = db.rows.map((r) => ({ id: r.id, effectiveFrom: r.effectivefrom, rules: pr.normalizePayRules(JSON.parse(r.rulesjson)) }));
  assert.equal(pr.resolvePayRulesAsOf(versions, "2026-09-30").hourRateDivisorMode, "hoursPlusLunch");
  const oct = pr.resolvePayRulesAsOf(versions, "2026-10-01");
  const rate = pr.payrollHourRateSen(205_000 / 26, 9, oct);
  assert.equal(rate, 876);
  assert.equal(Math.round(2 * rate * 1.5), 2_628);
});
