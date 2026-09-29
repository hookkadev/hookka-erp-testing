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
} from "../src/api/lib/report-settings.ts";

test("normalize: keeps known kinds, cleans + dedupes emails, drops the rest", () => {
  const s = normalizeReportSettings({
    overdue: { enabled: true, recipients: [" A@x.com", "a@x.com", "bad", "b@y.co"] },
    schedule: { enabled: false, recipients: [] },
    bogus: { enabled: true, recipients: ["c@z.com"] },
    efficiency: "not an object",
  });
  assert.deepEqual(s, {
    overdue: { enabled: true, recipients: ["a@x.com", "b@y.co"] },
    schedule: { enabled: false, recipients: [] },
  });
});

test("normalize: reads the kv string form and survives garbage", () => {
  assert.deepEqual(
    normalizeReportSettings('{"brief":{"recipients":["x@y.com"]}}'),
    { brief: { enabled: true, recipients: ["x@y.com"] } },
  );
  assert.deepEqual(normalizeReportSettings("not json"), {});
  assert.deepEqual(normalizeReportSettings(null), {});
  assert.deepEqual(normalizeReportSettings([1, 2]), {});
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
  // cronGate skips a report switched off in the settings.
  assert.match(src, /\[kind\]\?\.enabled === false/);
});
