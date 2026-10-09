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
  dueSlot,
  seedLastSent,
  MAX_TIMES,
} from "../src/api/lib/report-settings.ts";

const sched = { enabled: true, recipients: [], frequency: "daily", times: ["08:00"], weekday: 1, monthDay: 1 };

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
    { brief: { ...sched, recipients: ["x@y.com"], times: ["07:00"] } },
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
  assert.deepEqual(s.overdue, { ...sched, frequency: "weekly", times: ["17:45"], weekday: 6, monthDay: 28 });
  assert.deepEqual(s.efficiency, { ...sched, times: ["18:30"] });
});

test("dueSlot: day, time passed, not already sent", () => {
  // 2026-09-28 is a Monday. 00:30 UTC = 08:30 SGT.
  const mon0830 = new Date("2026-09-28T00:30:00Z");
  const mon0745 = new Date("2026-09-27T23:45:00Z");
  assert.equal(dueSlot("overdue", sched, mon0830, undefined), "2026-09-28 08:00");
  assert.equal(dueSlot("overdue", sched, mon0745, undefined), null, "before the time");
  assert.equal(dueSlot("overdue", sched, mon0830, "2026-09-28 08:00"), null, "already sent");
  assert.equal(dueSlot("overdue", sched, mon0830, "2026-09-28"), null, "old day-only stamp = whole day sent");
  assert.equal(dueSlot("overdue", sched, mon0830, "2026-09-26 08:00"), "2026-09-28 08:00");
  // Late cron run still sends the same day.
  assert.equal(dueSlot("overdue", sched, new Date("2026-09-28T09:00:00Z"), undefined), "2026-09-28 08:00");
  // Weekly: Monday only.
  const weekly = { ...sched, frequency: "weekly", weekday: 1 };
  assert.equal(dueSlot("overdue", weekly, mon0830, undefined), "2026-09-28 08:00");
  assert.equal(dueSlot("overdue", { ...weekly, weekday: 2 }, mon0830, undefined), null);
  // Monthly: the 28th only.
  const monthly = { ...sched, frequency: "monthly", monthDay: 28 };
  assert.equal(dueSlot("overdue", monthly, mon0830, undefined), "2026-09-28 08:00");
  assert.equal(dueSlot("overdue", { ...monthly, monthDay: 1 }, mon0830, undefined), null);
  // Unconfigured keeps its old daily time (efficiency 18:30 SGT = 10:30 UTC).
  assert.equal(dueSlot("efficiency", undefined, mon0830, undefined), null);
  assert.equal(dueSlot("efficiency", undefined, new Date("2026-09-28T10:30:00Z"), undefined), "2026-09-28 18:30");
});

test("dueSlot: several times a day, each sends once", () => {
  const two = { ...sched, times: ["08:00", "17:00"] };
  const at = (utc) => new Date(`2026-09-28T${utc}:00Z`);
  // 08:30 SGT: the morning slot.
  assert.equal(dueSlot("overdue", two, at("00:30"), "2026-09-26 17:00"), "2026-09-28 08:00");
  // Afternoon before 17:00: morning already went, nothing due.
  assert.equal(dueSlot("overdue", two, at("08:45"), "2026-09-28 08:00"), null);
  // 17:15 SGT: the evening slot.
  assert.equal(dueSlot("overdue", two, at("09:15"), "2026-09-28 08:00"), "2026-09-28 17:00");
  assert.equal(dueSlot("overdue", two, at("09:30"), "2026-09-28 17:00"), null);
  // Both missed (cron down all day): one send, not two.
  assert.equal(dueSlot("overdue", two, at("09:15"), "2026-09-26 17:00"), "2026-09-28 17:00");
});

test("normalize: times are validated, sorted, de-duplicated, capped; old `time` still read", () => {
  const s = normalizeReportSettings({
    overdue: { times: ["17:00", "08:00", "bad", "08:00", 9] },
    schedule: { time: "09:15" },
    brief: { times: [] },
    efficiency: { times: Array.from({ length: 12 }, (_, i) => `${String(i + 10)}:00`) },
  });
  assert.deepEqual(s.overdue.times, ["08:00", "17:00"]);
  assert.deepEqual(s.schedule.times, ["09:15"]);
  assert.deepEqual(s.brief.times, ["07:00"]);
  assert.equal(s.efficiency.times.length, MAX_TIMES);
  assert.equal(s.overdue.time, undefined);
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

test("first run: times already passed today are marked handled, later times still send", () => {
  // 15:00 SGT (07:00 UTC) on a Monday. Defaults: brief 07:00, schedule 08:00, overdue 08:00 passed; efficiency 18:30 not yet.
  const now = new Date("2026-09-28T07:00:00Z");
  const last = {};
  const seeded = seedLastSent({}, last, now);
  assert.deepEqual(seeded.sort(), ["brief", "efficiency", "overdue", "schedule"]);
  for (const k of ["brief", "schedule", "overdue"]) assert.equal(dueSlot(k, undefined, now, last[k]), null, k + " must not resend");
  assert.equal(dueSlot("efficiency", undefined, new Date("2026-09-28T10:30:00Z"), last.efficiency), "2026-09-28 18:30", "efficiency still sends at 18:30");
  // 06:00 SGT: nothing has passed yet, the 07:00 brief must still send at 07:00.
  const early = new Date("2026-09-27T22:00:00Z");
  const l2 = {};
  seedLastSent({}, l2, early);
  assert.equal(dueSlot("brief", undefined, new Date("2026-09-27T23:00:00Z"), l2.brief), "2026-09-28 07:00");
  // Already recorded: left alone.
  const l3 = { brief: "2026-09-28 07:00" };
  assert.deepEqual(seedLastSent({}, l3, now).includes("brief"), false);
  assert.equal(l3.brief, "2026-09-28 07:00");
});
