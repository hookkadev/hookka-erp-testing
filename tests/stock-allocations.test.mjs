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

const autoDb = ({ pool = [], held = [], avail = null }) =>
  fakeDb((q) => {
    // The availability aggregate — matched FIRST because its CASE arms contain
    // both of the shapes the two branches below key on.
    if (/GROUP BY product_code/i.test(q)) {
      return avail
        ? [
            {
              productCode: "A100",
              availableQty: avail.available ?? 0,
              onHandQty: avail.onHand ?? 0,
              inProductionQty: 0,
              allocatedQty: avail.allocated ?? 0,
            },
          ]
        : [];
    }
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
  assert.equal(plan.statements.length, 0, "a 3-set cannot satisfy a line of 1");
  // A9 — and it says WHY. Silence here reads exactly like having no stock.
  assert.match(
    plan.notes[0] || "",
    /set of 3, larger than this line/,
  );
});

test("A9: the loser is told — stock exists but another order already has it", async () => {
  // Losing the race is invisible from the pool alone: once another order claims
  // the pieces they stop being offered, so an emptied pool looks exactly like a
  // product the factory never stocked. Availability tells the two apart.
  const db = autoDb({ pool: [], avail: { onHand: 4, available: 0, allocated: 4 } });
  const plan = await planAutoAllocation(
    db,
    "hookka",
    ORDER,
    [{ productCode: "A100", quantity: 4, soItemId: "i1", soLineNo: 1 }],
    SYSTEM_ALLOCATION_ACTOR,
    AT,
  );
  assert.equal(plan.statements.length, 0, "nothing left to take — no overselling");
  assert.match(plan.notes[0] || "", /all 4 on hand/);
  assert.match(plan.notes[0] || "", /already committed to other orders/);
});

