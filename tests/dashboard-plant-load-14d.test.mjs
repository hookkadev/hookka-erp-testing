// ---------------------------------------------------------------------------
// dashboard-plant-load-14d.test.mjs — Plant Load card, owner 2026-10-08.
//
//   1. Daily Capacity averages the last 14 working days (was 7) for All-time
//      and the current month, on the dashboard AND the Planning page. A past
//      month keeps its own month average.
//   2. BUG-2026-10-08-269: the dashboard's department list left out Foam
//      Cutting (and Fibre), so their backlog fell out of the headline total.
//   3. A finished month is frozen: stored on first view, served as-is after.
//
// 1 and 2 are source assertions (the route is a 2,000-line handler with ~30
// queries); 3 runs the real helpers against a fake DB.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFrozenMonth, freezeMonth } from "../src/api/lib/dashboard-state-snapshot.ts";

const read = (rel) => readFileSync(rel, "utf8").replace(/\r\n/g, "\n");
const OVERVIEW = read("src/api/routes/dashboard-overview.ts");
const PLANNING = read("src/pages/planning/index.tsx");

test("capacity window is 14 working days on the dashboard and Planning", () => {
  assert.match(OVERVIEW, /const ROLLING_DAYS = windowOverride \?\? 14;/);
  // Only a past month averages its own days; the current month is rolling.
  assert.match(OVERVIEW, /if \(monthScope && isPastMonth && !windowOverride\) \{\n\s+windowDays = \[\];/);
  assert.match(PLANNING, /const ROLLING_WINDOW_DAYS = 14;/);
});

test("dashboard backlog lists every Planning department", () => {
  const block = OVERVIEW.match(/const DEPARTMENTS: \{ code: string; name: string \}\[\] = \[([\s\S]*?)\];/)[1];
  const dash = [...block.matchAll(/code: "([A-Z_]+)"/g)].map((m) => m[1]);
  const planBlock = PLANNING.match(/const DEPARTMENTS = \[([\s\S]*?)\];/)[1];
  const plan = [...planBlock.matchAll(/code: "([A-Z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(dash, plan);
  // The Operations board joins the two feeds through its own copy.
  const ops = read("src/pages/dashboards/ops-floor-lib.ts");
  const floor = [...ops.matchAll(/\["([A-Z_]+)", "/g)].map((m) => m[1]);
  assert.deepEqual(floor, dash);
});

function fakeDb() {
  const rows = new Map();
  let tableExists = false;
  return {
    rows,
    prepare(sql) {
      const stmt = {
        args: [],
        bind(...a) { stmt.args = a; return stmt; },
        async run() {
          if (/CREATE TABLE IF NOT EXISTS dashboard_month_frozen/.test(sql)) { tableExists = true; return {}; }
          if (/INSERT INTO dashboard_month_frozen/.test(sql)) {
            const [org, period, data] = stmt.args;
            const k = `${org}|${period}`;
            if (!rows.has(k)) rows.set(k, data); // ON CONFLICT DO NOTHING
            return {};
          }
          throw new Error(`unexpected run: ${sql}`);
        },
        async first() {
          if (!tableExists) throw new Error('relation "dashboard_month_frozen" does not exist');
          const v = rows.get(`${stmt.args[0]}|${stmt.args[1]}`);
          return v === undefined ? null : { data: v };
        },
      };
      return stmt;
    },
  };
}

test("a past month is frozen on first write and never overwritten", async () => {
  const db = fakeDb();
  assert.equal(await readFrozenMonth(db, "org1", "2026-09"), null); // no table yet
  await freezeMonth(db, "org1", "2026-09", { production: { dailyCapacityMin: 100 } });
  await freezeMonth(db, "org1", "2026-09", { production: { dailyCapacityMin: 999 } });
  const got = await readFrozenMonth(db, "org1", "2026-09");
  assert.equal(got.production.dailyCapacityMin, 100);
  assert.equal(await readFrozenMonth(db, "org1", "2026-08"), null);
  assert.equal(await readFrozenMonth(db, "org2", "2026-09"), null);
});

test("route reads the frozen copy only for past months and freezes after compute", () => {
  assert.match(OVERVIEW, /if \(isPastMonth && !windowOverride\) \{\n\s+const frozen = await readFrozenMonth\(/);
  assert.match(OVERVIEW, /\} else \{\n\s+try \{\n\s+await freezeMonth\(c\.var\.DB, orgId, period,/);
});

// Staging Dashboard Compare: capacityWindow=7 must never read or write a
// stored copy, or the old 7-day numbers would leak into the real dashboard.
test("the 7-day compare view reads and writes no stored copy", () => {
  assert.match(OVERVIEW, /const windowOverride = cwRaw === "7" \? 7 : cwRaw === "14" \? 14 : null;/);
  // snapshot read + snapshot write-back
  assert.equal((OVERVIEW.match(/if \(period === "all" && !windowOverride\) \{/g) ?? []).length, 2);
  // its own 60s cache key, never the normal view's (a compare 14 differs from
  // the normal view on a past month)
  assert.match(OVERVIEW, /\$\{windowOverride \? `:cmp\$\{windowOverride\}` : ""\}`/);
  // no daily state capture, no freeze
  assert.match(OVERVIEW, /if \(windowOverride\) \{\n\s+\/\/ Compare view: nothing stored\.\n\s+\} else if \(!isPastMonth\) \{\n\s+captureTodayState/);
});

// Compare view with a finished month: both windows end on the month's last
// day, and the saved month-end backlog is divided again by each window.
test("compare view on a past month uses windows ending at month end", () => {
  assert.match(OVERVIEW, /windowOverride && isPastMonth && monthScope\n\s+\? new Date\(`\$\{monthScope\.lastDay\}T00:00:00`\)/);
  assert.match(OVERVIEW, /if \(monthScope && isPastMonth && !windowOverride\) \{/);
  assert.match(OVERVIEW, /if \(windowOverride\) \{\n\s+const capByDept = new Map\(backlogByDept\.map/);
});

// Owner 2026-10-09: on a picked month the compare windows never reach into
// the month before, and every divisor is the number of days actually counted.
test("compare windows stay inside the picked month", () => {
  assert.match(OVERVIEW, /const clipStart = windowOverride && monthScope \? monthScope\.start : null;/);
  assert.match(OVERVIEW, /if \(clipStart && iso < clipStart\) break;/);
  assert.match(OVERVIEW, /Math\.round\(windowTotal \/ \(rollingDays\.length \|\| 1\)\)/);
  assert.doesNotMatch(OVERVIEW, /\/ ROLLING_DAYS\)/);
});
