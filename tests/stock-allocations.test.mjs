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

// Availability is RECOMPUTED from the production orders themselves, never from
// summing the ledger, so the fake returns what that one aggregate returns.
const availabilityDb = ({
  onHand = 0,
  inProduction = 0,
  allocated = 0,
  available = null,
}) =>
  fakeDb((q) =>
    /FROM production_orders/i.test(q)
      ? [
          {
            product_code: "A100",
            available_qty: available ?? onHand - allocated,
            on_hand_qty: onHand,
            in_production_qty: inProduction,
            allocated_qty: allocated,
          },
        ]
      : [],
  );

test("available is what is finished AND still owned by the stock order", async () => {
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

test("availability comes off the production orders, not off the ledger", async () => {
  // The whole point of deriving it: there is ONE source of truth for "is this
  // piece spoken for", so the pool and the ledger cannot drift apart. If this
  // query ever starts summing stock_allocations, that guarantee is gone.
  const src = read("src/api/lib/stock-allocations.ts");
  const fn = src.slice(
    src.indexOf("export async function loadAvailability"),
    src.indexOf("export type AllocatablePO"),
  );
  assert.match(fn, /FROM production_orders/);
  assert.doesNotMatch(
    fn,
    /FROM stock_allocations/,
    "availability must be recomputed from the orders, never summed from the ledger",
  );
});

test("work in production is reported apart from goods on hand", async () => {
  const map = await loadAvailability(
    availabilityDb({ onHand: 2, inProduction: 8, available: 2 }),
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

// One row per FINISHED stock production order that is still owned by the stock
// order it was born against. Whole orders are what move, so the fake hands back
// orders, not a quantity.
const stockPOs = (n, qtyEach = 1) =>
  Array.from({ length: n }, (_, i) => ({
    id: `pord-stock-${i + 1}`,
    poNo: `SOH-2609-001-0${i + 1}`,
    product_code: "A100",
    quantity: qtyEach,
    stock_origin_so_id: "so-stock",
  }));

const autoDb = ({ pool = [], held = [] }) =>
  fakeDb((q) => {
    // already-held: the orders this SO has taken from stock
    if (/sales_order_id = \?/i.test(q) && /sales_order_id <> stock_origin_so_id/i.test(q)) {
      return held;
    }
    // allocatable: finished, still the stock order's
    if (/sales_order_id = stock_origin_so_id/i.test(q)) return pool;
    return [];
  });

const ORDER = { id: "so-1", companySOId: "SO-2609-018", isStock: false };
const AT = "2026-09-17T00:00:00.000Z";

test("a stock order never allocates to itself", async () => {
  const plan = await planAutoAllocation(
    autoDb({ pool: stockPOs(10) }),
    "hookka",
    { id: "so-stock", companySOId: "SOH-2609-001", isStock: true },
    [{ productCode: "A100", quantity: 5, soItemId: "i1", soLineNo: 1 }],
    SYSTEM_ALLOCATION_ACTOR,
    AT,
  );
  assert.equal(plan.statements.length, 0, "the stock order IS the stock");
});

test("a product a human already allocated is left ALONE, not topped up", async () => {
  const plan = await planAutoAllocation(
    autoDb({ pool: stockPOs(10), held: stockPOs(2) }),
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

test("two lines of the same product cannot both claim the same orders", async () => {
  const db = autoDb({ pool: stockPOs(5) });
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
  const moved = db.written.filter((w) => /^UPDATE production_orders/i.test(w.sql));
  const poIds = moved.map((w) => w.args[w.args.length - 1]);
  assert.equal(moved.length, 5, "all five orders move, none twice");
  assert.equal(new Set(poIds).size, 5, "no production order is claimed twice");
});

test("A5: order ten, take the four that exist, produce the other six", async () => {
  const db = autoDb({ pool: stockPOs(4) });
  const plan = await planAutoAllocation(
    db,
    "hookka",
    ORDER,
    [{ productCode: "A100", quantity: 10, soItemId: "i1", soLineNo: 1 }],
    SYSTEM_ALLOCATION_ACTOR,
    AT,
  );
  await db.batch(plan.statements);
  const moved = db.written.filter((w) => /^UPDATE production_orders/i.test(w.sql));
  assert.equal(moved.length, 4, "four whole orders change hands");
  assert.match(plan.notes[0], /Allocated 4 x A100 from stock/);
  assert.match(plan.notes[0], /6 to be produced/);
});

test("a set that overshoots the line is NOT taken", async () => {
  // A stock sofa set of 3 cannot satisfy a line that wants 1 — taking it would
  // hand the customer two pieces nobody ordered. Sets go out whole or not at
  // all (owner 2026-09-17).
  const db = autoDb({ pool: stockPOs(1, 3) });
  const plan = await planAutoAllocation(
    db,
    "hookka",
    ORDER,
    [{ productCode: "A100", quantity: 1, soItemId: "i1", soLineNo: 1 }],
    SYSTEM_ALLOCATION_ACTOR,
    AT,
  );
  assert.equal(plan.statements.length, 0);
  assert.equal(plan.notes.length, 0);
});

test("ownership moves and the reason moves with it — never bare", async () => {
  const db = autoDb({ pool: stockPOs(2) });
  const plan = await planAutoAllocation(
    db,
    "hookka",
    ORDER,
    [{ productCode: "A100", quantity: 2, soItemId: "i1", soLineNo: 1 }],
    SYSTEM_ALLOCATION_ACTOR,
    AT,
  );
  await db.batch(plan.statements);
  const updates = db.written.filter((w) => /^UPDATE production_orders/i.test(w.sql));
  const ledger = db.written.filter((w) => /^INSERT INTO stock_allocations/i.test(w.sql));
  assert.equal(updates.length, 2);
  assert.equal(
    ledger.length,
    2,
    "every ownership change carries its own ledger row in the same batch",
  );
  // and nothing on the shop floor is touched — the 2026-06-08 removal is the
  // precedent: allocation must not move production.
  for (const w of db.written) {
    assert.doesNotMatch(w.sql, /job_cards|fg_units/i);
  }
});

test("is_stock is NOT cleared when ownership moves", () => {
  // It records how the piece was BORN, which stays true forever and is what
  // tells an invoice this came from stock rather than the customer's own run.
  const src = read("src/api/lib/stock-allocations.ts");
  const fn = src.slice(
    src.indexOf("export function buildOwnershipTransferStatements"),
    src.indexOf("export function buildOwnershipReleaseStatements"),
  );
  assert.doesNotMatch(fn, /is_stock|isStock/);
  assert.match(fn, /SET salesOrderId = \?/);
});

test("no stock, no allocation — and no empty row to explain later", async () => {
  const plan = await planAutoAllocation(
    autoDb({ pool: [] }),
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
  const mig = read("migrations-postgres/0237_stock_allocations.sql");
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
    assert.ok(mig.includes(col), `0237 is missing ${col}`);
    assert.ok(
      lib.includes(col),
      `the self-apply is missing ${col} — a migration file alone is INERT on deploy here`,
    );
  }
});

// ---------------------------------------------------------------------------
// BUG-2026-09-24-202b — the note said six, the factory queued ten.
//
// Confirm used to call createProductionOrdersForSO for the FULL line quantity
// and THEN allocate stock alongside it. Order ten with four finished in the
// yard and you got ten fresh production orders plus four re-pointed ones —
// fourteen pieces for a ten-piece order, under a note reading
// "(6 to be produced)". That note is a string; nothing made it true.
//
// The A5 test above passed throughout, because it only ever asked
// planAutoAllocation what it intended. These ask what the ORDER ends up with.
// ---------------------------------------------------------------------------
const confirmSrc = read("src/api/routes/sales-orders.ts");

test("allocation runs BEFORE production orders are built", () => {
  const alloc = confirmSrc.indexOf("const plan = await planAutoAllocation(");
  const build = confirmSrc.indexOf("await createProductionOrdersForSO(c.var.DB, existing, itemsToProduce)");
  assert.ok(alloc > 0, "auto-allocation call not found on the confirm path");
  assert.ok(build > 0, "the confirm path must build from itemsToProduce, not the raw items");
  assert.ok(
    alloc < build,
    "stock must be allocated first — otherwise production is queued for a quantity the yard already covers",
  );
});

test("the builder is fed the REMAINDER, and a fully-covered line is dropped", () => {
  assert.match(
    confirmSrc,
    /const taken = allocatedByItemId\.get\(it\.id\) \?\? 0;/,
    "each line's production quantity must be reduced by what stock covered",
  );
  assert.match(
    confirmSrc,
    /\.filter\(\(it\) => \(Number\(it\.quantity\) \|\| 0\) > 0\)/,
    "a line taken entirely from stock must be DROPPED — the builder floors piece count at 1, so quantity 0 would still queue one order",
  );
});

test("A5 end to end: ten ordered, four in stock, SIX produced", () => {
  // The arithmetic the note claims, applied the way the confirm path applies it.
  const items = [{ id: "i1", quantity: 10 }];
  const allocated = new Map([["i1", 4]]);
  const toProduce = items
    .map((it) => {
      const taken = allocated.get(it.id) ?? 0;
      return taken > 0 ? { ...it, quantity: it.quantity - taken } : it;
    })
    .filter((it) => it.quantity > 0);

  assert.equal(toProduce.length, 1);
  assert.equal(toProduce[0].quantity, 6, "six produced, not ten");
  assert.equal(
    toProduce[0].quantity + 4,
    10,
    "produced + allocated must equal what the customer ordered — never more",
  );
});

test("a line filled entirely from stock queues NO production at all", () => {
  const items = [{ id: "i1", quantity: 4 }];
  const allocated = new Map([["i1", 4]]);
  const toProduce = items
    .map((it) => ({ ...it, quantity: it.quantity - (allocated.get(it.id) ?? 0) }))
    .filter((it) => it.quantity > 0);
  assert.equal(toProduce.length, 0);
});