test("a product nobody stocks stays silent — there is nothing to explain", async () => {
  const db = autoDb({ pool: [], avail: { onHand: 0, available: 0, allocated: 0 } });
  const plan = await planAutoAllocation(
    db,
    "hookka",
    ORDER,
    [{ productCode: "A100", quantity: 4, soItemId: "i1", soLineNo: 1 }],
    SYSTEM_ALLOCATION_ACTOR,
    AT,
  );
  assert.equal(plan.statements.length, 0);
  assert.equal(plan.notes.length, 0, "no stock is the normal case, not an event");
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

// ---------------------------------------------------------------------------
// BUG-2026-09-29-187 — every availability figure was silently zero.
//
// The Postgres adapter folds snake_case columns AND snake_case SELECT aliases
// to camelCase on read. `SUM(...) AS on_hand_qty` therefore arrives as
// `onHandQty`, and this module read `r.on_hand_qty` — undefined, coerced to 0,
// with no error anywhere. On staging the endpoint returned
// {onHandQty:0, inProductionQty:0, availableQty:0} with `productCode` missing
// entirely, minutes after four stock orders had been created.
//
// "No stock available" and "I cannot read the columns" rendered identically.
// CLAUDE.md's rule — read rows dual-keyed, `r.camelCase ?? r.snake_case` — is
// listed under the repo's #1 trap, and this walked straight into it.
//
// The earlier availability tests could not catch it: their fake returned
// snake_case, which is the half that was already working.
// ---------------------------------------------------------------------------
const camelDb = (row) =>
  fakeDb((q) => (/FROM production_orders/i.test(q) ? [row] : []));

test("availability reads the camelCase spelling the adapter actually returns", async () => {
  const map = await loadAvailability(
    camelDb({
      productCode: "A100",
      availableQty: 6,
      onHandQty: 10,
      inProductionQty: 3,
      allocatedQty: 4,
    }),
    "hookka",
    ["A100"],
  );
  const a = map.get("A100");
  assert.ok(a, "the row must be keyed by product code — an undefined key loses it entirely");
  assert.equal(a.productCode, "A100");
  assert.equal(a.onHandQty, 10);
  assert.equal(a.inProductionQty, 3);
  assert.equal(a.allocatedQty, 4);
  assert.equal(a.availableQty, 6);
});

test("availability still reads snake_case, so neither spelling is a regression", async () => {
  const map = await loadAvailability(
    camelDb({
      product_code: "A100",
      available_qty: 6,
      on_hand_qty: 10,
      in_production_qty: 3,
      allocated_qty: 4,
    }),
    "hookka",
    ["A100"],
  );
  assert.equal(map.get("A100").availableQty, 6);
});

test("allocatable orders read camelCase too", async () => {
  const { loadAllocatablePOs } = await import(
    pathToFileURL(resolve(process.cwd(), "src/api/lib/stock-allocations.ts")).href
  );
  const db = fakeDb((q) =>
    /sales_order_id = stock_origin_so_id/i.test(q)
      ? [{ id: "pord-1", poNo: "SOH-1", productCode: "A100", quantity: 1, stockOriginSoId: "so-stock" }]
      : [],
  );
  const pos = await loadAllocatablePOs(db, "A100");
  assert.equal(pos.length, 1);
  assert.equal(pos[0].productCode, "A100", "a blank product code would match nothing and allocate nothing");
  assert.equal(pos[0].stockOriginSoId, "so-stock", "a blank origin makes release unable to send the piece home");
});

test("no row read in this module uses a bare snake_case key", () => {
  // The failure mode is silent, so the guard is structural: every read of a
  // snake_case column goes through `camel ?? snake`, never snake alone.
  const src = read("src/api/lib/stock-allocations.ts");
  const bare = [...src.matchAll(/(?<![?\w.])r\.([a-z]+(?:_[a-z]+)+)/g)]
    .map((m) => m[0])
    .filter((hit) => !src.includes(`?? ${hit}`));
  assert.deepEqual(bare, [], `these reads would be undefined when the adapter camelCases: ${bare.join(", ")}`);
});

// ---------------------------------------------------------------------------
// BUG-2026-09-29-217 — a release did not cancel its own allocation.
//
// Measured on staging: four pieces allocated to SO-2609-394, then released.
// Ownership went home correctly and availability returned to 4 — but the
// order's netted holding still read 4, so the panel kept offering to release
// goods that were already back.
//
// The group key was (product, order, order_no, so_item_id, so_line_no). The
// ALLOCATE rows carried (soi-…, 1, SO-2609-394); the RELEASE counter-rows
// carried (null, null, null), because those fields come from the request body
// on the release path and nothing required them. Different groups, so the +4
// stayed open and the −4 was hidden by the HAVING.
//
// The fix is the KEY, not the write sites: a counter-row reverses a claim on a
// product by an order, and that pair is the identity. The rest is description.
//
// The old netting test could not catch it — it fed a ready-made `net_qty` row,
// so it verified the read and never exercised a release cancelling an
// allocation.
// ---------------------------------------------------------------------------
test("the netting group key is product + order ONLY", () => {
  const src = read("src/api/lib/stock-allocations.ts");
  const fn = src.slice(
    src.indexOf("export async function loadOpenAllocationsForOrder"),
    src.length,
  );
  const groupBy = (fn.match(/GROUP BY ([^\n]*)/) || [])[1] || "";
  assert.equal(
    groupBy.trim(),
    "product_code, sales_order_id",
    "descriptive columns in the key let a counter-row miss the claim it reverses",
  );
  for (const descriptive of ["so_item_id", "so_line_no", "sales_order_no"]) {
    assert.ok(
      !groupBy.includes(descriptive),
      `${descriptive} describes an allocation, it does not identify one`,
    );
  }
});

test("a release cancels an allocation even when it omits the line fields", async () => {
  // Exactly the staging shape: ALLOCATE carries the line, RELEASE does not.
  const rows = [];
  const db = fakeDb((q) => {
    if (!/FROM stock_allocations/i.test(q)) return [];
    // net by (product, order), the way the fixed query groups
    const net = rows.reduce((n, r) => n + r.direction * r.quantity, 0);
    return net > 0
      ? [{ productCode: "A100", salesOrderId: "so-1", salesOrderNo: "SO-1", soItemId: "i1", soLineNo: 1, netQty: net }]
      : [];
  });

  const at = "2026-09-29T00:00:00.000Z";
  // allocate 4, WITH line fields
  await db.batch([
    buildAllocationStatement(db, "ALLOCATE", {
      productCode: "A100", quantity: 4, salesOrderId: "so-1",
      salesOrderNo: "SO-1", soItemId: "i1", soLineNo: 1, occurredAt: at,
    }),
  ]);
  rows.push({ direction: 1, quantity: 4 });
  assert.equal((await loadOpenAllocationsForOrder(db, "so-1"))[0].quantity, 4);

  // release 4, WITHOUT them — the shape that broke it
  await db.batch([
    buildAllocationStatement(db, "RELEASE", {
      productCode: "A100", quantity: 4, salesOrderId: "so-1", occurredAt: at,
    }),
  ]);
  rows.push({ direction: -1, quantity: 4 });

  const after = await loadOpenAllocationsForOrder(db, "so-1");
  assert.equal(after.length, 0, "a fully released holding must disappear, not linger at 4");
});

// ── A7: the invoice for an allocated piece bills the CUSTOMER ───────────────
//
// The placeholder stock SO carries a sales_order_items row at
// `unitPriceSen: 0` (production-orders.ts:1337 — "insert minimal SO item so
// downstream readers don't crash"). An invoice line's price is resolved by
// `priceForItem` from `production_orders.salesOrderId`, which is EXACTLY the
// column allocation rewrites — so these pin that the rewrite is what makes the
// invoice bill RM 1,500 instead of that zero.

const { priceForItem, loadSoLinePriceIndex } = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/do-value.ts")).href
);

/** Two org-wide reads: the production orders, then every SO line. */
const priceDb = ({ pos, soLines }) =>
  fakeDb((q) => {
    if (/FROM production_orders WHERE orgId/i.test(q)) return pos;
    if (/FROM sales_order_items si/i.test(q)) return soLines;
    return [];
  });

const STOCK_LINE = {
  id: "si-stock",
  salesOrderId: "so-stock",
  productCode: "A100",
  sizeCode: "S",
  fabricCode: "F",
  unitPriceSen: 0, // the placeholder — never a price anyone is billed
};
const CUSTOMER_LINE = {
  id: "si-cust",
  salesOrderId: "so-cust",
  productCode: "A100",
  sizeCode: "S",
  fabricCode: "F",
  unitPriceSen: 150000, // RM 1,500.00
};

test("A7: an allocated piece is invoiced at the CUSTOMER's price, not the placeholder zero", async () => {
  // Post-allocation: the production order's salesOrderId now points at the
  // customer. stock_origin_so_id still remembers home, but pricing never reads it.
  const idx = await loadSoLinePriceIndex(
    priceDb({
      pos: [
        {
          id: "po-1",
          salesOrderId: "so-cust",
          productCode: "A100",
          sizeCode: "S",
          fabricCode: "F",
        },
      ],
      soLines: [STOCK_LINE, CUSTOMER_LINE],
    }),
    "hookka",
  );
  assert.equal(
    priceForItem(idx, "po-1", "so-cust", "A100"),
    150000,
    "the zero-priced stock line must not win over the customer's line",
  );
});

test("A7: before allocation the same piece prices at zero — nobody is billed for stock", async () => {
  const idx = await loadSoLinePriceIndex(
    priceDb({
      pos: [
        {
          id: "po-1",
          salesOrderId: "so-stock",
          productCode: "A100",
          sizeCode: "S",
          fabricCode: "F",
        },
      ],
      soLines: [STOCK_LINE, CUSTOMER_LINE],
    }),
    "hookka",
  );
  assert.equal(
    priceForItem(idx, "po-1", "so-stock", "A100"),
    0,
    "stock is not a sale; the placeholder's zero is the right answer here",
  );
});

test("FACT: byAnyCode is first-wins and a zero-priced stock line can take that slot", async () => {
  // NOT a pin of desired behaviour — a record of live exposure. `byAnyCode` is
  // priceForItem's last resort (do-value.ts:77) for a DO line with no usable PO
  // link, and it exists to STOP RM 0 invoices for real goods
  // (BUG-2026-05-18-004). It is built first-wins over an ORDER BY-less org-wide
  // SELECT, with no is_stock filter and no price > 0 preference. For a product
  // only ever built for stock the placeholder's zero is the ONLY candidate, so
  // the safety net returns 0 — the exact number it was added to prevent.
  //
  // Not reachable by an allocated piece (its DO line carries a PO whose
  // salesOrderId is the customer's, so resolution stops at byFull/byCode above).
  // If this assertion ever starts failing, someone fixed it — delete the test.
  const idx = await loadSoLinePriceIndex(
    priceDb({ pos: [], soLines: [STOCK_LINE] }),
    "hookka",
  );
  assert.equal(idx.byAnyCode.get("A100"), 0);
  assert.equal(
    priceForItem(idx, null, "", "A100"),
    0,
    "an unlinked line for a stock-only product falls through to zero",
  );
});
