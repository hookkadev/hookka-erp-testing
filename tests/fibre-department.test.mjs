// ---------------------------------------------------------------------------
// fibre-department.test.mjs — FIBRE department wiring (owner 2026-10-07).
//
// FIBRE is a production department placed immediately AFTER FOAM (Foam
// Bonding). Structural test (readFileSync source assertions, the repo idiom,
// same as foam-cutting-department.test.mjs) that pins FIBRE into every
// hardcoded department enumeration. If one drops out, BOM steps are silently
// dropped (collectProcesses drops depts not in DEPT_ORDER) or routing /
// stickers / labels break. The behaviour block at the end runs the runtime
// self-apply against a real SQLite table.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ensureFibreDept } from "../src/api/routes/departments.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

function assertAll(src, name, needles) {
  for (const n of needles) {
    assert.ok(src.includes(n), `${name}: expected to contain ${JSON.stringify(n)}`);
  }
}

test("lead-times: DEPT_ORDER has FIBRE right after FOAM, 0 lead days in both maps", () => {
  const src = read("src/api/lib/lead-times.ts");
  assert.match(src, /"FOAM",\s*"FIBRE",\s*"FRAMING",/);
  assert.equal((src.match(/FIBRE:\s*0,/g) || []).length, 2);
});

test("repair-scope: REPAIR_DEPT_CODES matches lead-times DEPT_ORDER and labels FIBRE", () => {
  const src = read("src/lib/repair-scope.ts");
  assert.match(src, /"FOAM",\s*"FIBRE",\s*"FRAMING",/);
  assert.match(src, /FIBRE: "Fibre",/);
});

test("departments route: runtime self-apply is awaited on GET", () => {
  const src = read("src/api/routes/departments.ts");
  assertAll(src, "departments.ts", [
    "export async function ensureFibreDept",
    "'FIBRE', 'Fibre', 'Fibre'",
    "WHERE NOT EXISTS (SELECT 1 FROM departments WHERE code = 'FIBRE')",
    "await ensureFibreDept(c.var.DB)",
  ]);
  // The sequence shift must be gated on the insert having added the row.
  assert.match(src, /res\.meta\?\.changes \?\? 0\) === 1/);
});

test("seed.sql: FIBRE takes slot 6 right after FOAM (5); FRAMING moves to 7", () => {
  const src = read("scripts/seed.sql");
  assert.ok(src.includes("('dept-4', 'FOAM', 'Foam Bonding', 'Foam Bonding', 5,"));
  assert.ok(src.includes("('dept-15', 'FIBRE', 'Fibre', 'Fibre', 6,"));
  assert.ok(src.includes("('dept-5', 'FRAMING', 'Framing', 'Framing', 7,"));
  assert.ok(src.includes("('dept-7', 'UPHOLSTERY', 'Upholstery', 'Upholstery', 9,"));
});

test("job-card-id: FIBRE has its own free 2-digit barcode code", () => {
  const src = read("src/lib/job-card-id.ts");
  const block = src.match(/export const DEPT_CODE2[^{]*\{([^}]+)\}/)[1];
  const codes = [...block.matchAll(/:\s*"(\d{2})"/g)].map((m) => m[1]);
  assert.equal(new Set(codes).size, codes.length, `duplicate dept barcode code: ${codes.join()}`);
  assert.match(block, /FIBRE: "15",/);
});

