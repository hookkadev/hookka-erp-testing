// fill-zero-minutes (BUG-2026-10-05-256): job cards still at 0 minutes get
// the minutes of the CURRENT BOM; cards with minutes are never touched.
//
// Part 1 pins the matching rule (bomMinutesForCard). Part 2 drives the real
// POST /fill-zero-minutes handler against a fake DB that records every query
// and write: what is selected, what is written, what is skipped and why.
// Run: node --import tsx/esm --test tests/fill-zero-minutes.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import app, { bomMinutesForCard } from "../src/api/routes/jobcard-sync.ts";
import { breakBomIntoWips } from "../src/api/lib/bom-wip-breakdown.ts";

// ---- Part 1: matching rule -------------------------------------------------

const expected = [
  { wipKey: "A02::0::SOFA_ARMREST::{PRODUCT_CODE} {FABRIC}", deptCode: "FAB_SEW", estMinutes: 30 },
  { wipKey: "A02::0::SOFA_ARMREST::{PRODUCT_CODE} {FABRIC}", deptCode: "FAB_CUT", estMinutes: 15 },
  { wipKey: "A02::1::SOFA_ARMREST::x", deptCode: "FAB_CUT", estMinutes: 5 },
  { wipKey: "FG", deptCode: "PACKING", estMinutes: 10 },
];

test("TC-01 merged Fab Cut card gets the sum of its PO's Fab Cut steps", () => {
  const card = { wipKey: "pord-1::A02::COVE-05::FAB_CUT", deptCode: "FAB_CUT", poId: "pord-1" };
  assert.deepEqual(bomMinutesForCard(card, expected), { minutes: 20 });
});

test("TC-02 sofa Fab Cut merge spans several POs and is skipped", () => {
  const card = { wipKey: "so-9::5531::COVE-05::FAB_CUT", deptCode: "FAB_CUT", poId: "pord-1" };
  assert.deepEqual(bomMinutesForCard(card, expected), { skip: "sofaFabCutMerge" });
});

test("TC-03 other cards match on wipKey + dept, including FG L1 cards", () => {
  const sew = { wipKey: "A02::0::SOFA_ARMREST::{PRODUCT_CODE} {FABRIC}", deptCode: "FAB_SEW", poId: "pord-1" };
  assert.deepEqual(bomMinutesForCard(sew, expected), { minutes: 30 });
  assert.deepEqual(bomMinutesForCard({ wipKey: "FG", deptCode: "PACKING", poId: "pord-1" }, expected), { minutes: 10 });
});

test("TC-04 a dept the BOM no longer has is skipped, not guessed", () => {
  const card = { wipKey: "FG", deptCode: "WOOD_CUT", poId: "pord-1" };
  assert.deepEqual(bomMinutesForCard(card, expected), { skip: "noMatch" });
});

// ---- Part 2: the endpoint against a fake DB --------------------------------

// A02 as it is set up on prod: armrest tree (Upholstery > Sew > Fab Cut,
// Foam), Packing on the L1 tab. 1005-(Q): Foam step still at 0 minutes.
const BOMS = {
  A02: {
    wipComponents: JSON.stringify([
      {
        wipCode: "{PRODUCT_CODE} {FABRIC}",
        wipType: "SOFA_ARMREST",
        processes: [{ deptCode: "UPHOLSTERY", category: "", minutes: 15 }],
        children: [
          {
            wipCode: "{PRODUCT_CODE} {FABRIC}",
            wipType: "SOFA_ARMREST",
            processes: [{ deptCode: "FAB_SEW", category: "", minutes: 30 }],
            children: [
              {
                wipCode: "{PRODUCT_CODE} {FABRIC} (FC)",
                wipType: "SOFA_ARMREST",
                processes: [{ deptCode: "FAB_CUT", category: "", minutes: 15 }],
              },
            ],
          },
        ],
      },
    ]),
    l1Processes: JSON.stringify([{ deptCode: "PACKING", category: "", minutes: 10 }]),
    baseModel: "A02",
  },
  "1005-(Q)": {
    wipComponents: JSON.stringify([
      { wipCode: "{PRODUCT_CODE} (FOAM)", wipType: "HEADBOARD", processes: [{ deptCode: "FOAM", category: "", minutes: 0 }] },
    ]),
    l1Processes: null,
    baseModel: "1005",
  },
};
const keyOf = (code) => breakBomIntoWips(BOMS[code].wipComponents, code, null)[0].wipKey;

const po = (id, productCode, itemCategory = "ACCESSORY") => ({
  id, salesOrderId: "so-1", productCode, itemCategory, quantity: 1, currentDepartment: null,
  targetEndDate: null, startDate: null, sizeCode: "", sizeLabel: "", fabricCode: "COVE-05",
  gapInches: null, divanHeightInches: null, legHeightInches: null,
});
const card = (jcId, p, deptCode, wipKey, over = {}) => ({
  ...p, jcId, wipKey, deptCode, status: "WAITING", completedDate: null, poNo: `SO-${jcId}`, ...over,
});

const PO_A02 = po("pord-1", "A02");
const ZERO_CARDS = [
  card("fc", PO_A02, "FAB_CUT", "pord-1::A02::COVE-05::FAB_CUT"), // 15
  card("sew", PO_A02, "FAB_SEW", keyOf("A02")), // 30
  card("pack", PO_A02, "PACKING", "FG"), // 10, from the L1 tab
  card("done", PO_A02, "UPHOLSTERY", keyOf("A02"), { status: "COMPLETED", completedDate: "2026-09-12" }), // 15
  card("wood", PO_A02, "WOOD_CUT", "FG"), // dept not in BOM
  card("sofa", po("pord-2", "A02", "SOFA"), "FAB_CUT", "so-1::5531::COVE-05::FAB_CUT"), // cross-PO merge
  card("foam", po("pord-3", "1005-(Q)", "BEDFRAME"), "FOAM", keyOf("1005-(Q)")), // BOM still 0
];

