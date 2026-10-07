// ---------------------------------------------------------------------------
// fibre-department.test.mjs — FIBRE department wiring (owner 2026-10-07).
//
// FIBRE is a production department placed immediately BEFORE UPHOLSTERY.
// Structural test (readFileSync source assertions, the repo idiom, same as
// foam-cutting-department.test.mjs) that pins FIBRE into every hardcoded
// department enumeration. If one drops out, BOM steps are silently dropped
// (collectProcesses drops depts not in DEPT_ORDER) or routing / stickers /
// labels break.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

function assertAll(src, name, needles) {
  for (const n of needles) {
    assert.ok(src.includes(n), `${name}: expected to contain ${JSON.stringify(n)}`);
  }
}

test("lead-times: DEPT_ORDER has FIBRE between WEBBING and UPHOLSTERY, 0 lead days in both maps", () => {
  const src = read("src/api/lib/lead-times.ts");
  assert.match(src, /"WEBBING",\s*"FIBRE",\s*"UPHOLSTERY",/);
  assert.equal((src.match(/FIBRE:\s*0,/g) || []).length, 2);
});

test("repair-scope: REPAIR_DEPT_CODES matches lead-times DEPT_ORDER and labels FIBRE", () => {
  const src = read("src/lib/repair-scope.ts");
  assert.match(src, /"WEBBING",\s*"FIBRE",\s*"UPHOLSTERY",/);
  assert.match(src, /FIBRE: "Fibre",/);
});

test("departments route: runtime self-apply inserts FIBRE before UPHOLSTERY, awaited on GET", () => {
  const src = read("src/api/routes/departments.ts");
  assertAll(src, "departments.ts", [
    "async function ensureFibreDept",
    "'FIBRE', 'Fibre', 'Fibre'",
    "WHERE NOT EXISTS (SELECT 1 FROM departments WHERE code = 'FIBRE')",
    "WHERE code = 'UPHOLSTERY'",
    "await ensureFibreDept(c)",
  ]);
  // The sequence shift must be gated on the insert having added the row, and
  // must not move FIBRE itself.
  assert.match(src, /res\.meta\?\.changes \?\? 0\) === 1/);
  assert.match(src, /sequence >= \? AND code <> 'FIBRE'/);
});

test("seed.sql: FIBRE takes UPHOLSTERY's old slot 8; UPHOLSTERY moves to 9", () => {
  const src = read("scripts/seed.sql");
  assert.ok(src.includes("('dept-15', 'FIBRE', 'Fibre', 'Fibre', 8,"));
  assert.ok(src.includes("('dept-7', 'UPHOLSTERY', 'Upholstery', 'Upholstery', 9,"));
  assert.ok(src.includes("('dept-8', 'PACKING', 'Packing', 'Packing', 10,"));
});

test("job-card-id: FIBRE has its own free 2-digit barcode code", () => {
  const src = read("src/lib/job-card-id.ts");
  const block = src.match(/export const DEPT_CODE2[^{]*\{([^}]+)\}/)[1];
  const codes = [...block.matchAll(/:\s*"(\d{2})"/g)].map((m) => m[1]);
  assert.equal(new Set(codes).size, codes.length, `duplicate dept barcode code: ${codes.join()}`);
  assert.match(block, /FIBRE: "15",/);
});

test("bom-wip chains: FIBRE immediately before UPHOLSTERY in every chain except the DIVAN fallback", () => {
  const src = read("src/api/lib/bom-wip-breakdown.ts");
  const chainLines = src.split("\n").filter((l) => /^\s+(DIVAN|HEADBOARD|SOFA_[A-Z]+):\s+\[.*"UPHOLSTERY"/.test(l));
  assert.equal(chainLines.length, 12);
  const withoutFibre = chainLines.filter((l) => !l.includes('"FIBRE", "UPHOLSTERY"'));
  assert.equal(withoutFibre.length, 1, `only the DIVAN fallback chain skips FIBRE: ${withoutFibre.join(" | ")}`);
  assert.match(withoutFibre[0], /^\s+DIVAN:/);
});

test("sidebar + routes: /production/fibre and /planning/dept/fibre wired", () => {
  assertAll(read("src/components/layout/sidebar.tsx"), "sidebar.tsx", [
    '{ name: "Fibre", href: "/production/fibre"',
    'href === "/production/fibre"',
  ]);
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
  assert.ok(read("src/pages/production/utils.ts").includes('{ name: "Fibre", code: "FIBRE" }'));
  assert.ok(read("src/pages/production/types.ts").includes("sched_FIBRE: DeptSched;"));
  assert.equal((read("src/pages/production/baserows-core.ts").match(/sched_FIBRE:/g) || []).length, 2);
  assert.ok(read("src/pages/production/index.tsx").includes("FIBRE: 108"));
});

test("label maps: every dept picker that lists UPHOLSTERY also lists FIBRE", () => {
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
  assert.ok(bom.includes('"WEBBING", "FIBRE", "UPHOLSTERY", "PACKING"]'), "BOM DEPT_ORDER");
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
