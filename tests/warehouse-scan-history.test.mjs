// ---------------------------------------------------------------------------
// warehouse-scan-history.test.mjs — DEV-09 Mobile Warehouse (behaviour).
//
// The rack-QR scan flow (/r/<rackId> → POST /api/public/rack-qr/:rackId/stock-in)
// is the one path that puts a piece into a rack from a phone. DEV-09 needs its
// history to answer "who moved PO-001, from where, to where, when":
//   1. the movement's rackLabel is the rack's LABEL ("Rack 3"), not its id;
//   2. performedBy is the logged-in user's name (session only, never the body),
//      "Public scan" with no session;
//   3. a cross-rack move writes a TRANSFER "Moved from <old rack>" and removes
//      the old rack_items row — a first stock-in stays a plain STOCK_IN;
// and GET /api/warehouse/locate finds a piece by SO / PO / customer PO / model.
//
// Real route code, real SQL, on node:sqlite through a D1-shaped shim that
// camelCases result keys like db-pg.ts does (same harness as
// notifications-scope.test.mjs).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  /* older Node — every case below skips */
}
const needsSqlite = DatabaseSync
  ? {}
  : { skip: "node:sqlite requires Node 22+ (this runtime is older)" };

const { default: publicRackQr } = await import("../src/api/routes/public-rack-qr.ts");
const { default: warehouse } = await import("../src/api/routes/warehouse.ts");

const toCamel = (s) => s.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
const camelRow = (row) =>
  row ? Object.fromEntries(Object.entries(row).map(([k, v]) => [toCamel(k), v])) : null;

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.function("NOW", () => new Date().toISOString());
  db.exec(`
    CREATE TABLE rack_locations (id TEXT PRIMARY KEY, rack TEXT, status TEXT);
    CREATE TABLE rack_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, rackLocationId TEXT, productionOrderId TEXT,
      productCode TEXT, productName TEXT, sizeLabel TEXT, customerName TEXT, qty INTEGER,
      stockedInDate TEXT, notes TEXT);
    CREATE TABLE stock_movements (
      id TEXT PRIMARY KEY, type TEXT, rackLocationId TEXT, rackLabel TEXT,
      productionOrderId TEXT, productCode TEXT, productName TEXT, quantity INTEGER,
      reason TEXT, performedBy TEXT, created_at TEXT);
    CREATE TABLE job_cards (id TEXT PRIMARY KEY, productionOrderId TEXT, wipLabel TEXT,
      rackingNumber TEXT, updated_at TEXT);
    CREATE TABLE users (id TEXT PRIMARY KEY, displayName TEXT, email TEXT);
    CREATE TABLE production_orders (id TEXT PRIMARY KEY, poNo TEXT, customerPOId TEXT,
      salesOrderNo TEXT, productCode TEXT, customerName TEXT);
    INSERT INTO rack_locations VALUES ('rk-a', 'Rack A01', 'EMPTY'), ('rk-b', 'Rack B03', 'EMPTY');
    INSERT INTO users VALUES ('u-violet', 'VIOLET', 'violet@example.com');
    INSERT INTO production_orders VALUES
      ('po-1', 'PO-001', 'CUST-PO-77', 'SO-2609-001', 'SOFA-A', 'Acme Furniture');
    INSERT INTO job_cards VALUES ('jc-1', 'po-1', 'Sofa A', NULL, NULL);
  `);
  const stmt = (sql) => {
    let bound = [];
    const api = {
      bind(...args) {
        bound = args;
        return api;
      },
      async first() {
        return camelRow(db.prepare(sql).get(...bound));
      },
      async all() {
        return { results: db.prepare(sql).all(...bound).map(camelRow), success: true };
      },
      async run() {
        const info = db.prepare(sql).run(...bound);
        return { success: true, meta: { changes: Number(info.changes) } };
      },
    };
    return api;
  };
  const shim = {
    prepare: stmt,
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
  return { db, shim };
}

function mount(shim, { userId, userRole } = {}) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("DB", shim);
    if (userId) c.set("userId", userId);
    if (userRole) c.set("userRole", userRole);
    await next();
  });
  app.route("/api/public/rack-qr", publicRackQr);
  app.route("/api/warehouse", warehouse);
  return app;
}