function makeDb(zeroCards = ZERO_CARDS) {
  const selects = [];
  const writes = [];
  function prepare(sql) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    let bound = [];
    const rows = () => {
      if (/FROM bom_templates/.test(s)) return BOMS[bound[0]] ? [BOMS[bound[0]]] : [];
      if (/FROM job_cards jc JOIN production_orders/.test(s)) return zeroCards;
      return [];
    };
    const stmt = {
      bind(...a) { bound = a; return stmt; },
      async first() { return rows()[0] ?? null; },
      async all() {
        if (/FROM job_cards jc/.test(s)) selects.push({ sql: s, bound });
        return { results: rows() };
      },
      async run() { writes.push({ sql: s, bound }); return { success: true }; },
      __record() { writes.push({ sql: s, bound }); },
    };
    return stmt;
  }
  return {
    selects,
    writes,
    db: { prepare, async batch(stmts) { for (const st of stmts) st.__record?.(); return []; } },
  };
}

async function call(db, query = "", role = "SUPER_ADMIN") {
  const parent = new Hono();
  parent.use("*", async (c, next) => {
    c.set("DB", db);
    c.set("orgId", "hookka");
    c.set("userRole", role);
    c.set("userId", "user-1");
    await next();
  });
  parent.route("/", app);
  const res = await parent.request(`/fill-zero-minutes${query}`, { method: "POST" });
  return { status: res.status, body: await res.json() };
}

test("TC-05 dry run lists what would change and writes nothing", async () => {
  const f = makeDb();
  const { status, body } = await call(f.db, "?dryRun=true&completedFrom=2026-09-01");
  assert.equal(status, 200);
  assert.equal(body.dryRun, true);
  assert.equal(f.writes.length, 0, "a dry run must not write");
  const got = Object.fromEntries(body.fills.map((x) => [x.jcId, x.minutes]));
  assert.deepEqual(got, { fc: 15, sew: 30, pack: 10, done: 15 });
  assert.equal(body.toFill, 4);
  assert.equal(body.toFillCompleted, 1);
  assert.deepEqual(body.skipped, { bomZero: 1, noMatch: 1, sofaFabCutMerge: 1 });
});

test("TC-06 the screenshot case: A02 merged Fab Cut card at 0 becomes 15", async () => {
  const f = makeDb([ZERO_CARDS[0]]);
  const { body } = await call(f.db, "?dryRun=true");
  assert.equal(body.fills[0].deptCode, "FAB_CUT");
  assert.equal(body.fills[0].minutes, 15);
});

test("TC-07 live run writes only the fillable cards, each guarded and audited", async () => {
  const f = makeDb();
  const { status, body } = await call(f.db, "?completedFrom=2026-09-01");
  assert.equal(status, 200);
  assert.equal(body.updated, 4);
  const updates = f.writes.filter((w) => /^UPDATE job_cards/.test(w.sql));
  assert.deepEqual(
    updates.map((u) => u.bound),
    [[15, 15, "fc"], [30, 30, "sew"], [10, 10, "pack"], [15, 15, "done"]],
  );
  for (const u of updates) {
    assert.match(u.sql, /SET productionTimeMinutes = \?, estMinutes = \?/);
    assert.match(u.sql, /WHERE id = \? AND COALESCE\(productionTimeMinutes, 0\) = 0/,
      "a card that got minutes after the SELECT must be left alone");
  }
  const audits = f.writes.filter((w) => /INSERT INTO audit_events/.test(w.sql));
  assert.equal(audits.length, 4, "every filled card gets an audit row");
  assert.ok(audits.every((a) => a.bound.includes("fill-zero-minutes-from-bom")));
  for (const id of ["wood", "sofa", "foam"]) {
    assert.ok(!updates.some((u) => u.bound.includes(id)), `${id} must not be written`);
  }
});

test("TC-08 only cards at 0 are selected; without completedFrom, completed cards are out", async () => {
  const f = makeDb();
  await call(f.db, "?dryRun=true");
  const sel = f.selects[0];
  assert.match(sel.sql, /COALESCE\(jc\.productionTimeMinutes, 0\) = 0/);
  assert.match(sel.sql, /jc\.status NOT IN \('COMPLETED','TRANSFERRED'\)/);
  assert.doesNotMatch(sel.sql, /completedDate >=/);
  assert.deepEqual(sel.bound, []);
});

test("TC-09 completedFrom adds completed cards finished on or after that date", async () => {
  const f = makeDb();
  await call(f.db, "?dryRun=true&completedFrom=2026-09-01");
  const sel = f.selects[0];
  assert.match(sel.sql, /OR jc\.completedDate >= \?/);
  assert.deepEqual(sel.bound, ["2026-09-01"]);
});

test("TC-10 a malformed completedFrom is refused before any query", async () => {
  const f = makeDb();
  const { status } = await call(f.db, "?dryRun=true&completedFrom=Sep");
  assert.equal(status, 400);
  assert.equal(f.selects.length, 0);
});

test("TC-11 a role without production-orders:update is refused and nothing runs", async () => {
  const f = makeDb();
  const { status } = await call(f.db, "?dryRun=true", "SALES");
  assert.equal(status, 403);
  assert.equal(f.selects.length, 0);
  assert.equal(f.writes.length, 0);
});
