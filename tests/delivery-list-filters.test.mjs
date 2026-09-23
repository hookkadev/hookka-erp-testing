// GET /api/delivery-orders?status= + the Delivered (MTD) month boundary.
// 2026-09-22: the delivery page's stage tabs fetch only their own statuses,
// and the MTD card is counted server-side in Malaysian time.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseStatusList, startOfMonthMYT, pageSlice } from "../src/lib/delivery-list-filters.ts";

test("pageSlice: 50-row pages of an in-memory list; a search term bypasses the slice", () => {
  const rows = Array.from({ length: 335 }, (_, i) => i + 1);
  assert.deepEqual(pageSlice(rows, 1, 50, false).slice(0, 2), [1, 2]);
  assert.equal(pageSlice(rows, 1, 50, false).length, 50);
  assert.deepEqual(pageSlice(rows, 7, 50, false), rows.slice(300)); // last page: 35 rows
  assert.deepEqual(pageSlice(rows, 8, 50, false), []); // past the end → empty, never throws
  assert.equal(pageSlice(rows, 0, 50, false)[0], 1); // garbage page → page 1
  assert.equal(pageSlice(rows, 3, 50, true).length, 335); // searching → whole list
});

test("source guard: the page's loading flag gates on the CURRENT tab's rows only", () => {
  const page = readFileSync(new URL("../src/pages/delivery/index.tsx", import.meta.url), "utf8");
  // BUG-2026-09-22-004: one slow /api/customers must not blank a Planning grid
  // that already holds its rows.
  assert.doesNotMatch(page, /doLoading \|\| poLoading \|\| soLoading/);
  assert.match(page, /const loading = PO_TABS\.has\(activeTab\)\s*\? poLoading/);
  assert.match(page, /pageSlice\(planningPOs, page, LIST_PAGE_SIZE, searching\)/);
  assert.match(page, /pageSlice\(readyPOs, page, LIST_PAGE_SIZE, searching\)/);
});

test("parseStatusList: comma list, trimmed, blanks dropped", () => {
  assert.deepEqual(parseStatusList("DRAFT"), ["DRAFT"]);
  assert.deepEqual(parseStatusList(" LOADED , IN_TRANSIT ,"), ["LOADED", "IN_TRANSIT"]);
  assert.deepEqual(parseStatusList(""), []);
  assert.deepEqual(parseStatusList(undefined), []);
});

test("startOfMonthMYT: Malaysian midnight on the 1st, as a UTC ISO instant", () => {
  // 2026-09-22 10:00 MYT → 2026-09-01T00:00+08:00 = 2026-08-31T16:00Z
  assert.equal(startOfMonthMYT(new Date("2026-09-22T02:00:00Z")), "2026-08-31T16:00:00.000Z");
  // 1st of the month, 03:00 MYT — still UTC 31st of the previous month; must NOT
  // slide back a whole month the way a UTC-based getMonth() would.
  assert.equal(startOfMonthMYT(new Date("2026-08-31T19:00:00Z")), "2026-08-31T16:00:00.000Z");
  // A TEXT ISO deliveredAt compares correctly against it.
  const boundary = startOfMonthMYT(new Date("2026-09-22T02:00:00Z"));
  assert.ok("2026-09-01T01:00:00.000Z" >= boundary);
  assert.ok("2026-08-31T15:59:59.000Z" < boundary);
});

test("source guard: the paginated DO list narrows by ?status= in SQL and the page sends it per tab", () => {
  const route = readFileSync(new URL("../src/api/routes/delivery-orders.ts", import.meta.url), "utf8");
  assert.match(route, /parseStatusList\(c\.req\.query\("status"\)\)/);
  assert.match(route, /AND status IN \(\$\{statusList\.map/);
  assert.match(route, /deliveredMtd/, "/stats must carry the Delivered (MTD) count");
  const page = readFileSync(new URL("../src/pages/delivery/index.tsx", import.meta.url), "utf8");
  assert.match(page, /&status=\$\{statuses\.join\(","\)\}/, "stage tabs must fetch only their own statuses");
  assert.doesNotMatch(page, /useEffect\(\(\) => \{\s*setPage\(1\);/, "tab change must not fire a second navigation");
});