const PIECE = {
  productionOrderId: "po-1",
  productName: "Sofa A",
  description: "Sofa A",
  poNo: "PO-001",
  salesOrderNo: "SO-2609-001",
};

async function stockIn(app, rackId) {
  const res = await app.request(`/api/public/rack-qr/${rackId}/stock-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [PIECE] }),
  });
  assert.equal(res.status, 200, "stock-in must succeed");
}

const movements = (db) =>
  db.prepare("SELECT type, rackLabel, reason, performedBy FROM stock_movements ORDER BY created_at, rowid").all();

test("a logged-in scan records the user's name and the rack LABEL", needsSqlite, async () => {
  const { db, shim } = makeDb();
  await stockIn(mount(shim, { userId: "u-violet" }), "rk-a");
  const [m] = movements(db);
  assert.equal(m.type, "STOCK_IN");
  assert.equal(m.rackLabel, "Rack A01", "rackLabel must be the label, not the rack id");
  assert.equal(m.performedBy, "VIOLET");
});

test("a scan with no session stays 'Public scan'", needsSqlite, async () => {
  const { db, shim } = makeDb();
  await stockIn(mount(shim), "rk-a");
  assert.equal(movements(db)[0].performedBy, "Public scan");
});

test("re-scanning into another rack MOVES it and logs a TRANSFER from → to", needsSqlite, async () => {
  const { db, shim } = makeDb();
  const app = mount(shim, { userId: "u-violet" });
  await stockIn(app, "rk-a");
  await stockIn(app, "rk-b");

  const racks = db.prepare("SELECT rackLocationId FROM rack_items").all();
  assert.deepEqual(racks.map((r) => r.rackLocationId), ["rk-b"], "old rack row removed, one row left");

  const [first, second] = movements(db);
  assert.equal(first.type, "STOCK_IN");
  assert.equal(second.type, "TRANSFER");
  assert.equal(second.rackLabel, "Rack B03");
  assert.equal(second.reason, "Moved from Rack A01");
  assert.equal(second.performedBy, "VIOLET");

  const jc = db.prepare("SELECT rackingNumber FROM job_cards WHERE id = 'jc-1'").get();
  assert.equal(jc.rackingNumber, "Rack B03", "the job card follows the move");
});

test("re-scanning into the SAME rack is not a move", needsSqlite, async () => {
  const { db, shim } = makeDb();
  const app = mount(shim);
  await stockIn(app, "rk-a");
  await stockIn(app, "rk-a");
  assert.deepEqual(movements(db).map((m) => m.type), ["STOCK_IN", "STOCK_IN"]);
});

for (const [label, q] of [
  ["SO", "so-2609-001"],
  ["PO", "PO-001"],
  ["customer PO", "cust-po-77"],
  ["item code", "sofa-a"],
  ["model", "sofa a"],
  ["customer", "acme"],
]) {
  test(`locate finds the piece's rack by ${label}`, needsSqlite, async () => {
    const { shim } = makeDb();
    const app = mount(shim, { userId: "u-violet", userRole: "ADMIN" });
    await stockIn(app, "rk-b");
    const res = await app.request(`/api/warehouse/locate?q=${encodeURIComponent(q)}`);
    assert.equal(res.status, 200);
    const { data } = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].rackLabel, "Rack B03");
    assert.equal(data[0].salesOrderNo, "SO-2609-001");
    assert.equal(data[0].poNo, "PO-001");
    assert.equal(data[0].customerPO, "CUST-PO-77");
    assert.equal(data[0].customerName, "Acme Furniture");
  });
}

test("locate needs a session role, and ignores a 1-character query", needsSqlite, async () => {
  const { shim } = makeDb();
  const anon = await mount(shim).request("/api/warehouse/locate?q=sofa");
  assert.equal(anon.status, 401);
  const short = await mount(shim, { userRole: "ADMIN" }).request("/api/warehouse/locate?q=s");
  assert.deepEqual((await short.json()).data, []);
});
