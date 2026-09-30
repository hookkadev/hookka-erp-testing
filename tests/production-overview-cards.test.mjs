// ---------------------------------------------------------------------------
// production-overview-cards.test.mjs — /production Overview "Cards" view.
//
// One card per work order: header bar + a stage pipeline whose columns come
// from overviewStages() (today's 9 DEPARTMENTS in their CURRENT order, plus
// any extra isProduction dept from /api/departments appended). The floor must
// never see the 9 reorder, even though the DB `sequence` puts WOOD_CUT 3rd.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CARD_HEIGHT, DEPARTMENTS, overviewStages, stageKind, stageTint } from "../src/pages/production/utils.ts";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");
const PAGE = read("src/pages/production/index.tsx");
const CARDS = read("src/pages/production/components/OverviewCards.tsx");

const TODAY = DEPARTMENTS.map((d) => d.code);

// Shaped like the seed: DB sequence order differs from the page's order.
const LIVE = [
  { code: "FAB_CUT", name: "Fabric Cutting", shortName: "Fab Cut", sequence: 1, isProduction: true },
  { code: "FAB_SEW", name: "Fabric Sewing", shortName: "Fab Sew", sequence: 2, isProduction: true },
  { code: "WOOD_CUT", name: "Wood Cutting", shortName: "Wood Cut", sequence: 3, isProduction: true },
  { code: "FOAM_CUTTING", name: "Foam Cutting", shortName: "Foam Cut", sequence: 4, isProduction: true },
  { code: "FOAM", name: "Foam", shortName: "Foam Bonding", sequence: 5, isProduction: true },
  { code: "FRAMING", name: "Framing", shortName: "Framing", sequence: 6, isProduction: true },
  { code: "WEBBING", name: "Webbing", shortName: "Webbing", sequence: 7, isProduction: true },
  { code: "UPHOLSTERY", name: "Upholstery", shortName: "Upholstery", sequence: 8, isProduction: true },
  { code: "PACKING", name: "Packing", shortName: "Packing", sequence: 9, isProduction: true },
  { code: "WAREHOUSING", name: "Warehousing", shortName: "WH", sequence: 10, isProduction: false },
];

test("no live list (loading / failed read) = the constant as-is", () => {
  assert.deepEqual(overviewStages(null).map((s) => s.code), TODAY);
  assert.deepEqual(overviewStages([]).map((s) => s.code), TODAY);
});

test("the live list never reorders or relabels today's 9 stages", () => {
  const stages = overviewStages(LIVE);
  assert.deepEqual(stages.map((s) => s.code), TODAY);
  assert.deepEqual(stages.map((s) => s.name), DEPARTMENTS.map((d) => d.name));
});

test("a new production dept is appended by sequence; non-production ones never show", () => {
  const stages = overviewStages([
    ...LIVE,
    { code: "QC_LATE", name: "Late QC", shortName: "", sequence: 30, isProduction: true },
    { code: "QC", name: "Quality Check", shortName: "QC", sequence: 20, isProduction: true },
  ]);
  assert.deepEqual(stages.map((s) => s.code), [...TODAY, "QC", "QC_LATE"]);
  assert.equal(stages.at(-2).name, "QC", "shortName wins");
  assert.equal(stages.at(-1).name, "Late QC", "falls back to name");
  assert.ok(!stages.some((s) => s.code === "WAREHOUSING"));
});

test("stageTint: any failed JC in the dept wins over ok ones", () => {
  const order = { jobCards: [
    { id: "a", departmentCode: "FOAM" },
    { id: "b", departmentCode: "FOAM" },
    { id: "c", departmentCode: "PACKING" },
  ] };
  assert.equal(stageTint(order, "FOAM", {}), "");
  assert.equal(stageTint(order, "FOAM", { "a|FOAM": "ok" }), "ok");
  assert.equal(stageTint(order, "FOAM", { "a|FOAM": "ok", "b|FOAM": "err" }), "err");
  assert.equal(stageTint(order, "PACKING", { "a|FOAM": "err" }), "");
});

test("pipeline columns come from the stage list, not a hardcoded 9", () => {
  assert.match(CARDS, /pipelineCols\(stages\.length\)/);
  assert.match(PAGE, /pipelineCols\(overviewStages\.length\)/, "sticky stage header uses the same template");
  assert.doesNotMatch(PAGE, /OVERVIEW_COL_KEYS/, "grid columns derive from overviewStages too");
});

test("cards and stage cells are memoized, fed stable handlers", () => {
  assert.match(CARDS, /export const WorkOrderCard = memo\(/);
  assert.match(CARDS, /const StageCell = memo\(/);
  assert.match(PAGE, /onStageClick=\{onOverviewStageClick\}/);
  assert.match(PAGE, /const onOverviewStageClick = useCallback<StageClick>\(\s*\(\.\.\.args\) => overviewStageClickRef\.current\(\.\.\.args\),\s*\[\],/);
});

test("the page opens on Cards and does not persist the choice", () => {
  assert.match(PAGE, /useState<"cards" \| "grid">\("cards"\)/);
});

test("stageKind: pill state per cell; in progress is display-only", () => {
  const cell = (state, doneCards, totalCards) => ({ state, doneCards, totalCards, earliestDue: "", latestCompleted: "", isOffLeadtime: false });
  assert.equal(stageKind(cell("empty", 0, 0)), "skipped");
  assert.equal(stageKind(cell("done", 2, 2)), "done");
  assert.equal(stageKind(cell("overdue", 1, 2)), "overdue", "overdue wins over partly done");
  assert.equal(stageKind(cell("pending", 1, 2)), "inProgress");
  assert.equal(stageKind(cell("pending", 0, 2)), "pending");
  // The saved status filter still only knows pending / overdue / done.
  assert.doesNotMatch(read("src/pages/production/types.ts"), /inProgress/);
});

test("cards have a fixed height equal to the virtualizer estimate", () => {
  assert.match(CARDS, /style=\{\{ height: CARD_HEIGHT,/);
  assert.match(PAGE, /estimateSize=\{CARD_HEIGHT\}/);
  assert.equal(CARD_HEIGHT, 128);
});

test("Grid keeps the original CellBox look; the Cards pills are separate", () => {
  assert.match(PAGE, /<CellBox cell=\{c\} \/>/);
  assert.ok(!CARDS.includes('from "./CellBox"'), "Cards must not render CellBox");
});
