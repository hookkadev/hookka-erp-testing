// ---------------------------------------------------------------------------
// service-case-customer-po.test.mjs — DEV-13: the Service Cases list shows the
// source order's Customer PO. Pins loadCustomerPoBySource: SO cases read
// sales_orders.customerPOId, CO cases read consignment_orders.customerCOId,
// EXTERNAL cases query nothing, and duplicate source ids are queried once.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* native type-stripping on Node 22+ */
}

const { loadCustomerPoBySource } = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/routes/service-cases.ts")).href
);

function fakeDb(tables) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...ids) {
          calls.push({ sql, ids });
          const table = sql.match(/FROM (\w+)/)[1];
          return {
            all: async () => ({
              results: ids.map((id) => ({ id, customerPO: tables[table]?.[id] ?? null })),
            }),
          };
        },
      };
    },
  };
}

test("maps SO + CO sources to their customer PO; EXTERNAL gets none", async () => {
  const db = fakeDb({
    sales_orders: { so1: "ART-HOK-062", so2: null },
    consignment_orders: { co1: "CPO-9" },
  });
  const rows = [
    { sourceType: "SO", sourceId: "so1" },
    { sourceType: "SO", sourceId: "so1" },
    { sourceType: "SO", sourceId: "so2" },
    { sourceType: "CO", sourceId: "co1" },
    { sourceType: "EXTERNAL", sourceId: null },
  ];
  const map = await loadCustomerPoBySource(db, rows);
  assert.equal(map.get("so1"), "ART-HOK-062");
  assert.equal(map.has("so2"), false);
  assert.equal(map.get("co1"), "CPO-9");
  assert.equal(db.calls.length, 2);
  assert.match(db.calls[0].sql, /customerPOId AS "customerPO" FROM sales_orders/);
  assert.deepEqual(db.calls[0].ids, ["so1", "so2"]);
  assert.match(db.calls[1].sql, /customerCOId AS "customerPO" FROM consignment_orders/);
});

test("no SO/CO cases → no queries", async () => {
  const db = fakeDb({});
  const map = await loadCustomerPoBySource(db, [{ sourceType: "EXTERNAL", sourceId: null }]);
  assert.equal(map.size, 0);
  assert.equal(db.calls.length, 0);
});
