// service-issue-stats.test.mjs — pure aggregation behind the dashboard's Service
// "Top issues" sub-tab: multi-cause counting, "Not yet analysed", days-to-close
// averaging, empty input, top products, and the row parsers.
import test from "node:test";
import assert from "node:assert/strict";
import {
  NONE_KEY, OTHER_KEY, RC_SEP, topCauses, byCause, byRootCause, rootCauseDetail, parseRootCauses, rootCauseLabel, byUnit, byPrevention, topProducts, causeTrend, avgClose, closeTrend, openedVsClosed, agingSplit, preventionNotDone, parseCauses, parseProductLabels,
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

test("Other is a catch-all: sorts below real causes, above unanalysed, never a Top 3 cause", () => {
  const rows = byCause([
    c({ causes: ["OTHER"] }), c({ causes: ["OTHER"] }), c({ causes: ["OTHER"] }),
    c({ causes: ["PRODUCTION"] }), c({ causes: ["DESIGN"] }),
    c({ causes: [] }),
  ]);
  assert.deepEqual(rows.map((r) => r.key), ["DESIGN", "PRODUCTION", OTHER_KEY, NONE_KEY]);
  assert.equal(rows.find((r) => r.key === OTHER_KEY).count, 3, "still counted, just not ranked");
  assert.deepEqual(topCauses(rows, 3).map((r) => r.key), ["DESIGN", "PRODUCTION"]);
});

test("root cause = category + the detail recorded under it; one row per distinct pair", () => {
  const rows = byRootCause([
    c({ rootCauses: [{ category: "TRANSPORT", detail: "GDEX" }] }),
    c({ rootCauses: [{ category: "TRANSPORT", detail: "GDEX" }, { category: "TRANSPORT", detail: "GDEX" }] }),
    c({ rootCauses: [{ category: "TRANSPORT", detail: "J&T" }] }),
    c({ rootCauses: [{ category: "PRODUCTION", detail: "" }] }),
    c({ rootCauses: [{ category: "OTHER", detail: "" }, { category: "OTHER", detail: "" }, { category: "OTHER", detail: "" }] }),
    c({ causes: ["CUSTOMER"] }), // feed cached before rootCauses shipped → bare category
    c({}),
  ]);
  assert.deepEqual(rows.map((r) => [r.label, r.count]), [
    ["Transport — GDEX", 2],
    ["Customer — no detail recorded", 1],
    ["Production — no detail recorded", 1],
    ["Transport — J&T", 1],
    ["Other — no detail recorded", 1],
    ["Not yet analysed", 1],
  ]);
  assert.equal(rootCauseLabel(`TRANSPORT${RC_SEP}GDEX`), "Transport — GDEX");
});

test("rootCauseDetail picks the one naming field per category, trims and caps it", () => {
  assert.equal(rootCauseDetail({ departmentName: " Sewing ", notes: "x" }), "Sewing");
  assert.equal(rootCauseDetail({ supplierId: "sup-1", supplierName: "HUP LEE" }), "HUP LEE");
  assert.equal(rootCauseDetail({ threePlCompany: "GDEX", driverName: "Ali" }), "GDEX");
  assert.equal(rootCauseDetail({ driverName: "Ali" }), "Ali");
  assert.equal(rootCauseDetail({ notes: "wrong  measurement\n(door)" }), "wrong measurement (door)");
  assert.equal(rootCauseDetail({ supplierId: "sup-1" }), "", "an id alone is not a label");
  assert.equal(rootCauseDetail(null), "");
  assert.equal(rootCauseDetail("{bad json"), "");
  assert.equal(rootCauseDetail({ notes: "a".repeat(80) }).length, 60);
});

test("parseRootCauses: multi array with details, legacy single columns as fallback", () => {
  assert.deepEqual(
    parseRootCauses('[{"category":"TRANSPORT","details":{"threePlCompany":"GDEX"}},{"category":"OTHER"}]', "PRODUCTION", '{"departmentName":"Sewing"}'),
    [{ category: "TRANSPORT", detail: "GDEX" }, { category: "OTHER", detail: "" }],
  );
  assert.deepEqual(parseRootCauses(null, "PRODUCTION", '{"departmentName":"Sewing"}'), [{ category: "PRODUCTION", detail: "Sewing" }]);
  assert.deepEqual(parseRootCauses("[]", null, null), []);
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

// ---- Lim "Service" sub-tab ------------------------------------------------
test("avgClose averages closed cases only and reports n", () => {
  const r = avgClose([
    c({ status: "CLOSED", closedDate: "2026-09-03" }), // 2
    c({ status: "CLOSED", closedDate: "2026-09-06" }), // 5
    c({}), // open, ignored
  ]);
  assert.deepEqual(r, { avg: 3.5, n: 2 });
  assert.deepEqual(avgClose([c({})]), { avg: null, n: 0 });
});

test("closeTrend buckets by closed date (month here)", () => {
  const rows = closeTrend([
    c({ status: "CLOSED", createdDate: "2026-08-30", closedDate: "2026-09-02" }), // 3
    c({ status: "CLOSED", createdDate: "2026-09-01", closedDate: "2026-09-02" }), // 1
    c({ status: "CLOSED", createdDate: "2026-09-01", closedDate: "2026-10-01" }), // 30
  ], (d) => d.slice(0, 7));
  assert.deepEqual(rows, [{ bucket: "2026-09", avg: 2, closed: 2 }, { bucket: "2026-10", avg: 30, closed: 1 }]);
});

test("openedVsClosed counts created and closed dates separately inside the range", () => {
  const rows = openedVsClosed([
    c({ createdDate: "2026-09-01" }),
    c({ createdDate: "2026-09-01", status: "CLOSED", closedDate: "2026-09-02" }),
    c({ createdDate: "2026-08-31", status: "CLOSED", closedDate: "2026-09-02" }),
  ], (d) => d.startsWith("2026-09"), (d) => d);
  assert.deepEqual(rows, [{ bucket: "2026-09-01", opened: 2, closed: 0 }, { bucket: "2026-09-02", opened: 0, closed: 2 }]);
});

test("agingSplit buckets open cases from the threshold (3 -> 0-3 / 4-7 / 8+)", () => {
  const cs = [0, 3, 4, 7, 8, 30].map((ageDays) => ({ status: "OPEN", ageDays }));
  cs.push({ status: "CLOSED", ageDays: null }, { status: "IN_PROGRESS", ageDays: null });
  const r = agingSplit(cs, 3);
  assert.deepEqual(r.map((x) => x.label), ["0–3 days", "4–7 days", "8+ days"]);
  assert.deepEqual(r.map((x) => x.count), [2, 2, 2]);
});

test("preventionNotDone: drops done / not-needed / cancelled / unanalysed-open; oldest first", () => {
  const rows = preventionNotDone([
    c({ createdDate: "2026-09-05", prevention: "PENDING", ageDays: 2 }),
    c({ createdDate: "2026-09-01", prevention: "IN_PROGRESS", ageDays: 6 }),
    c({ createdDate: "2026-09-02", prevention: "DONE" }),
    c({ createdDate: "2026-09-02", prevention: "NOT_NEEDED" }),
    c({ createdDate: "2026-09-02", prevention: "PENDING", status: "CANCELLED" }),
    c({ createdDate: "2026-09-03" }), // open, no cause, no prevention: too early to chase
    c({ createdDate: "2026-09-04", causes: ["DESIGN"], ageDays: 3 }), // analysed, no prevention
    c({ createdDate: "2026-09-06", status: "CLOSED", closedDate: "2026-09-09" }), // closed, none recorded
  ]);
  assert.deepEqual(rows.map((r) => [r.createdDate, r.daysOpen]), [
    ["2026-09-01", 6], ["2026-09-04", 3], ["2026-09-05", 2], ["2026-09-06", 3],
  ]);
});

// ---- 2026-09-22 redesign: meters, per-case close days, cause × day grid ----
import {
  analysisProgress, closeDaysByCause, causeGrid, dayBuckets, monthBuckets, topCauseByProduct,
} from "../src/api/lib/service-issue-stats.ts";

test("analysisProgress: one ratio per step; 'Planned' prevention is recorded but not done", () => {
  const steps = analysisProgress([
    c({ causes: ["PRODUCTION"], unit: "QC", prevention: "DONE" }),
    c({ causes: ["CUSTOMER"], prevention: "PENDING" }),
    c({ prevention: "PENDING" }),
    c({}),
  ]);
  const get = (k) => steps.find((s) => s.key === k);
  assert.deepEqual(steps.map((s) => s.key), ["cause", "unit", "prevention", "done"]);
  assert.equal(get("cause").done, 2);
  assert.equal(get("cause").pct, 50);
  assert.equal(get("unit").done, 1);
  assert.equal(get("prevention").done, 3);
  assert.equal(get("done").done, 1);
  assert.equal(analysisProgress([])[0].pct, 0, "empty input is 0%, not NaN");
});

test("closeDaysByCause: every closed case's days under each of its causes, sorted; open cases add none", () => {
  const rows = closeDaysByCause([
    c({ causes: ["PRODUCTION", "DESIGN"], status: "CLOSED", closedDate: "2026-09-11" }), // 10
    c({ causes: ["PRODUCTION"], status: "CLOSED", closedDate: "2026-09-04" }),           // 3
    c({ causes: ["PRODUCTION"] }),                                                        // open
    c({ status: "CLOSED", closedDate: "2026-09-06" }),                                    // unanalysed, 5
  ]);
  const get = (k) => rows.find((r) => r.key === k);
  assert.deepEqual(get("PRODUCTION").days, [3, 10]);
  assert.equal(get("PRODUCTION").count, 3);
  assert.equal(get("PRODUCTION").avg, 6.5);
  assert.deepEqual(get("DESIGN").days, [10]);
  assert.deepEqual(get(NONE_KEY).days, [5]);
  assert.equal(rows.at(-1).key, NONE_KEY);
});

test("causeGrid: fixed bucket list keeps empty days; a case outside the buckets is ignored; NONE row only when it has cases", () => {
  const buckets = dayBuckets("2026-09-01", "2026-09-04");
  assert.deepEqual(buckets, ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
  const g = causeGrid(
    [
      c({ causes: ["CUSTOMER"], createdDate: "2026-09-01" }),
      c({ causes: ["CUSTOMER", "PRODUCTION"], createdDate: "2026-09-03" }),
      c({ causes: ["CUSTOMER"], createdDate: "2026-09-03" }),
      c({ causes: ["CUSTOMER"], createdDate: "2026-08-31" }), // before the window
    ],
    buckets,
    (d) => d,
  );
  assert.deepEqual(g.buckets, buckets);
  assert.deepEqual(g.rows.map((r) => r.key), ["CUSTOMER", "PRODUCTION"], "no unanalysed row when every case has a cause");
  assert.deepEqual(g.rows[0].cells, [1, 0, 2, 0]);
  assert.deepEqual(g.rows[1].cells, [0, 0, 1, 0]);
  assert.equal(g.max, 2);
  assert.equal(causeGrid([], buckets, (d) => d).rows.length, 0);
});

test("monthBuckets: January through the given month", () => {
  assert.deepEqual(monthBuckets(2026, 3), ["2026-01", "2026-02", "2026-03"]);
  assert.equal(monthBuckets(2026, 0).length, 1, "never empty");
});

test("topCauseByProduct: most-recorded cause per product; null when none of its cases is analysed", () => {
  const m = topCauseByProduct([
    c({ products: ["A", "B"], causes: ["PRODUCTION"] }),
    c({ products: ["A"], causes: ["PRODUCTION", "DESIGN"] }),
    c({ products: ["A"], causes: ["PRODUCTION"] }),
    c({ products: ["D"], causes: ["SALES", "DESIGN"] }), // a tie breaks alphabetically
    c({ products: ["C"] }),
  ]);
  assert.equal(m.get("A"), "PRODUCTION");
  assert.equal(m.get("B"), "PRODUCTION");
  assert.equal(m.get("C"), null);
  assert.equal(m.get("D"), "DESIGN");
});
