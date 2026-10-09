// ---------------------------------------------------------------------------
// planning-pillow-follows-sofa.test.mjs — DEV-08 rule B (Violet, 2026-10-01):
// a pillow is guaranteed finished before its sofa is packed, so the full set is
// packed and shipped together.
//
//   Sewing  — a pillow on an SO with a sofa/bedframe is due by that main item's
//             last sew day (Wood Cut waits for the WHOLE SO's sewing, so a late
//             pillow holds the sofa back). If the main item is already past
//             sewing or done, the pillow is behind and due now.
//   Packing — the SO's pillow PACKING cards ride the sofa's pack unit; before
//             this they were dropped from the Packing schedule entirely.
//
// Drives computeChain itself, like planning-chain-slack.test.mjs.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import { computeChain } from "../src/api/lib/planning-chain.ts";
import { DEFAULT_CAPACITY_CONFIG } from "../src/api/lib/planning-capacity.ts";

const START = "2026-08-03"; // Monday
// ACCESSORY sewing is 240 min/day at 15 min a pillow: 16 pillows fill a day,
// so two 16-pillow groups cannot share one.
const FULL_DAY_OF_PILLOWS = 16;

function card(over) {
  return {
    dept: "FAB_SEW",
    soPo: over.soId,
    customer: "Test",
    label: over.soId,
    fabric: "PC151-01",
    model: "MODEL",
    size: "",
    sets: 1,
    mins: 60,
    customerDd: null,
    expectedDd: null,
    wipType: "",
    pinnedDue: null,
    cutDone: true,
    noCutStep: false,
    ...over,
  };
}

const pillow = (soId, dd, dept = "FAB_SEW") =>
  card({ soId, soPo: `${soId}-02`, lane: "ACCESSORY", dept, customerDd: dd, sets: FULL_DAY_OF_PILLOWS, label: "SQUARE PILLOW", model: "SQUARE PILLOW" });
const sofa = (soId, dd, dept = "FAB_SEW") =>
  card({ soId, soPo: `${soId}-01`, lane: "SOFA", dept, customerDd: dd, wipType: "SOFA_BASE", label: "5530-2S", model: "5530-2S" });

function run(chainCards, extra = {}) {
  const sew = new Map();
  const pack = [];
  const out = computeChain({
    cutCards: [],
    chainCards,
    config: DEFAULT_CAPACITY_CONFIG,
    holidays: [],
    startDate: START,
    generatedAt: START,
    ...extra,
    collect: (a) => {
      if (a.dept === "FAB_SEW" && a.lane === "ACCESSORY") sew.set(a.soId, a.date);
      if (a.dept === "PACKING") pack.push(a);
    },
  });
  return { sew, pack, out };
}

test("a pillow with a sofa on its SO is sewn no later than the sofa, ahead of a nearer-due standalone pillow", () => {
  const { sew } = run([
    sofa("SO-SOFA", "2026-11-30"),
    pillow("SO-SOFA", "2026-11-30"),
    pillow("SO-ALONE", "2026-08-21"),
  ]);
  assert.equal(sew.get("SO-SOFA"), START, "pillow rides its sofa's sew day");
  assert.ok(sew.get("SO-ALONE") > START, "the standalone pillow takes the next day");
});

test("standalone pillows still queue on their own due dates (unchanged)", () => {
  const { sew } = run([pillow("SO-LATE", "2026-11-30"), pillow("SO-SOON", "2026-08-21")]);
  assert.ok(sew.get("SO-SOON") < sew.get("SO-LATE"));
});

test("a pillow whose sofa is already past sewing is behind and goes first", () => {
  const { sew } = run([
    sofa("SO-SOFA", "2026-11-30", "PACKING"),
    pillow("SO-SOFA", "2026-11-30"),
    pillow("SO-ALONE", "2026-08-21"),
  ]);
  assert.equal(sew.get("SO-SOFA"), START);
});

test("soIdsWithMainItem: a pillow whose sofa is fully done (no WAITING card) goes first", () => {
  const cards = [pillow("SO-DONE", "2026-11-30"), pillow("SO-ALONE", "2026-08-21")];
  assert.ok(run(cards).sew.get("SO-DONE") > START, "without the hint it looks standalone");
  const { sew } = run(cards, { soIdsWithMainItem: new Set(["SO-DONE"]) });
  assert.equal(sew.get("SO-DONE"), START);
});

