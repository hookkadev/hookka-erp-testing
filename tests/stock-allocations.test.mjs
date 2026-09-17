// ---------------------------------------------------------------------------
// stock-allocations.test.mjs — goods built for stock must be handed to an
// order through a LEDGER, not by editing the order they were born against.
//
// THE HOLE this covers. Nothing could reserve anything: "Reserved" on the
// inventory screen means only "a DRAFT delivery note names the item", which is
// downstream of production rather than an order commitment. A production order
// was married to its sales order at birth and no code anywhere changed that
// link, so finished stock could sit in the yard with no way to point it at the
// customer who turned up.
//
// These tests pin BEHAVIOUR, not wiring:
//   • the sign is derived from the ACTION, so no call site can get it wrong;
//   • a release is a COUNTER-ROW — never an edit, never a delete;
//   • availability is on hand MINUS what is spoken for, and never negative;
//   • partial allocation is the normal case (order ten, take four, make six);
//   • work still in production is reported separately from goods on hand, so a
//     delivery date is never promised against something nobody has built yet.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const read = (p) =>
  readFileSync(resolve(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const {
  directionFor,
  buildAllocationStatement,
  loadAvailability,
  loadOpenAllocationsForOrder,
  planAutoAllocation,
  SYSTEM_ALLOCATION_ACTOR,
} = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/stock-allocations.ts")).href
);

// ── a fake D1 that answers by table and records what it was asked ──────────

function fakeDb(rowsFor = () => []) {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const written = [];
  const db = {
    written,
    prepare(sql) {
      const q = norm(sql);
      const mk = (args) => ({
        sql: q,
        args,
        bind: (...a) => mk(a),
        async run() {
          written.push({ sql: q, args });
          return { success: true };
        },
        async all() {
          return { results: rowsFor(q, args) };
        },
        async first() {
          return rowsFor(q, args)[0] ?? null;
        },
      });
      return mk([]);
    },
    async batch(stmts) {
      for (const s of stmts) await s.run();
      return stmts.map(() => ({ success: true }));
    },
  };
  return db;
}

const bindsOf = (stmt) => {
  const cols = stmt.sql
    .slice(stmt.sql.indexOf("(") + 1, stmt.sql.indexOf(")"))
    .split(",")
    .map((s) => s.trim());
  return Object.fromEntries(cols.map((c, i) => [c, stmt.args[i]]));
};

// ── the one arithmetic rule ────────────────────────────────────────────────

test("the sign comes from the action, not from the caller", () => {
  assert.equal(directionFor("ALLOCATE"), 1);
  assert.equal(directionFor("RELEASE"), -1);
});

test("quantity is stored POSITIVE on both actions — only direction differs", async () => {
  const db = fakeDb();
  const base = {
    productCode: "A100",
    quantity: 4,
    salesOrderId: "so-1",
    occurredAt: "2026-09-17T00:00:00.000Z",
  };
  await db.batch([
    buildAllocationStatement(db, "ALLOCATE", base),
    buildAllocationStatement(db, "RELEASE", base),
  ]);

  const [alloc, rel] = db.written.map((w) => bindsOf(w));
  assert.equal(alloc.quantity, 4);
  assert.equal(alloc.direction, 1);
  assert.equal(rel.quantity, 4, "a release stores a positive quantity too");
  assert.equal(rel.direction, -1, "the minus lives in direction, alone");
});

test("a caller passing a negative quantity cannot flip the sign", async () => {
  const db = fakeDb();
  await db.batch([
    buildAllocationStatement(db, "ALLOCATE", {
      productCode: "A100",
      quantity: -4,
      salesOrderId: "so-1",
      occurredAt: "2026-09-17T00:00:00.000Z",
    }),
  ]);
  const row = bindsOf(db.written[0]);
  assert.equal(row.quantity, 0, "clamped, never negative");
  assert.equal(row.direction, 1, "still an ALLOCATE");
});

// ── availability ───────────────────────────────────────────────────────────

const availabilityDb = ({ onHand = 0, inProduction = 0, allocated = 0 }) =>
  fakeDb((q) => {
    if (/FROM production_orders/i.test(q)) {
      return [
        {
          product_code: "A100",
          on_hand_qty: onHand,
          in_production_qty: inProduction,
        },
      ];
    }
    if (/FROM stock_allocations/i.test(q)) {
      return [{ product_code: "A100", allocated_qty: allocated }];
    }
    return [];
  });

test("available = on hand minus what is spoken for", async () => {
  const map = await loadAvailability(
    availabilityDb({ onHand: 10, allocated: 4 }),
    "hookka",
    ["A100"],
  );
  const a = map.get("A100");
  assert.equal(a.onHandQty, 10);
  assert.equal(a.allocatedQty, 4);
  assert.equal(a.availableQty, 6);
});

test("an over-allocated product reads as ZERO available, never negative", async () => {
  const map = await loadAvailability(
    availabilityDb({ onHand: 4, allocated: 6 }),
    "hookka",
    ["A100"],
  );
  assert.equal(map.get("A100").availableQty, 0);
  assert.equal(
    map.get("A100").allocatedQty,
    6,
    "the overshoot is still VISIBLE — it is reported, not hidden",
  );
});

test("work in production is reported apart from goods on hand", async () => {
  const map = await loadAvailability(
    availabilityDb({ onHand: 2, inProduction: 8 }),
    "hookka",
    ["A100"],
  );
  const a = map.get("A100");
  assert.equal(a.onHandQty, 2);
  assert.equal(a.inProductionQty, 8);
  assert.equal(
    a.availableQty,
    2,
    "a delivery date is promised against what EXISTS, not against what is planned",
  );
});

test("A5: order ten, allocate four from stock, produce the remaining six", async () => {
  const before = await loadAvailability(
    availabilityDb({ onHand: 4, allocated: 0 }),
    "hookka",
    ["A100"],
  );
  assert.equal(before.get("A100").availableQty, 4, "only four exist");

  const ordered = 10;
  const takeFromStock = Math.min(ordered, before.get("A100").availableQty);
  assert.equal(takeFromStock, 4);
  assert.equal(ordered - takeFromStock, 6, "six still have to be made");

  const after = await loadAvailability(
    availabilityDb({ onHand: 4, allocated: takeFromStock }),
    "hookka",
    ["A100"],
  );
  assert.equal(after.get("A100").availableQty, 0, "nothing left for the next order");
});

// ── netting ────────────────────────────────────────────────────────────────

test("an order's holding is NET of releases; a fully released line is absent", async () => {
  const db = fakeDb((q) =>
    /FROM stock_allocations/i.test(q)
      ? [
          {
            product_code: "A100",
            sales_order_id: "so-1",
            sales_order_no: "SO-2609-018",
            so_item_id: "item-1",
            so_line_no: 1,
            net_qty: 2,
          },
        ]
      : [],
  );
  const open = await loadOpenAllocationsForOrder(db, "so-1");
  assert.equal(open.length, 1);
  assert.equal(open[0].quantity, 2);
  assert.equal(open[0].salesOrderNo, "SO-2609-018");

  const sql = db.written.length ? db.written[0].sql : "";
  assert.ok(
    /HAVING SUM\(direction \* quantity\) > 0/i.test(
      sql || read("src/api/lib/stock-allocations.ts").replace(/\s+/g, " "),
    ),
    "lines that net to zero are dropped, not shown as a zero to release again",
  );
});

// ── auto-allocation on confirm, and the rails on it ────────────────────────
//
// The owner removed an automatic cross-order redirect on 2026-06-08 because
// scanning a sticker silently completed a DIFFERENT order's card. Automatic
// allocation is the same shape of idea, so each rail it is allowed under is
// pinned here rather than left to a comment.

const autoDb = ({ onHand = 0, allocated = 0, held = [] }) =>
  fakeDb((q) => {
    if (/FROM production_orders/i.test(q)) {
      return [{ product_code: "A100", on_hand_qty: onHand, in_production_qty: 0 }];
    }
    if (/net_qty/i.test(q) || /HAVING/i.test(q)) return held;
    if (/FROM stock_allocations/i.test(q)) {
      return [{ product_code: "A100", allocated_qty: allocated }];
    }
    return [];
  });

const ORDER = { id: "so-1", companySOId: "SO-2609-018", isStock: false };
const AT = "2026-09-17T00:00:00.000Z";

test("a stock order never allocates to itself", async () => {
  const plan = await planAutoAllocation(
    autoDb({ onHand: 10 }),
    "hookka",
    { id: "so-stock", companySOId: "SOH-2609-001", isStock: true },
    [{ productCode: "A100", quantity: 5, soItemId: "i1", soLineNo: 1 }],
    SYSTEM_ALLOCATION_ACTOR,
    AT,
  );
  assert.equal(plan.statements.length, 0, "the stock order IS the stock");
});

test("a line a human already allocated is left ALONE, not topped up", async () => {
  const plan = await planAutoAllocation(
    autoDb({
      onHand: 10,
      allocated: 2,
      held: [
        {
          product_code: "A100",
          sales_order_id: "so-1",
          sales_order_no: "SO-2609-018",
          so_item_id: "i1",
          so_line_no: 1,
          net_qty: 2,
        },
      ],
    }),
    "hookka",
    ORDER,
    [{ productCode: "A100", quantity: 10, soItemId: "i1", soLineNo: 1 }],
    SYSTEM_ALLOCATION_ACTOR,
    AT,
  );
  assert.equal(
    plan.statements.length,
    0,
    "a manual decision wins — nothing moves behind the operator's back",
  );
});

test("two lines of the same product cannot both claim the same pieces", async () => {
  const db = autoDb({ onHand: 5 });
  const plan = await planAutoAllocation(
    db,
    "hookka",
    ORDER,
    [
      { productCode: "A100", quantity: 4, soItemId: "i1", soLineNo: 1 },
      { productCode: "A100", quantity: 4, soItemId: "i2", soLineNo: 2 },
    ],
    SYSTEM_ALLOCATION_ACTOR,
    AT,
  );
  await db.batch(plan.statements);
  const taken = db.written.map((w) => Number(bindsOf(w).quantity));
  assert.deepEqual(taken, [4, 1], "the second line gets only what is left");
  assert.equal(
    taken.reduce((a, b) => a + b, 0),
    5,
    "never more than exists",
  );
});

test("partial allocation says out loud how many still have to be made", async () => {
  const plan = await planAutoAllocation(
    autoDb({ onHand: 4 }),
    "hookka",
    ORDER,
    [{ productCode: "A100", quantity: 10, soItemId: "i1", soLineNo: 1 }],
    SYSTEM_ALLOCATION_ACTOR,
    AT,
  );
  assert.equal(plan.statements.length, 1);
  assert.match(plan.notes[0], /Allocated 4 x A100 from stock/);
  assert.match(plan.notes[0], /6 to be produced/);
});

test("nothing on the shop floor is touched — ledger rows only", async () => {
  const db = autoDb({ onHand: 10 });
  const plan = await planAutoAllocation(
    db,
    "hookka",
    ORDER,
    [{ productCode: "A100", quantity: 3, soItemId: "i1", soLineNo: 1 }],
    SYSTEM_ALLOCATION_ACTOR,
    AT,
  );
  await db.batch(plan.statements);
  for (const w of db.written) {
    assert.match(
      w.sql,
      /^INSERT INTO stock_allocations/i,
      "the 2026-06-08 removal is the precedent: allocation must not move production",
    );
  }
});

test("no stock, no allocation — and no empty row to explain later", async () => {
  const plan = await planAutoAllocation(
    autoDb({ onHand: 0 }),
    "hookka",
    ORDER,
    [{ productCode: "A100", quantity: 6, soItemId: "i1", soLineNo: 1 }],
    SYSTEM_ALLOCATION_ACTOR,
    AT,
  );
  assert.equal(plan.statements.length, 0);
  assert.equal(plan.notes.length, 0);
});

// ── the append-only discipline ─────────────────────────────────────────────

test("no code path UPDATEs or DELETEs an allocation row", () => {
  const sources = [
    "src/api/lib/stock-allocations.ts",
    "src/api/routes/stock-allocations.ts",
  ];
  for (const p of sources) {
    const src = read(p);
    assert.ok(
      !/UPDATE\s+stock_allocations/i.test(src),
      `${p} must never UPDATE the ledger — a reversal is a counter-row`,
    );
    assert.ok(
      !/DELETE\s+FROM\s+stock_allocations/i.test(src),
      `${p} must never DELETE from the ledger`,
    );
  }
});

test("the migration and the runtime self-apply declare the same table", () => {
  const mig = read("migrations-postgres/0236_stock_allocations.sql");
  const lib = read("src/api/lib/stock-allocations.ts");
  for (const col of [
    "product_code",
    "sales_order_id",
    "so_item_id",
    "so_line_no",
    "direction",
    "quantity",
    "reverses_id",
    "occurred_at",
  ]) {
    assert.ok(mig.includes(col), `0236 is missing ${col}`);
    assert.ok(
      lib.includes(col),
      `the self-apply is missing ${col} — a migration file alone is INERT on deploy here`,
    );
  }
});
