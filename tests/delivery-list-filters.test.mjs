// GET /api/delivery-orders?status= + the Delivered (MTD) month boundary.
// 2026-09-22: the delivery page's stage tabs fetch only their own statuses,
// and the MTD card is counted server-side in Malaysian time.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseStatusList, startOfMonthMYT } from "../src/lib/delivery-list-filters.ts";

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