test("packing: the SO's pillow is packed on the sofa's day and listed under the same SO", () => {
  const { pack, out } = run([
    sofa("SO-SOFA", "2026-11-30", "PACKING"),
    pillow("SO-SOFA", "2026-11-30", "PACKING"),
  ]);
  const sofaPack = pack.find((a) => a.lane === "SOFA");
  const pillowPack = pack.find((a) => a.lane === "ACCESSORY");
  assert.ok(sofaPack && pillowPack, "both cards are scheduled");
  assert.equal(pillowPack.date, sofaPack.date);

  const rows = out.packing.sheets["Pack Calendar"];
  const soRow = rows.findIndex((r) => r[2] === "SO-SOFA");
  assert.ok(soRow > 0);
  assert.equal(rows[soRow + 1][4], "SQUARE PILLOW", "pillow row sits under its SO");
  const byDay = out.packing.sheets["By Day"];
  assert.equal(byDay[1][5], 2, "pieces count the pillow");
});

test("packing: a pillow-only SO is still not on the Packing schedule (unchanged)", () => {
  const { pack } = run([pillow("SO-ALONE", "2026-11-30", "PACKING")]);
  assert.equal(pack.length, 0);
});

test("packing: with a sofa and a bedframe on one SO, the pillow joins the sofa only", () => {
  const bed = card({ soId: "SO-MIX", soPo: "SO-MIX-03", lane: "BEDFRAME", dept: "PACKING", wipType: "DIVAN" });
  const { pack } = run([sofa("SO-MIX", null, "PACKING"), bed, pillow("SO-MIX", null, "PACKING")]);
  assert.equal(pack.filter((a) => a.lane === "ACCESSORY").length, 1, "no duplicate pillow row");
});

// ── Cutting (rule A, Violet 2026-10-01): a pillow is cut with its sofa ──────
// Cutting is just-in-time: a pillow-only order is cut chunkLeadDays (3) before
// its customer date. A pillow on an SO whose sofa still waits to be cut takes
// the sofa's modelLeadDays (6); one whose sofa is already cut is cut at once.

function cutCard(soPo, mainItem) {
  return {
    soPo,
    customer: "Test",
    label: "SQUARE PILLOW | M2402-6",
    fabric: "M2402-6",
    lane: "ACCESSORY",
    config: "SQUARE PILLOW",
    size: "",
    sets: 2,
    customerDd: "2026-09-30",
    expectedDd: null,
    ...(mainItem ? { mainItem } : {}),
  };
}

function cutDays(cutCards) {
  const out = new Map();
  computeChain({
    cutCards,
    chainCards: [],
    config: DEFAULT_CAPACITY_CONFIG,
    holidays: [],
    startDate: START,
    generatedAt: START,
    collect: (a) => {
      if (a.dept === "FAB_CUT") out.set(a.soPo, a.date);
    },
  });
  return out;
}

test("cutting: a pillow whose sofa is already cut is cut at once; one whose sofa waits takes the sofa's lead", () => {
  const days = cutDays([
    cutCard("SO-ALONE-02"),
    cutCard("SO-WAIT-02", "WAITING_CUT"),
    cutCard("SO-CUT-02", "CUT"),
  ]);
  assert.equal(days.get("SO-CUT-02"), START, "sofa already cut: pillow cut now");
  assert.ok(days.get("SO-WAIT-02") < days.get("SO-ALONE-02"), "sofa still to cut: pillow cut earlier than JIT");
  assert.ok(days.get("SO-ALONE-02") > START, "pillow-only order stays just in time");
});

test("cutting: a pulled-forward pillow does not drag a same-config pillow-only order with it", () => {
  const alone = cutDays([cutCard("SO-ALONE-02")]).get("SO-ALONE-02");
  const mixed = cutDays([cutCard("SO-ALONE-02"), cutCard("SO-CUT-02", "CUT")]);
  assert.equal(mixed.get("SO-ALONE-02"), alone);
  assert.equal(mixed.get("SO-CUT-02"), START);
});
