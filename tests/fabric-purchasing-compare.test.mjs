// ---------------------------------------------------------------------------
// fabric-purchasing-compare.test.mjs: month buckets behind the staging
// Dashboard Compare "Fabric & purchasing" tab (owner 2026-10-09).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { buildFabricPurchasingMonths, monthsBack } from "../src/api/lib/fabric-purchasing-compare.ts";

test("monthsBack counts back across a year end, newest first", () => {
  assert.deepEqual(monthsBack("2026-02", 4), ["2026-02", "2026-01", "2025-12", "2025-11"]);
});

test("rows land in their own month and category; outside the window is dropped", () => {
  const { months, trend } = buildFabricPurchasingMonths({
    months: ["2026-10", "2026-09"],
    cut: [
      { cat: "SOFA", ym: "2026-10", meters: 24.3, shownSen: 47822, realSen: 41407, openingMeters: 8.1 },
      { cat: "SOFA", ym: "2025-01", meters: 99, shownSen: 1, realSen: 1, openingMeters: 0 },
    ],
    invoices: [
      { ym: "2026-10", grp: "S.M-FABR", code: "KN390-1", lines: 2, meters: 100, sen: 170000 },
      { ym: "2026-09", grp: "S.M-FABR", code: "KN390-1", lines: 1, meters: 50, sen: 90000 },
      { ym: "2026-10", grp: "B.M-FABR", code: "PC151-01", lines: 1, meters: 500, sen: 600000 },
      { ym: "2026-10", grp: "S-FABRIC", code: "LC5 (B)", lines: 1, meters: 400, sen: 13200 },
    ],
    receipts: [{ ym: "2026-09", grp: "B.M-FABR", meters: 10 }],
    grns: [{ ym: "2026-09", grp: "B.M-FABR", grns: 2, meters: 10 }],
    orders: [
      { cat: "SOFA", ym: "2026-10", fabricCode: "KN390-1", plannedMeters: 8, recordedMeters: 8.1, recordedSen: 20250 },
      { cat: "SOFA", ym: "2026-10", fabricCode: "COVE-03", plannedMeters: 6, recordedMeters: 0, recordedSen: 0 },
      { cat: "SOFA", ym: "2026-10", fabricCode: "COVE-03", plannedMeters: 6, recordedMeters: 0, recordedSen: 0 },
    ],
  });
  const oct = months[0].SOFA;
  assert.equal(months[0].ym, "2026-10");
  assert.equal(oct.cutMeters, 24.3);
  assert.equal(oct.shownSen, 47822);
  assert.equal(oct.invoiceMeters, 100);
  assert.equal(oct.invoiceSen, 170000);
  assert.equal(oct.ordersDone, 3);
  assert.equal(oct.ordersRecorded, 1);
  assert.equal(oct.plannedMeters, 20);
  assert.equal(oct.recordedMeters, 8.1);
  assert.equal(oct.fabricsUsed, 2);
  assert.equal(oct.fabricsRecorded, 1);
  assert.equal(months[1].BEDFRAME.receivedMeters, 10);
  assert.equal(months[1].BEDFRAME.grns, 2);
  // Zips and tape (S-FABRIC) are not upholstery fabric: not in purchasing or the trend.
  assert.equal(months[0].SOFA.invoiceLines, 2);
  assert.deepEqual(trend.map((t) => t.code), ["PC151-01", "KN390-1"]);
  const kn = trend.find((t) => t.code === "KN390-1");
  assert.equal(kn.meters, 150);
  assert.deepEqual(kn.byMonth["2026-09"], { meters: 50, sen: 90000 });
});
