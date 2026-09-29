// ---------------------------------------------------------------------------
// report-settings.test.mjs — BUG-36 per-report PIC lists
// (src/api/lib/report-settings.ts + the wiring in src/api/routes/reports.ts).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeReportSettings,
  invalidEmailsIn,
  cleanEmails,
  isDue,
} from "../src/api/lib/report-settings.ts";

const sched = { enabled: true, recipients: [], frequency: "daily", time: "08:00", weekday: 1, monthDay: 1 };

test("normalize: keeps known kinds, cleans + dedupes emails, drops the rest", () => {
  const s = normalizeReportSettings({
    overdue: { enabled: true, recipients: [" A@x.com", "a@x.com", "bad", "b@y.co"] },
    schedule: { enabled: false, recipients: [] },
    bogus: { enabled: true, recipients: ["c@z.com"] },
    efficiency: "not an object",
  });
  assert.deepEqual(s, {
    overdue: { ...sched, recipients: ["a@x.com", "b@y.co"] },
    schedule: { ...sched, enabled: false },
  });
});

test("normalize: reads the kv string form and survives garbage", () => {
  assert.deepEqual(
    normalizeReportSettings('{"brief":{"recipients":["x@y.com"]}}'),
    { brief: { ...sched, recipients: ["x@y.com"], time: "07:00" } },
  );
  assert.deepEqual(normalizeReportSettings("not json"), {});
  assert.deepEqual(normalizeReportSettings(null), {});
  assert.deepEqual(normalizeReportSettings([1, 2]), {});
});

test("normalize: keeps a valid schedule, defaults a bad one", () => {
  const s = normalizeReportSettings({
    overdue: { frequency: "weekly", time: "17:45", weekday: 6, monthDay: 28 },
    efficiency: { frequency: "hourly", time: "25:00", weekday: 0, monthDay: 31 },
  });
  assert.deepEqual(s.overdue, { ...sched, frequency: "weekly", time: "17:45", weekday: 6, monthDay: 28 });
  assert.deepEqual(s.efficiency, { ...sched, time: "18:30" });
});

test("isDue: day, time passed, not already sent today", () => {
  // 2026-09-28 is a Monday. 00:30 UTC = 08:30 SGT.
  const mon0830 = new Date("2026-09-28T00:30:00Z");
  const mon0745 = new Date("2026-09-27T23:45:00Z");
  assert.equal(isDue("overdue", sched, mon0830, undefined), true);
  assert.equal(isDue("overdue", sched, mon0745, undefined), false, "before the time");
  assert.equal(isDue("overdue", sched, mon0830, "2026-09-28"), false, "already sent today");
  assert.equal(isDue("overdue", sched, mon0830, "2026-09-26"), true);
  // Late cron run still sends the same day.
  assert.equal(isDue("overdue", sched, new Date("2026-09-28T09:00:00Z"), undefined), true);
  // Weekly: Monday only.
  const weekly = { ...sched, frequency: "weekly", weekday: 1 };
  assert.equal(isDue("overdue", weekly, mon0830, undefined), true);
  assert.equal(isDue("overdue", { ...weekly, weekday: 2 }, mon0830, undefined), false);
  // Monthly: the 28th only.
  const monthly = { ...sched, frequency: "monthly", monthDay: 28 };
  assert.equal(isDue("overdue", monthly, mon0830, undefined), true);
  assert.equal(isDue("overdue", { ...monthly, monthDay: 1 }, mon0830, undefined), false);
  // Unconfigured keeps its old daily time (efficiency 18:30 SGT = 10:30 UTC).
  assert.equal(isDue("efficiency", undefined, mon0830, undefined), false);
  assert.equal(isDue("efficiency", undefined, new Date("2026-09-28T10:30:00Z"), undefined), true);
});

test("invalidEmailsIn flags bad entries so the PUT rejects them", () => {
  assert.deepEqual(
    invalidEmailsIn({ overdue: { recipients: ["ok@x.com", "nope", ""] } }),
    ["nope"],
  );
  assert.deepEqual(cleanEmails("x@y.com"), []);
});

test("reports.ts: a configured report uses its own list, never the SUPER_ADMIN fallback", () => {
  const src = readFileSync("src/api/routes/reports.ts", "utf8");
  const fn = src.slice(src.indexOf("async function resolveRecipients("), src.indexOf("async function legacyRecipients("));
  assert.match(fn, /if \(configured\) return configured\.recipients;/);
  assert.match(src, /await resolveRecipients\(c, kind\)/);
  // cronGate and the due-trigger skip a report switched off in the settings.
  assert.equal(src.match(/\[kind\]\?\.enabled === false/g)?.length, 2);
  // The due-trigger marks a report sent before sending, so it never double-sends.
  const due = src.slice(src.indexOf('internal.post("/due-trigger"'));
  assert.ok(due.indexOf("saveLastSent(") < due.indexOf("sendScheduled(c, kind)"));
});
