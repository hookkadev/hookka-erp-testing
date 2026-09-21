// dashboard-url-state.test.mjs — URL <-> dashboard state (tab / sub / period):
// round-trip, default omission, silent fallback on junk, unrelated params kept.
import test from "node:test";
import assert from "node:assert/strict";
import { parseDashboardUrl, serializeDashboardUrl, TAB_SUBS } from "../src/pages/dashboards/dashboard-url-state-lib.ts";

const TABS = ["overview", "sales", "siti", "employee", "department", "service", "lim"];
const parse = (q) => parseDashboardUrl(new URLSearchParams(q), TABS);
const ser = (s, base) => serializeDashboardUrl(s, base ? new URLSearchParams(base) : undefined).toString();

test("empty URL = defaults, and defaults serialize to an empty URL", () => {
  const s = parse("");
  assert.deepEqual(s, { tab: "overview", sub: "", period: { mode: "monthly", month: "" } });
  assert.equal(ser(s), "");
});

test("lim / plan / monthly / day round-trips", () => {
  const q = "tab=lim&sub=plan&month=2026-09&day=2026-09-12";
  const s = parse(q);
  assert.equal(s.tab, "lim");
  assert.equal(s.sub, "plan");
  assert.deepEqual(s.period, { mode: "monthly", month: "2026-09", day: "2026-09-12" });
  assert.deepEqual(parse(ser(s)), s);
});

test("first sub-tab is omitted; range and ytd round-trip", () => {
  assert.equal(ser({ tab: "lim", sub: TAB_SUBS.lim[0].key, period: { mode: "monthly", month: "" } }), "tab=lim");
  const r = { tab: "sales", sub: "", period: { mode: "range", month: "2026-09", from: "2026-09-01", to: "2026-09-07", label: "Last 7 Days" } };
  assert.deepEqual(parse(ser(r)), r);
  const y = { tab: "overview", sub: "", period: { mode: "ytd", month: "2026-05" } };
  assert.deepEqual(parse(ser(y)), y);
});

test("invalid tab/sub/month/day/range fall back silently", () => {
  assert.equal(parse("tab=nope").tab, "overview");
  assert.equal(parse("tab=lim&sub=nope").sub, TAB_SUBS.lim[0].key);
  assert.equal(parse("tab=sales&sub=plan").sub, "");
  assert.equal(parse("month=2026-13").period.month, "");
  assert.equal(parse("day=2026-02-30").period.day, undefined);
  assert.equal(parse("mode=range&from=2026-09-09&to=2026-09-01").period.mode, "monthly");
  assert.equal(parse("mode=range&from=x").period.mode, "monthly");
  assert.equal(parse("mode=bogus").period.mode, "monthly");
});

test("unrelated params survive and stale nav params are replaced", () => {
  const out = ser({ tab: "siti", sub: "cost", period: { mode: "monthly", month: "" } }, "foo=bar&tab=lim&day=2026-09-01");
  assert.equal(new URLSearchParams(out).get("foo"), "bar");
  assert.equal(new URLSearchParams(out).get("tab"), "siti");
  assert.equal(new URLSearchParams(out).get("day"), null);
});

test("every registered sub-tab list is non-empty with unique keys", () => {
  for (const [tab, subs] of Object.entries(TAB_SUBS)) {
    assert.ok(subs.length > 0, tab);
    assert.equal(new Set(subs.map((s) => s.key)).size, subs.length, tab);
  }
});
