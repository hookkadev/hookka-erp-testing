// ---------------------------------------------------------------------------
// so-ready-accessory-gate.test.mjs — BUG-2026-10-01-241 (DEV-08).
//
// An SO with a sofa + pillows flipped to READY_TO_SHIP the moment the sofa's
// UPHOLSTERY cards were done, while the pillows were still on Fab Sew. The
// READY_TO_SHIP gate checks each sibling PO's UPHOLSTERY cards; a pillow PO
// (FAB_CUT → FAB_SEW → PACKING) has none, and "none" was read as "done".
//
// Fix: a sibling with no UPHOLSTERY card counts only once the PO itself is
// COMPLETED (or CANCELLED). One predicate, siblingUphGateDone, is shared by the
// SO forward cascade, its CO twin, and the SO rollback, so the directions agree.
//
// These run the real cascade functions against an in-memory DB stub.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  siblingUphGateDone,
  cascadeUpholsteryToSO,
  cascadeUpholsteryToCO,
  cascadeUpholsteryRollbackToSO,
} = await import("../src/api/routes/production-orders/_helpers.ts");

function fakeDb({ orders, pos, jcs }) {
  const run = (sql, args) => {
    let m;
    if (/^SELECT \* FROM production_orders WHERE id = \?/.test(sql)) {
      return { first: pos.find((p) => p.id === args[0]) ?? null };
    }
    if ((m = /FROM (sales_orders|consignment_orders) WHERE id = \?/.exec(sql)) && /^SELECT/.test(sql)) {
      return { first: orders.find((o) => o.id === args[0]) ?? null };
    }
    if ((m = /FROM production_orders WHERE (salesOrderId|consignmentOrderId) = \?/.exec(sql))) {
      return { all: pos.filter((p) => p[m[1]] === args[0]) };
    }
    if (/FROM job_cards\s+WHERE departmentCode = 'UPHOLSTERY'/.test(sql)) {
      return { all: jcs.filter((j) => j.departmentCode === "UPHOLSTERY" && args.includes(j.productionOrderId)) };
    }
    if ((m = /UPDATE (?:sales|consignment)_orders SET status = '(\w+)'.*WHERE id = \?/s.exec(sql))) {
      const o = orders.find((x) => x.id === args[args.length - 1]);
      if (o) o.status = m[1];
      return {};
    }
    if ((m = /UPDATE production_orders SET stockedIn = (\d) WHERE id = \?/.exec(sql))) {
      const p = pos.find((x) => x.id === args[0]);
      if (p) p.stockedIn = Number(m[1]);
      return {};
    }
    if (/^\s*INSERT INTO (so|co)_status_changes/.test(sql)) return {};
    if (/CREATE TABLE|CREATE INDEX|ALTER TABLE/i.test(sql)) return {};
    throw new Error(`fakeDb: unhandled SQL: ${sql.slice(0, 120)}`);
  };
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => run(sql, args).first ?? null,
    all: async () => ({ results: run(sql, args).all ?? [] }),
    run: async () => (run(sql, args), { success: true }),
    _exec: () => run(sql, args),
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (stmts) => stmts.map((s) => (s._exec(), { success: true })),
    exec: async () => ({}),
  };
}

const uph = (poId, status) => ({
  id: `jc-uph-${poId}`,
  productionOrderId: poId,
  departmentCode: "UPHOLSTERY",
  status,
  wipType: "SOFA_BASE",
});

function soScenario({ soStatus = "IN_PRODUCTION", sofaUph = "COMPLETED", pillowStatus = "IN_PROGRESS" } = {}) {
  return {
    orders: [{ id: "so-1", status: soStatus }],
    pos: [
      { id: "po-sofa", poNo: "SO-1-01", salesOrderId: "so-1", itemCategory: "SOFA", status: "IN_PROGRESS", stockedIn: 0 },
      { id: "po-pillow", poNo: "SO-1-02", salesOrderId: "so-1", itemCategory: "ACCESSORY", status: pillowStatus, stockedIn: 0 },
    ],
    jcs: [uph("po-sofa", sofaUph)],
  };
}

