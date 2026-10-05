// ---------------------------------------------------------------------------
// so-empty-wip-flag.test.mjs — findEmptyWipProducts, the lookup behind the
// Create SO "WIP components not filled" warning.
//
// Owner 2026-10-05: a product whose BOM WIP tab is empty must be flagged when
// the line is added, accessories included, because the job-card builder makes
// cards of its own for it. "Empty" must mean what the builder sees: the same
// row pick (newest ACTIVE, else newest of any status) and breakBomIntoWips'
// FG_MAIN fallback.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

const { findEmptyWipProducts } = await import(
  "../src/api/routes/sales-orders/_helpers.ts"
);

const WIP = JSON.stringify([
  { wipCode: "HB", wipType: "HEADBOARD", processes: [{ deptCode: "FAB_CUT" }] },
]);

function fakeDb(rows) {
  return {
    prepare: () => ({
      bind: () => ({ all: async () => ({ results: rows }) }),
    }),
  };
}

test("flags empty, missing, unparseable and L1-only BOMs; not a filled one", async () => {
  const db = fakeDb([
    { productCode: "FILLED", wipComponents: WIP, versionStatus: "ACTIVE", effectiveFrom: "2026-01-01" },
    { productCode: "EMPTY", wipComponents: "[]", versionStatus: "ACTIVE", effectiveFrom: "2026-01-01" },
    { productCode: "NULLWIP", wipComponents: null, versionStatus: "ACTIVE", effectiveFrom: "2026-01-01" },
    { productCode: "JUNK", wipComponents: "not json", versionStatus: "ACTIVE", effectiveFrom: "2026-01-01" },
  ]);
  const out = await findEmptyWipProducts(db, [
    "FILLED", "EMPTY", "NULLWIP", "JUNK", "NOBOM", "", " FILLED ",
  ]);
  assert.deepEqual(out.sort(), ["EMPTY", "JUNK", "NOBOM", "NULLWIP"]);
});

test("ACTIVE row wins over a newer draft, like the builder", async () => {
  const db = fakeDb([
    { productCode: "A", wipComponents: "[]", versionStatus: "ACTIVE", effectiveFrom: "2026-01-01" },
    { productCode: "A", wipComponents: WIP, versionStatus: "DRAFT", effectiveFrom: "2026-09-01" },
    { productCode: "B", wipComponents: "[]", versionStatus: "DRAFT", effectiveFrom: "2026-01-01" },
    { productCode: "B", wipComponents: WIP, versionStatus: "DRAFT", effectiveFrom: "2026-09-01" },
  ]);
  assert.deepEqual(await findEmptyWipProducts(db, ["A", "B"]), ["A"]);
});

test("no codes means no query", async () => {
  const db = { prepare: () => { throw new Error("should not query"); } };
  assert.deepEqual(await findEmptyWipProducts(db, ["", " "]), []);
});
