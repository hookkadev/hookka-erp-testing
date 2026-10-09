// Staging-only API log drawer: ring buffer, redaction, error-body capture that
// leaves the caller's body alone, the bug-report text, and pins that the
// recorder rides the one existing fetch patch on the staging host only.
// Staging-only: never PR this into main.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  recordApiCall, getEntries, clearEntries, isSensitivePath, pickReportEntry, buildBugReport,
  API_LOG_MAX, ERROR_BODY_MAX,
} from "../src/lib/staging-api-log.ts";

const call = (path, status, extra = {}) => ({ method: "GET", path, status, ms: 12.4, ...extra });
const flush = () => new Promise((r) => setTimeout(r, 10));

test("keeps only the last 50 calls", () => {
  clearEntries();
  for (let i = 0; i < 60; i++) recordApiCall(call(`/api/x/${i}`, 200));
  const list = getEntries();
  assert.equal(list.length, API_LOG_MAX);
  assert.equal(list[0].path, "/api/x/10");
  assert.equal(list.at(-1).path, "/api/x/59");
  assert.equal(list.at(-1).ms, 12);
});

test("sensitive paths are matched by whole word, not substring", () => {
  for (const p of [
    "/api/auth/login", "/api/auth/me", "/api/worker-auth/reset-pin", "/api/workers/w1/set-pin",
    "/api/workers/bulk-generate-pins", "/api/users/u1/reset-password", "/api/users/invites/abc",
    "/api/accounting/bank-reco/import-session", "/api/delivery-orders/d1/qr-token",
  ]) assert.ok(isSensitivePath(p), p);
  for (const p of ["/api/shipping", "/api/sales-orders/1", "/api/spinning", "/api/authors-x"]) {
    assert.ok(!isSensitivePath(p), p);
  }
});

test("a failure's body is recorded, truncated, and the caller can still read it", async () => {
  clearEntries();
  const long = JSON.stringify({ error: "x".repeat(2000) });
  const res = new Response(long, { status: 500 });
  recordApiCall(call("/api/sales-orders", 500), res);
  assert.equal(await res.text(), long); // caller's body untouched
  await flush();
  const e = getEntries().at(-1);
  assert.equal(e.error.length, ERROR_BODY_MAX + 3);
  assert.ok(e.error.startsWith('{"error":"xxx'));
});

test("success bodies and sensitive failure bodies are never read", async () => {
  clearEntries();
  const ok = new Response("secret-ok", { status: 200 });
  const bad = new Response('{"error":"wrong PIN"}', { status: 401 });
  recordApiCall(call("/api/products", 200), ok);
  recordApiCall(call("/api/worker-auth/login", 401), bad);
  await flush();
  assert.equal(ok.bodyUsed, false);
  assert.deepEqual(getEntries().map((e) => e.error), [undefined, undefined]);
  assert.equal(await bad.text(), '{"error":"wrong PIN"}');
});

test("network failures record the error name only", () => {
  clearEntries();
  recordApiCall(call("/api/x", 0, { error: new DOMException("aborted", "AbortError") }));
  recordApiCall(call("/api/auth/login", 0, { error: new TypeError("Failed to fetch") }));
  assert.deepEqual(getEntries().map((e) => e.error), ["AbortError", undefined]);
});

test("bug report uses the selected call, else the last failure", async () => {
  clearEntries();
  recordApiCall(call("/api/a", 404), new Response("not here", { status: 404 }));
  recordApiCall({ method: "POST", path: "/api/b", status: 422, ms: 80 }, new Response('{"error":"bad qty"}', { status: 422 }));
  recordApiCall(call("/api/c", 200));
  await flush();
  const list = getEntries();
  assert.equal(pickReportEntry(list, null).path, "/api/b");
  assert.equal(pickReportEntry(list, list[2].id).path, "/api/c");
  const text = buildBugReport({ url: "https://staging.x/sales", time: "T", userAgent: "UA", entry: pickReportEntry(list, null) });
  assert.equal(text, [
    "Bug report (staging)", "Page: https://staging.x/sales", "Time: T", "Browser: UA",
    "Request: POST /api/b", `Status: 422, 80 ms, at ${list[1].at}`, 'Error: {"error":"bad qty"}',
  ].join("\n"));
  assert.match(buildBugReport({ url: "u", time: "t", userAgent: "a" }), /no failed request/);
});

test("recorder rides the one fetch patch, staging host only; drawer is staging only", () => {
  const api = readFileSync(new URL("../src/lib/api-client.ts", import.meta.url), "utf8");
  assert.equal(api.match(/window\.fetch = /g).length, 1);
  const calls = api.match(/if \(window\.location\.hostname\.startsWith\("staging\."\)\) recordApiCall\(/g);
  assert.equal(calls.length, 2);
  // CSRF injection still happens before the request goes out.
  assert.ok(api.indexOf("headers.set(CSRF_HEADER_NAME, csrf)") < api.indexOf("await originalFetch("));
  const ui = readFileSync(new URL("../src/components/staging-api-log.tsx", import.meta.url), "utf8");
  assert.match(ui, /if \(!window\.location\.hostname\.startsWith\("staging\."\)\) return null;/);
  assert.doesNotMatch(ui + readFileSync(new URL("../src/lib/staging-api-log.ts", import.meta.url), "utf8"), /localStorage|sessionStorage|fetch\(/);
});

test("on staging the API button sits in the topbar in place of the tab strip", () => {
  const topbar = readFileSync(new URL("../src/components/layout/topbar.tsx", import.meta.url), "utf8");
  const layout = readFileSync(new URL("../src/layouts/DashboardLayout.tsx", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../src/components/staging-api-log.tsx", import.meta.url), "utf8");
  // Staging host shows the button, every other host keeps the workspace tabs.
  assert.match(topbar, /hostname\.startsWith\("staging\."\) \? \([\s\S]*?<StagingApiLog \/>[\s\S]*?\) : \([\s\S]*?<WorkspaceTabs \/>/);
  assert.doesNotMatch(layout, /StagingApiLog/); // no second, floating copy
  assert.doesNotMatch(ui, /\bfixed\b/); // the button and drawer hang off the topbar now
});

test("the topbar block stays on screen when the page scrolls", () => {
  const layout = readFileSync(new URL("../src/layouts/DashboardLayout.tsx", import.meta.url), "utf8");
  // The sticky has to be on the wrapper: a sticky child cannot leave a parent
  // that is only as tall as itself, so the API button scrolled away.
  assert.match(layout, /<div (?:ref=\{\w+\} )?className="sticky top-0 z-30 print:hidden">\s*<Topbar \/>\s*<Breadcrumbs \/>/);
  // A page's own sticky header docks under this block, not over it.
  assert.match(layout, /setProperty\("--app-sticky-h"/);
  const dash = readFileSync(new URL("../src/pages/dashboards/dashboard-prototype.tsx", import.meta.url), "utf8");
  assert.match(dash, /sticky top-\[var\(--app-sticky-h,0px\)\]/);
});