test("siblingUphGateDone: no UPHOLSTERY card needs the PO itself COMPLETED or CANCELLED", () => {
  assert.equal(siblingUphGateDone({ status: "IN_PROGRESS" }, []), false);
  assert.equal(siblingUphGateDone({ status: "PENDING" }, []), false);
  assert.equal(siblingUphGateDone({ status: "ON_HOLD" }, []), false);
  assert.equal(siblingUphGateDone({ status: "COMPLETED" }, []), true);
  assert.equal(siblingUphGateDone({ status: "CANCELLED" }, []), true);
  assert.equal(siblingUphGateDone(undefined, []), false);
});

test("siblingUphGateDone: with UPHOLSTERY cards, the cards decide (unchanged)", () => {
  assert.equal(siblingUphGateDone({ status: "IN_PROGRESS" }, [{ status: "COMPLETED" }, { status: "TRANSFERRED" }]), true);
  assert.equal(siblingUphGateDone({ status: "COMPLETED" }, [{ status: "COMPLETED" }, { status: "WAITING" }]), false);
});

test("SO stays IN_PRODUCTION when the sofa is upholstered but the pillow is still in progress", async () => {
  const s = soScenario();
  await cascadeUpholsteryToSO(fakeDb(s), "po-sofa");
  assert.equal(s.orders[0].status, "IN_PRODUCTION");
  assert.equal(s.pos[0].stockedIn, 0, "stockedIn is only stamped when the whole SO is ready");
});

test("SO flips to READY_TO_SHIP once the pillow PO is COMPLETED too", async () => {
  const s = soScenario({ pillowStatus: "COMPLETED" });
  await cascadeUpholsteryToSO(fakeDb(s), "po-pillow");
  assert.equal(s.orders[0].status, "READY_TO_SHIP");
  assert.equal(s.pos[0].stockedIn, 1);
});

test("a CANCELLED pillow does not hold the SO back", async () => {
  const s = soScenario({ pillowStatus: "CANCELLED" });
  await cascadeUpholsteryToSO(fakeDb(s), "po-sofa");
  assert.equal(s.orders[0].status, "READY_TO_SHIP");
});

test("an SO already wrongly at READY_TO_SHIP drops back on the next cascade while the pillow is unfinished", async () => {
  const s = soScenario({ soStatus: "READY_TO_SHIP" });
  await cascadeUpholsteryToSO(fakeDb(s), "po-pillow");
  assert.equal(s.orders[0].status, "IN_PRODUCTION");
});

test("rollback uses the same gate: an unfinished pillow is not 'still ready'", async () => {
  const s = soScenario({ soStatus: "READY_TO_SHIP" });
  await cascadeUpholsteryRollbackToSO(fakeDb(s), "po-sofa", "tester");
  assert.equal(s.orders[0].status, "IN_PRODUCTION");

  const done = soScenario({ soStatus: "READY_TO_SHIP", pillowStatus: "COMPLETED" });
  await cascadeUpholsteryRollbackToSO(fakeDb(done), "po-sofa", "tester");
  assert.equal(done.orders[0].status, "READY_TO_SHIP");
});

test("class guard (C28): no READY_TO_SHIP gate in _helpers.ts treats zero UPHOLSTERY cards as done", () => {
  const src = readFileSync(new URL("../src/api/routes/production-orders/_helpers.ts", import.meta.url), "utf8");
  assert.ok(
    !/mine\.length === 0\)\s*return true/.test(src),
    "use siblingUphGateDone instead of a vacuous-true empty UPHOLSTERY set",
  );
  assert.equal(src.match(/siblingUphGateDone\(/g)?.length, 4, "definition + SO forward + CO forward + SO rollback");
});

test("CO twin: same gate for consignment orders", async () => {
  const mk = (pillowStatus) => ({
    orders: [{ id: "co-1", status: "IN_PRODUCTION" }],
    pos: [
      { id: "po-sofa", poNo: "CO-1-01", consignmentOrderId: "co-1", itemCategory: "SOFA", status: "IN_PROGRESS", stockedIn: 0 },
      { id: "po-pillow", poNo: "CO-1-02", consignmentOrderId: "co-1", itemCategory: "ACCESSORY", status: pillowStatus, stockedIn: 0 },
    ],
    jcs: [uph("po-sofa", "COMPLETED")],
  });
  const pending = mk("IN_PROGRESS");
  await cascadeUpholsteryToCO(fakeDb(pending), "po-sofa");
  assert.equal(pending.orders[0].status, "IN_PRODUCTION");

  const done = mk("COMPLETED");
  await cascadeUpholsteryToCO(fakeDb(done), "po-pillow");
  assert.equal(done.orders[0].status, "READY_TO_SHIP");
});
