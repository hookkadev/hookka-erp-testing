// mrp-export.test.mjs — the MRP workbook sheets match what each tab shows.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }

const m = await import(pathToFileURL(resolve(process.cwd(), "src/lib/mrp-export.ts")).href);

const REQ = {
  id: "r1",
  materialName: "Foam 32D",
  materialCategory: "SM_FABRIC",
  unit: "m",
  grossRequired: 120,
  onHand: 40,
  onOrder: 30,
  netRequired: 50,
  status: "SHORTAGE",
  suggestedPOQty: 50,
  preferredSupplierName: "Acme Foam",
  byBucket: { THIS_WEEK: 20, BEYOND: 100 },
  moq: null,
  leadTimeDays: null,
  suggestedOrderDate: "2026-10-12",
};

test("requirements sheet: one row per requirement, buckets filled, missing MOQ / lead time left blank", () => {
  const aoa = m.buildMrpRequirementsAoa([REQ]);
  assert.deepEqual(aoa[0], [...m.MRP_REQUIREMENT_HEADERS]);
  assert.equal(aoa.length, 2);
  const row = aoa[1];
  const at = (h) => row[m.MRP_REQUIREMENT_HEADERS.indexOf(h)];
  assert.equal(at("This Wk"), 20);
  assert.equal(at("Next Wk"), 0);
  assert.equal(at("4+ Wk"), 100);
  assert.equal(at("Net Req"), 50);
  assert.equal(at("MOQ"), "", "no MOQ on the binding exports blank, never a made-up number");
  assert.equal(at("Lead Time (days)"), "");
  assert.equal(at("Order By"), "2026-10-12");
});

test("fabric sheet uses the run's fabric detail when there is any", () => {
  const aoa = m.buildMrpFabricAoa(
    [{ code: "PC151", name: "Velvet", category: "BM_FABRIC", sohMeters: 10, poOutstanding: 5,
       weeklyUsage: 2, twoWeekUsage: 4, monthlyUsage: 9, shortage: true }],
    [REQ],
  );
  assert.deepEqual(aoa[0], [...m.MRP_FABRIC_DETAIL_HEADERS]);
  assert.deepEqual(aoa[1], ["PC151", "Velvet", "BM FABRIC", 10, 5, 2, 4, 9, "SHORTAGE"]);
});

test("fabric sheet falls back to the fabric requirements, like the tab does", () => {
  const aoa = m.buildMrpFabricAoa([], [REQ]);
  assert.deepEqual(aoa[0], [...m.MRP_FABRIC_SUMMARY_HEADERS]);
  assert.deepEqual(aoa[1], ["Foam 32D", "SM FABRIC", 40, 120, 50, "SHORTAGE", 50, "m"]);
});
