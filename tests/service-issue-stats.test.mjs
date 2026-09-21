// service-issue-stats.test.mjs — pure aggregation behind the dashboard's Service
// "Top issues" sub-tab: multi-cause counting, "Not yet analysed", days-to-close
// averaging, empty input, top products, and the row parsers.
import test from "node:test";
import assert from "node:assert/strict";
import {
  NONE_KEY, byCause, byUnit, byPrevention, topProducts, causeTrend, parseCauses, parseProductLabels,
} from "../src/api/lib/service-issue-stats.ts";

const c = (o) => ({ status: "OPEN", createdDate: "2026-09-01", closedDate: null, ...o });

test("multi-cause case counts once per distinct cause; % is share of cases", () => {
  const rows = byCause([
    c({ causes: ["PRODUCTION", "DESIGN", "PRODUCTION"] }),
    c({ causes: ["PRODUCTION"] }),
    c({ causes: ["DESIGN"] }),
    c({ causes: [] }),
  ]);
  const get = (k) => rows.find((r) => r.key === k);
  assert.equal(get("PRODUCTION").count, 2);
  assert.equal(get("DESIGN").count, 2);
  assert.equal(get("PRODUCTION").pct, 50);
  assert.equal(get(NONE_KEY).count, 1);
  assert.equal(get(NONE_KEY).label, "Not yet analysed");
  assert.equal(rows.at(-1).key, NONE_KEY, "unanalysed row is always last");
});

test("days-to-close averages CLOSED cases only; open counted separately", () => {
  const rows = byCause([
    c({ causes: ["MATERIAL"], status: "CLOSED", closedDate: "2026-09-03" }), // 2
    c({ causes: ["MATERIAL"], status: "CLOSED", closedDate: "2026-09-06" }), // 5
    c({ causes: ["MATERIAL"], status: "IN_PROGRESS" }),
    c({ causes: ["MATERIAL"], status: "CANCELLED" }),
  ]);
  const m = rows.find((r) => r.key === "MATERIAL");
  assert.equal(m.count, 4);
  assert.equal(m.open, 1);
  assert.equal(m.avgCloseDays, 3.5);
  assert.equal(rows.find((r) => r.key === NONE_KEY).avgCloseDays, null);
});

test("empty input still yields the Not yet analysed row at 0", () => {
  const rows = byCause([]);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].key, rows[0].count, rows[0].pct], [NONE_KEY, 0, 0]);
  assert.equal(topProducts([]).length, 0);
});

test("unit and prevention: unset falls into the NONE row, labels are readable", () => {
  const units = byUnit([c({ unit: "R_AND_D" }), c({ unit: null })]);
  assert.equal(units[0].label, "R&D");
  assert.equal(units.at(-1).count, 1);
  const prev = byPrevention([c({ prevention: "PENDING" }), c({ prevention: "DONE" }), c({})]);
  assert.deepEqual(prev.map((r) => r.label).sort(), ["Done", "No prevention recorded", "Planned"]);
});

test("top products: once per case, highest first, limited", () => {
  const rows = topProducts([
    c({ products: ["A", "A", "B"] }), c({ products: ["A"] }), c({ products: ["C"] }),
  ], 2);
  assert.deepEqual(rows, [{ label: "A", count: 2 }, { label: "B", count: 1 }]);
});

test("causeTrend buckets top causes by period bucket", () => {
  const t = causeTrend(
    [c({ causes: ["A"], createdDate: "2026-09-01" }), c({ causes: ["A", "B"], createdDate: "2026-09-02" }), c({ causes: ["Z"] })],
    ["A", "B"],
    (d) => d.slice(5),
  );
  assert.deepEqual(t, [{ bucket: "09-01", A: 1, B: 0 }, { bucket: "09-02", A: 1, B: 1 }]);
});

test("parseCauses: multi JSON wins, legacy fallback, junk tolerated", () => {
  assert.deepEqual(parseCauses('[{"category":"DESIGN","details":{}},{"category":"PROCESS"}]', "OTHER"), ["DESIGN", "PROCESS"]);
  assert.deepEqual(parseCauses(null, "MATERIAL"), ["MATERIAL"]);
  assert.deepEqual(parseCauses("not json", null), []);
  assert.deepEqual(parseCauses("[]", ""), []);
});

test("parseProductLabels: code — name, tolerates junk, caps", () => {
  assert.deepEqual(parseProductLabels('[{"productId":"p1","code":"SF-1","name":"Sofa"},{"productId":"p2"}]'), ["SF-1 — Sofa", "p2"]);
  assert.deepEqual(parseProductLabels("oops"), []);
  assert.deepEqual(parseProductLabels(null), []);
  assert.equal(parseProductLabels(JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ code: `P${i}` })))).length, 10);
});
