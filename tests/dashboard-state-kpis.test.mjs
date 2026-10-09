// ---------------------------------------------------------------------------
// dashboard-state-kpis.test.mjs — Pending Delivery and Outstanding saved daily
// so a finished month shows its own figure (owner 2026-10-09).
//
//   1. Both writers MERGE into the same day's row, in either order: the state
//      capture (backlog etc.) must not wipe the KPI keys, and back.
//   2. A month reads each KPI part from the latest day that saved it, and the
//      state read skips a day that holds only KPI keys.
//   3. stateKpiTile: past month = saved figure or "no record", never live.
//   4. The three endpoints save only an unscoped whole-company total.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  writeStateSnapshot,
  writeStateKpis,
  readStateSnapshotForMonth,
  readStateKpisForMonth,
} from "../src/api/lib/dashboard-state-snapshot.ts";
import { stateKpiTile } from "../src/pages/dashboards/dashboard-widgets-lib.ts";

// Fake DB that applies Postgres's jsonb `||` (shallow merge, right side wins)
// only when the SQL asks for it, so a writer that REPLACES fails test 1.
function fakeDb() {
  const rows = new Map(); // `${org}|${date}` -> { data, snapDate }
  return {
    rows,
    prepare(sql) {
      const stmt = {
        args: [],
        bind(...a) { stmt.args = a; return stmt; },
        async run() {
          assert.match(sql, /INSERT INTO dashboard_state_snapshots/);
          const merge = /data\s*=\s*dashboard_state_snapshots\.data \|\| EXCLUDED\.data/.test(sql);
          const [org, date] = stmt.args;
          const dataArg = stmt.args.find((a) => typeof a === "string" && a.startsWith("{"));
          const incoming = JSON.parse(dataArg);
          const k = `${org}|${date}`;
          const prev = rows.get(k);
          rows.set(k, { snapDate: date, data: prev && merge ? { ...prev.data, ...incoming } : incoming });
          return {};
        },
        async all() {
          const [org, from, to] = stmt.args;
          const results = [...rows.entries()]
            .filter(([k, r]) => k.startsWith(`${org}|`) && r.snapDate >= from && r.snapDate < to)
            .map(([, r]) => ({ snapDate: r.snapDate, data: JSON.stringify(r.data), capturedAt: "x" }))
            .sort((a, b) => b.snapDate.localeCompare(a.snapDate));
          return { results };
        },
      };
      return stmt;
    },
  };
}

const today = new Date().toISOString().slice(0, 10);
const thisMonth = today.slice(0, 7);
const STATE = {
  backlogMin: 100, backlogDays: 2, backlogByDept: [], backlogGrandMin: 100,
  activeJobs: { bedframeUnits: 1, sofaSets: 2, byCustomer: [] }, activeHeadcount: 30,
};

test("state capture and KPI saves merge into one day's row, either order", async () => {
  for (const order of ["state-first", "kpi-first"]) {
    const db = fakeDb();
    const state = () => writeStateSnapshot(db, "org1", today, STATE);
    const kpi = () => writeStateKpis(db, "org1", { outstandingItemsSen: 500 });
    if (order === "state-first") { await state(); await kpi(); } else { await kpi(); await state(); }
    const row = db.rows.get(`org1|${today}`).data;
    assert.equal(row.backlogGrandMin, 100, order);
    assert.equal(row.outstandingItemsSen, 500, order);
  }
});

test("a month reads each part from its latest saved day; state skips KPI-only days", async () => {
  const db = fakeDb();
  const put = (date, data) => db.rows.set(`org1|${date}`, { snapDate: date, data });
  put("2026-09-28", { ...STATE, pendingDeliveryValueSen: 1, pendingDispatchSen: 2, inTransitSen: 3, outstandingItemsSen: 40 });
  put("2026-09-29", { ...STATE, backlogGrandMin: 999, outstandingItemsSen: 50 });
  put("2026-09-30", { pendingDeliveryValueSen: 10 }); // KPI-only day
  const k = await readStateKpisForMonth(db, "org1", "2026-09");
  assert.equal(k.outstandingSen, 50);
  assert.equal(k.pendingDeliverySen, 10 + 2 + 3);
  assert.equal(k.asOf, "2026-09-30");
  const s = await readStateSnapshotForMonth(db, "org1", "2026-09");
  assert.equal(s.snapDate, "2026-09-29");
  assert.equal(s.metrics.backlogGrandMin, 999);
});

test("Pending Delivery is null unless all three parts were saved", async () => {
  const db = fakeDb();
  db.rows.set("org1|2026-09-30", { snapDate: "2026-09-30", data: { pendingDeliveryValueSen: 10, outstandingItemsSen: 7 } });
  const k = await readStateKpisForMonth(db, "org1", "2026-09");
  assert.equal(k.pendingDeliverySen, null);
  assert.equal(k.outstandingSen, 7);
  const none = await readStateKpisForMonth(db, "org1", "2026-08");
  assert.deepEqual(none, { pendingDeliverySen: null, outstandingSen: null, asOf: null });
});

test("stateKpiTile: a finished month never shows the live figure", () => {
  assert.deepEqual(stateKpiTile("all", 5, "2026-09-30", 99, "2026-10"), { sen: 99, tag: "live", past: false });
  assert.deepEqual(stateKpiTile("2026-10", 5, "2026-10-08", 99, "2026-10"), { sen: 99, tag: "live", past: false });
  assert.deepEqual(stateKpiTile("2026-09", 5, "2026-09-30", 99, "2026-10"), { sen: 5, tag: "as of 2026-09-30", past: true });
  assert.deepEqual(stateKpiTile("2026-09", null, null, 99, "2026-10"), { sen: null, tag: "no record", past: true });
  assert.ok(thisMonth.length === 7);
});

const read = (rel) => readFileSync(rel, "utf8").replace(/\r\n/g, "\n");

test("endpoints save only whole-company totals", () => {
  const dor = read("src/api/routes/delivery-orders.ts");
  assert.match(dor, /if \(!pvPoScope\.clause && !pvSoScope\.clause\) \{\n\s+saveStateKpisLater\(c, getOrgId\(c\), \{ pendingDeliveryValueSen \}\);/);
  assert.match(dor, /if \(!statsScope\.clause\) saveStateKpisLater\(c, orgId, dispatchKpis\(valueByStatus\)\);/);
  // the snapshot-hit save sits inside the `if (!statsScope.clause)` read block
  assert.match(dor, /if \(!statsScope\.clause\) \{\n[\s\S]{0,700}saveStateKpisLater\(c, orgId, dispatchKpis\(snap\.data\.valueByStatus/);
  const sor = read("src/api/routes/sales-orders.ts");
  // scoped and Service Order calls return before the save
  assert.match(sor, /if \(serviceOrderFilter !== "false" \|\| scope\.clause\) \{\n\s+return c\.json/);
  assert.match(sor, /if \(c\.req\.query\("isStock"\) !== "all"\) \{\n\s+saveStateKpisLater\(c, orgId, \{ outstandingItemsSen:/);
});

test("all three screens route the two tiles through stateKpiTile", () => {
  for (const f of ["src/pages/dashboard-b/index.tsx", "src/pages/m/screens/Home.tsx", "src/pages/dashboards/DashboardWidgets.tsx"]) {
    const src = read(f);
    assert.equal((src.match(/stateKpiTile\(/g) ?? []).length, 2, f);
  }
  assert.doesNotMatch(read("src/pages/dashboard-b/index.tsx"), /tag="live"/);
});
