// ---------------------------------------------------------------------------
// cn-po-once.test.mjs — a production order can only be on ONE live consignment
// note (BUG-2026-10-01-237).
//
// Staging carried the same 23 POs on four Houzs CNs and the same 5 on four
// Carress CNs: the CN write paths checked a PO against delivery orders only,
// never against other CNs, and the Pending CN list served a stale snapshot
// right after Create CN, so a second click made a second CN.
//
// Pinned here:
//   1. validatePOMutex("CN") refuses a PO already on a non-cancelled CN, names
//      the PO and the CN, ignores CANCELLED CNs, and skips the CN being edited;
//   2. updateConsignmentNoteById refuses an items-replace that adds such a PO
//      BEFORE it deletes anything;
//   3. all four write paths (CN create/edit, legacy create/edit) go through it.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on newer Node.
}
register("./tests/_alias-loader.mjs", pathToFileURL("./"));

const src = (p) => pathToFileURL(resolve(process.cwd(), p)).href;
const { validatePOMutex, updateConsignmentNoteById } = await import(
  src("src/api/lib/consignment-note-shared.ts")
);

const NOTES = [
  { id: "cn-a", noteNumber: "CGN-2609-003", status: "PARTIALLY_SOLD" },
  { id: "cn-b", noteNumber: "CGN-2609-010", status: "ACTIVE" },
  { id: "cn-x", noteNumber: "CGN-2609-099", status: "CANCELLED" },
];
const CN_ITEMS = [
  { consignmentNoteId: "cn-a", productionOrderId: "po-1" },
  { consignmentNoteId: "cn-x", productionOrderId: "po-2" },
  { consignmentNoteId: "cn-b", productionOrderId: "po-3" },
];
const DO_ITEMS = [{ productionOrderId: "po-9" }];
const PO_NO = { "po-1": "CO-2608-004-01", "po-2": "CO-2608-004-02", "po-3": "CO-2608-003-01" };

function mockDb() {
  const writes = [];
  const db = {
    writes,
    prepare(sql) {
      let binds = [];
      const stmt = {
        bind(...b) {
          binds = b;
          return stmt;
        },
        async all() {
          if (/delivery_order_items/.test(sql)) {
            const ids = new Set(binds);
            return { results: DO_ITEMS.filter((r) => ids.has(r.productionOrderId)).map((r) => ({ poId: r.productionOrderId })) };
          }
          if (/FROM consignment_items ci[\s\S]*JOIN consignment_notes cn/.test(sql)) {
            const exclude = /cn\.id <> \?/.test(sql) ? binds[binds.length - 1] : null;
            const ids = new Set(exclude ? binds.slice(0, -1) : binds);
            const results = CN_ITEMS.filter((i) => ids.has(i.productionOrderId))
              .map((i) => ({ i, n: NOTES.find((n) => n.id === i.consignmentNoteId) }))
              .filter(({ n }) => n.status !== "CANCELLED" && n.id !== exclude)
              .map(({ i, n }) => ({ poId: i.productionOrderId, noteNumber: n.noteNumber, poNo: PO_NO[i.productionOrderId] }));
            return { results };
          }
          return { results: [] };
        },
        async first() {
          if (/FROM consignment_notes WHERE id = \?/.test(sql)) return NOTES.find((n) => n.id === binds[0]) ?? null;
          return null;
        },
        async run() {
          writes.push(sql);
          return { success: true };
        },
      };
      return stmt;
    },
    async batch(stmts) {
      writes.push(...stmts.map(() => "batch"));
      return [];
    },
  };
  return db;
}

test("a PO already on a live CN is refused, naming the PO and the CN", async () => {
  const res = await validatePOMutex(mockDb(), ["po-1"], "CN");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "cn_active");
  assert.deepEqual(res.conflicts, ["po-1"]);
  assert.match(res.message, /CO-2608-004-01 on CGN-2609-003/);
});

test("a PO only on a CANCELLED CN is free", async () => {
  assert.deepEqual(await validatePOMutex(mockDb(), ["po-2"], "CN"), { ok: true });
});

test("the CN being edited does not conflict with itself", async () => {
  assert.deepEqual(await validatePOMutex(mockDb(), ["po-3"], "CN", "cn-b"), { ok: true });
  const other = await validatePOMutex(mockDb(), ["po-3"], "CN", "cn-a");
  assert.equal(other.ok, false);
});

test("the delivery-order check still runs first", async () => {
  const res = await validatePOMutex(mockDb(), ["po-9", "po-1"], "CN");
  assert.equal(res.reason, "do_active");
  assert.deepEqual(res.conflicts, ["po-9"]);
});

test("CN edit refuses to add a PO that is on another CN, before deleting anything", async () => {
  const db = mockDb();
  const res = await updateConsignmentNoteById(db, "cn-b", {
    items: [{ productionOrderId: "po-3" }, { productionOrderId: "po-1" }],
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "po_conflict");
  assert.match(res.message, /CGN-2609-003/);
  assert.deepEqual(db.writes, []);
});

test("every CN write path goes through the guard", () => {
  const notes = readFileSync("src/api/routes/consignment-notes.ts", "utf8");
  const legacy = readFileSync("src/api/routes/consignments.ts", "utf8");
  const shared = readFileSync("src/api/lib/consignment-note-shared.ts", "utf8");
  // create: both POST handlers, both item sources
  assert.equal((notes.match(/validatePOMutex\(c\.var\.DB, \w+, "CN"\)/g) ?? []).length, 2);
  assert.equal((legacy.match(/validatePOMutex\(c\.var\.DB, \w+, "CN"\)/g) ?? []).length, 2);
  // edit: the shared helper (CN PUT/PATCH) and the legacy PUT, which writes items itself
  assert.match(shared, /validatePOMutex\(db, poIds, "CN", id\)/);
  assert.match(legacy, /validatePOMutex\(c\.var\.DB, poIds, "CN", id\)/);
  assert.match(notes, /res\.reason === "po_conflict"/);
});