test("bom-wip chains: FIBRE immediately after FOAM in every chain that has FOAM, absent otherwise", () => {
  const src = read("src/api/lib/bom-wip-breakdown.ts");
  const chainLines = src.split("\n").filter((l) => /^\s+(DIVAN|HEADBOARD|SOFA_[A-Z]+):\s+\[.*"UPHOLSTERY"/.test(l));
  assert.equal(chainLines.length, 12);
  for (const l of chainLines) {
    if (l.includes('"FOAM",')) assert.ok(l.includes('"FOAM", "FIBRE",'), `FIBRE must follow FOAM: ${l.trim()}`);
    else assert.ok(!l.includes("FIBRE"), `no FOAM, so no FIBRE: ${l.trim()}`);
  }
});

test("sidebar + routes: /production/fibre and /planning/dept/fibre wired, Fibre between Foam Bonding and Wood Cut", () => {
  const sidebar = read("src/components/layout/sidebar.tsx");
  assert.ok(sidebar.includes('href === "/production/fibre"'));
  assert.match(sidebar, /name: "Foam Bonding".*\r?\n\s*\{ name: "Fibre", href: "\/production\/fibre".*\r?\n\s*\{ name: "Wood Cut"/);
  assertAll(read("src/dashboard-routes.tsx"), "dashboard-routes.tsx", [
    "path: '/production/fibre'",
    "PlanningFibre",
    "path: '/planning/dept/fibre'",
    "'/production/fibre':",
    "'/planning/dept/fibre':",
  ]);
  const page = read("src/pages/planning/dept/fibre.tsx");
  assert.ok(page.includes('fetchUrl="/api/planning/schedule/fibre"'));
  assert.ok(read("src/data/fibre-schedule-snapshot.json").includes('"Fibre Calendar"'));
});

test("production pages: dept route, columns and widths carry FIBRE", () => {
  assert.ok(read("src/pages/production/dept.tsx").includes('"FIBRE"'));
  assert.match(read("src/pages/production/utils.ts"), /code: "FOAM" \},\r?\n\s*\{ name: "Fibre", code: "FIBRE" \}/);
  assert.ok(read("src/pages/production/types.ts").includes("sched_FIBRE: DeptSched;"));
  assert.equal((read("src/pages/production/baserows-core.ts").match(/sched_FIBRE:/g) || []).length, 2);
  assert.ok(read("src/pages/production/index.tsx").includes("FIBRE: 108"));
});

test("label maps: every dept picker lists FIBRE", () => {
  const files = [
    "src/pages/bom.tsx",
    "src/pages/employees.tsx",
    "src/pages/planning/index.tsx",
    "src/pages/service-cases/detail.tsx",
    "src/pages/m/config/forms.ts",
    "src/pages/m/config/modules.ts",
    "src/pages/m/screens/Home.tsx",
    "src/pages/m/screens/ProductionScreen.tsx",
    "src/pages/m/screens/ProductionDetailScreen.tsx",
  ];
  for (const f of files) assert.ok(read(f).includes("FIBRE"), `${f} missing FIBRE`);
  const bom = read("src/pages/bom.tsx");
  assert.ok(bom.includes('"FOAM", "FIBRE", "FRAMING", "WEBBING", "UPHOLSTERY", "PACKING"]'), "BOM DEPT_ORDER");
  assert.match(bom, /FIBRE: "Fibre",/);
  const planning = read("src/pages/planning/index.tsx");
  assertAll(planning, "planning/index.tsx", [
    'code: "FIBRE", name: "Fibre"',
    'FIBRE: "/planning/dept/fibre"',
    'code: "FIBRE",      color:',
    '{ code: "FIBRE",      label: "Fibre" }',
    'FIBRE: "Fibre",',
  ]);
});

// ---------------------------------------------------------------------------
// Behaviour: run ensureFibreDept against a real (SQLite, in-memory) departments
// table. Covers a fresh DB, a DB left with FIBRE in the first version's spot
// (immediately before UPHOLSTERY, staging 2026-10-07), and repeat runs.
// node:sqlite needs Node 22.13+; CI runs Node 20, so these skip there and run
// locally.
// ---------------------------------------------------------------------------
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {}
const sqliteSkip = DatabaseSync ? false : "node:sqlite is not available on this Node version";
const LINE = ["FAB_CUT", "FAB_SEW", "WOOD_CUT", "FOAM_CUTTING", "FOAM", "FRAMING", "WEBBING", "UPHOLSTERY", "PACKING", "WAREHOUSING"];
const EXPECTED = ["FAB_CUT", "FAB_SEW", "WOOD_CUT", "FOAM_CUTTING", "FOAM", "FIBRE", "FRAMING", "WEBBING", "UPHOLSTERY", "PACKING", "WAREHOUSING"];

function makeDb(codes) {
  const sql = new DatabaseSync(":memory:");
  sql.exec(`CREATE TABLE departments (id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL,
    shortName TEXT NOT NULL, sequence INTEGER NOT NULL, color TEXT NOT NULL,
    workingHoursPerDay INTEGER NOT NULL, isProduction INTEGER)`);
  const ins = sql.prepare("INSERT INTO departments VALUES (?, ?, ?, ?, ?, '#000', 9, 1)");
  codes.forEach((code, i) => ins.run(`d-${code}`, code, code, code, i + 1));
  // Minimal D1-shaped wrapper: prepare().bind().run() with meta.changes.
  const db = {
    prepare(q) {
      let args = [];
      const stmt = {
        bind: (...a) => ((args = a), stmt),
        run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...args).changes) } }),
      };
      return stmt;
    },
  };
  const order = () => sql.prepare("SELECT code FROM departments ORDER BY sequence").all().map((r) => r.code);
  const seqs = () => sql.prepare("SELECT sequence FROM departments ORDER BY sequence").all().map((r) => r.sequence);
  return { db, order, seqs };
}

test("ensureFibreDept: fresh DB gets FIBRE right after FOAM, once", { skip: sqliteSkip }, async () => {
  const t = makeDb(LINE);
  await ensureFibreDept(t.db);
  await ensureFibreDept(t.db);
  assert.deepEqual(t.order(), EXPECTED);
  assert.deepEqual(t.seqs(), EXPECTED.map((_, i) => i + 1), "no gaps or ties");
});

test("ensureFibreDept: FIBRE left before UPHOLSTERY is moved to right after FOAM, once", { skip: sqliteSkip }, async () => {
  const old = [...LINE];
  old.splice(old.indexOf("UPHOLSTERY"), 0, "FIBRE");
  const t = makeDb(old);
  await ensureFibreDept(t.db);
  await ensureFibreDept(t.db);
  assert.deepEqual(t.order(), EXPECTED);
  assert.deepEqual(t.seqs(), EXPECTED.map((_, i) => i + 1), "no gaps or ties");
});

test("ensureFibreDept: an admin-chosen FIBRE position elsewhere is left alone", { skip: sqliteSkip }, async () => {
  const custom = [...LINE];
  custom.splice(custom.indexOf("PACKING") + 1, 0, "FIBRE");
  const t = makeDb(custom);
  await ensureFibreDept(t.db);
  assert.deepEqual(t.order(), custom);
});
