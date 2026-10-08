// ---------------------------------------------------------------------------
// on-time-delivery.test.mjs — BUG-2026-08-13-140.
//
// The Hookka Report's "On-time delivery %" did not measure delivery, and did
// not measure it against anything the customer agreed to. It scored
// `delivery_orders.dispatched_at` against `delivery_orders.hookka_expected_dd`
// — our OWN back-derived internal target — over a population that required
// `dispatched_at IS NOT NULL`, so an order never dispatched at all could not
// pull it down. `kpi-metrics.ts:18-19` had already written the rule this broke:
// "`hookka_expected_dd` is OUR internal estimate and must never be scored
// against".
//
// Owner's rule, 2026-08-14, verbatim:
//   「基本上就是看我们送货的时间减掉我们顾客的 delivery date，
//     就会知道有没有 on-time delivery 了」
//
// So: `delivery_orders.delivered_at` vs `sales_orders.customer_delivery_date`,
// per sales order, last delivery counts — and every order that cannot be judged
// is EXCLUDED AND COUNTED, because a percentage over an incomplete population
// must publish its coverage (BUG-2026-08-13-096).
//
// Part BEHAVIOURAL (the verdict logic, against fabricated rows) and part
// STRUCTURAL (the wiring and the printed coverage — a plausible percentage is
// exactly what the bug produced, so only the source can pin those). Every
// assertion here was proved RED by reintroducing the removed expression and
// asserting the file's bytes changed on disk first.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  summarizeOnTimeRows,
  judgeOnTimeRow,
  mytYmd,
  mytDateSql,
  EMPTY_ON_TIME,
} from "../src/api/lib/on-time-delivery.ts";
import {
  deliveryMetric,
  deliveryOrderRows,
} from "../src/api/lib/kpi-metrics.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
// CRLF-normalised + BOM-stripped: this repo's files are CRLF, and a literal \n
// anchor silently matches nothing — five false all-clears in one week.
const read = (rel) =>
  readFileSync(join(root, rel), "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
function stripComments(src) {
  return src
    .replace(/^[ \t]*\{?\/\*[\s\S]*?\*\/\}?[ \t]*$/gm, "")
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

const AGG = "src/api/lib/operations-report.ts";
const MOD = "src/api/lib/on-time-delivery.ts";
const EDITIONS = "src/pages/hookka-report-editions.tsx";

const row = (o) => ({
  soId: o.soId ?? "so-1",
  customerDeliveryDate: o.due ?? null,
  lastDeliveredOn: o.delivered ?? null,
  openLegs: o.openLegs ?? 0,
});

// ===========================================================================
// The verdict: delivered_at vs the customer's date
// ===========================================================================

test("delivered before the customer's date is on time; after it is late", () => {
  const r = summarizeOnTimeRows([
    row({ soId: "a", due: "2026-08-10", delivered: "2026-08-08" }),
    row({ soId: "b", due: "2026-08-10", delivered: "2026-08-12" }),
  ]);
  assert.equal(r.onTime, 1);
  assert.equal(r.late, 1);
  assert.equal(r.judged, 2);
  assert.equal(r.onTimePct, 50);
});

test("delivering ON the promised day is ON TIME", () => {
  // The customer asked for that date, not for the day before it. An off-by-one
  // here turns a perfect record into a 0%.
  const r = summarizeOnTimeRows([
    row({ due: "2026-08-10", delivered: "2026-08-10" }),
  ]);
  assert.equal(r.onTime, 1);
  assert.equal(r.late, 0);
  assert.equal(r.onTimePct, 100);
});

test("a full ISO timestamp is judged on its MALAYSIA date", () => {
  // BUG-2026-10-08-267. deliveredAt is a UTC timestamp; customer_delivery_date
  // is a Malaysia day. This test used to call 18:00Z on the 10th "on time" by
  // reading the UTC date — but that is 02:00 on the 11th in Malaysia, a day
  // late. 15:59Z is 23:59 MYT, still the promised day.
  const at = (iso) => summarizeOnTimeRows([
    { soId: "a", customerDeliveryDate: "2026-08-10", lastDeliveredOn: iso, openLegs: 0 },
  ]);
  assert.equal(at("2026-08-10T15:59:00.000Z").onTime, 1, "23:59 MYT on the promised day is on time");
  assert.equal(at("2026-08-10T18:00:00.000Z").late, 1, "02:00 MYT the next day is late");
  assert.equal(at("2026-08-10T23:00:00.000Z").late, 1, "07:00 MYT the day after the promised date is late");
});

test("mytYmd and mytDateSql turn a UTC timestamp into the Malaysia date", () => {
  assert.equal(mytYmd("2026-08-04T23:00:00.000Z"), "2026-08-05", "07:00 MYT on the 5th");
  assert.equal(mytYmd("2026-08-31T16:30:00.000Z"), "2026-09-01", "00:30 MYT on the 1st is next month");
  assert.equal(mytYmd("2026-08-10"), "2026-08-10", "a plain date is already a date");
  const sql = mytDateSql("d.deliveredAt");
  assert.match(sql, /AT TIME ZONE 'Asia\/Kuala_Lumpur'/);
  assert.match(sql, /NULLIF\(d\.deliveredAt::text, ''\)::timestamptz/);
});

test("early is delivered BEFORE the promised day; on the day is on time, not early", () => {
  const r = summarizeOnTimeRows([
    row({ soId: "a", due: "2026-08-10", delivered: "2026-08-08" }),
    row({ soId: "b", due: "2026-08-10", delivered: "2026-08-10" }),
    row({ soId: "c", due: "2026-08-10", delivered: "2026-08-11" }),
  ]);
  assert.equal(r.early, 1);
  assert.equal(r.onTime, 2, "early is a part of on time, as the report has always counted it");
  assert.equal(r.late, 1);
  assert.deepEqual(
    ["a", "b", "c"].map((id, i) => judgeOnTimeRow(row({ soId: id, due: "2026-08-10", delivered: ["2026-08-08", "2026-08-10", "2026-08-11"][i] }))),
    ["EARLY", "ON_TIME", "LATE"],
  );
});

// ===========================================================================
// The exclusions — each one counted, none of them silently on-time
// ===========================================================================

test("an order not yet fully delivered is EXCLUDED, not counted as late", () => {
  // Not-yet-delivered is not a failure: the delivery has not finished, so there
  // is nothing to score. Counting it late invents failures; counting it on time
  // hides them.
  const r = summarizeOnTimeRows([
    row({ soId: "a", due: "2026-08-01", delivered: "2026-08-05", openLegs: 1 }),
  ]);
  assert.equal(r.judged, 0);
  assert.equal(r.late, 0, "an unfinished delivery must not be scored as late");
  assert.equal(r.onTime, 0);
  assert.equal(r.excludedNotDelivered, 1);
  assert.equal(r.onTimePct, null, "nothing judgeable ⇒ null, never 0 and never 100");
});

test("a PART-delivery is the not-fully-delivered case, not a free pass", () => {
  // The first lorry landing early must not certify the order. It has an open
  // leg, so it is excluded until the last piece arrives — at which point the
  // LAST date is the one judged.
  const partial = summarizeOnTimeRows([
    row({ soId: "a", due: "2026-08-10", delivered: "2026-08-02", openLegs: 2 }),
  ]);
  assert.equal(partial.onTime, 0, "an early first drop cannot score the order");
  assert.equal(partial.excludedNotDelivered, 1);

  const finished = summarizeOnTimeRows([
    row({ soId: "a", due: "2026-08-10", delivered: "2026-08-14", openLegs: 0 }),
  ]);
  assert.equal(finished.late, 1, "the LAST delivery is what the customer waited for");
});

test("an order with no customer delivery date is EXCLUDED and counted", () => {
  const r = summarizeOnTimeRows([
    row({ soId: "a", due: null, delivered: "2026-08-05" }),
    row({ soId: "b", due: "  ", delivered: "2026-08-05" }),
  ]);
  assert.equal(r.judged, 0);
  assert.equal(r.excludedNoCustomerDate, 2, "blank and null are both 'no promise'");
  assert.equal(r.onTimePct, null);
});

// ===========================================================================
// Coverage — the population is published, always
// ===========================================================================

test("coverage is judged ÷ everything the metric looked at", () => {
  const r = summarizeOnTimeRows([
    row({ soId: "a", due: "2026-08-10", delivered: "2026-08-09" }),
    row({ soId: "b", due: "2026-08-10", delivered: "2026-08-11" }),
    row({ soId: "c", due: null, delivered: "2026-08-09" }),
    row({ soId: "d", due: "2026-08-10", delivered: "2026-08-09", openLegs: 1 }),
  ]);
  assert.equal(r.judged, 2);
  assert.equal(r.population, 4);
  assert.equal(r.coveragePct, 50, "half the orders could not be judged — say so");
  assert.equal(r.onTimePct, 50);
});

test("an empty period publishes nulls, not a perfect score", () => {
  const r = summarizeOnTimeRows([]);
  assert.equal(r.onTimePct, null);
  assert.equal(r.coveragePct, null);
  assert.equal(r.population, 0);
  assert.equal(EMPTY_ON_TIME.onTimePct, null, "the failure fallback is null too");
});

// ===========================================================================
// The on-time delivery KPI — the same rows, the same verdict (BUG-2026-10-08-267)
// ===========================================================================

const RULES = { urgentDays: 7, urgentLatePct: 100 };

test("KPI: an order whose last lorry was late is late, however the first one went", () => {
  // The old KPI took the FIRST dispatch. The shared rows carry the LAST
  // delivery (MAX in the query, pinned below), so this order is judged on 14/8.
  const m = deliveryMetric(
    [row({ soId: "a", due: "2026-08-10", delivered: "2026-08-14" })],
    RULES,
  );
  assert.equal(m.actual, 100);
  assert.match(m.detail, /^1 late, 0 early of 1 delivered/);
});

test("KPI: a part-delivered order is left out, not judged on its first lorry", () => {
  const m = deliveryMetric(
    [
      row({ soId: "a", due: "2026-08-10", delivered: "2026-08-02", openLegs: 1 }),
      row({ soId: "b", due: "2026-08-10", delivered: "2026-08-09" }),
    ],
    RULES,
  );
  assert.equal(m.sampleSize, 1, "only the fully delivered order is judged");
  assert.equal(m.actual, 0);
  assert.equal(deliveryMetric([row({ due: "2026-08-10", delivered: "2026-08-02", openLegs: 1 })], RULES).actual,
    null, "nothing judged is no figure, not 0%");
});

test("KPI: the late % and the order list agree, row for row", () => {
  const rows = [
    row({ soId: "a", due: "2026-08-10", delivered: "2026-08-08" }),
    row({ soId: "b", due: "2026-08-10", delivered: "2026-08-10" }),
    row({ soId: "c", due: "2026-08-10", delivered: "2026-08-10T23:00:00.000Z" }),
    row({ soId: "d", due: "2026-08-05", delivered: "2026-08-12" }),
    row({ soId: "e", due: "2026-08-10", delivered: "2026-08-12", openLegs: 1 }),
    row({ soId: "f", due: null, delivered: "2026-08-12" }),
  ];
  const m = deliveryMetric(rows, RULES);
  const late = deliveryOrderRows(rows, false);
  const all = deliveryOrderRows(rows, true);
  assert.deepEqual(late.map((r) => r.id), ["c", "d"], "c landed 07:00 MYT on the 11th");
  assert.equal(all.length, m.sampleSize, "the full list is exactly what was judged");
  assert.equal(m.actual, Math.round((late.length / all.length) * 1000) / 10);
  assert.equal(all.find((r) => r.id === "c").deliveredOn, "2026-08-11", "the list shows the Malaysia date");
  assert.deepEqual(all.map((r) => r.status), ["EARLY", "ON_TIME", "LATE", "LATE"]);
});

test("KPI: a late urgent order counts as the editable share", () => {
  const rows = [
    { ...row({ soId: "a", due: "2026-08-10", delivered: "2026-08-12" }), orderDate: "2026-08-04" },
    { ...row({ soId: "b", due: "2026-08-20", delivered: "2026-08-22" }), orderDate: "2026-08-01" },
    row({ soId: "c", due: "2026-08-20", delivered: "2026-08-19" }),
    row({ soId: "d", due: "2026-08-20", delivered: "2026-08-19" }),
  ];
  assert.equal(deliveryMetric(rows, RULES).actual, 50, "100%: urgent counts in full");
  const half = deliveryMetric(rows, { urgentDays: 7, urgentLatePct: 50 });
  assert.equal(half.actual, 37.5, "a (6 days' notice) counts half: 1.5 of 4");
  assert.match(half.detail, /1 urgent at 50%, so 1\.5 counted/);
  assert.equal(deliveryOrderRows(rows, false)[0].leadDays, 6);
});

// ===========================================================================
// STRUCTURAL — the wiring, which no behavioural test can reach
// ===========================================================================

test("the shared query takes the LAST delivery's Malaysia date", () => {
  const mod = stripComments(read(MOD));
  assert.match(mod, /MAX\(\$\{mytDateSql\("d\.deliveredAt"\)\}\) AS last_delivered_on/,
    "MAX = the last delivery, on the Malaysia date");
  assert.doesNotMatch(mod, /substr\(d\.deliveredAt/, "the UTC date slice is gone");
});

test("the KPI and its order list read the shared rows, not their own SQL", () => {
  const metrics = stripComments(read("src/api/lib/kpi-metrics.ts"));
  assert.match(metrics, /deliveryMetric\(await collectOnTimeOrders\(c\.var\.DB, start, end\), rules\)/);
  assert.match(metrics, /deliveryOrderRows\(await collectOnTimeOrders\(c\.var\.DB, start, end, scope\), all\)/);
  assert.doesNotMatch(metrics, /first_dispatch|FIRST_DISPATCH/, "no first-dispatch query left");
});

test("the report no longer scores our own internal target", () => {
  const agg = stripComments(read(AGG));
  assert.ok(
    !/hookka_expected_dd/.test(agg),
    "operations-report must not read hookka_expected_dd at all — it is OUR " +
      "estimate, back-derived from the customer's date, and scoring it is " +
      "marking our own homework (kpi-metrics.ts:18-19)",
  );
  assert.ok(
    !/dispatchedAt <= r\.expectedDd|r\.dispatchedAt <= r\.expectedDd/.test(agg),
    "the dispatch-vs-estimate comparison is back",
  );
  assert.ok(
    /collectOnTimeDelivery\(db, p\.startYmd, p\.endYmd\)/.test(agg),
    "the delivery section must take its on-time figure from the shared module",
  );
  assert.ok(
    /onTimePct: onTime\.onTimePct/.test(agg),
    "and publish that module's percentage, not a locally recomputed one",
  );
});

test("the metric reads delivered_at against the customer's own date", () => {
  const mod = stripComments(read(MOD));
  assert.ok(
    /d\.deliveredAt/.test(mod),
    "the actual arrival is delivery_orders.deliveredAt",
  );
  assert.ok(
    /so\.customerDeliveryDate/.test(mod),
    "the promise is sales_orders.customerDeliveryDate — the customer's date",
  );
  assert.ok(
    !/hookkaExpectedDd|hookka_expected_dd/.test(mod),
    "our internal estimate must never appear in this module",
  );
  // The join path kpi-metrics.ts measured: delivery_orders.sales_order_id is
  // set on only ~half the DOs, so joining on it drops half the shipments.
  assert.ok(
    /JOIN delivery_order_items di ON di\.deliveryOrderId = d\.id/.test(mod) &&
      /JOIN production_orders po ON po\.id = di\.productionOrderId/.test(mod),
    "must use the production-order join path, the only one that resolves",
  );
  assert.ok(
    !/d\.salesOrderId/.test(mod),
    "delivery_orders.salesOrderId is populated on only ~166 of 361 DOs",
  );
});

test("the printed report publishes the coverage beside the percentage", () => {
  const strip = stripComments(read(EDITIONS));
  assert.ok(
    /r\.delivery\.onTime/.test(strip),
    "the edition must read the coverage object, not just the bare percentage",
  );
  for (const field of ["judged", "excludedNotDelivered", "excludedNoCustomerDate"]) {
    assert.ok(
      strip.includes(`ot.${field}`),
      `the printed report drops \`${field}\`: the reader cannot then tell a ` +
        `100% over four orders from a 100% over four hundred`,
    );
  }
  assert.ok(
    /On-Time Delivery at/.test(strip) && /"On-time delivery"/.test(strip),
    "both prints of this figure must say DELIVERY — it is not production " +
      "timeliness, and it used to be labelled as though the two agreed",
  );
});
