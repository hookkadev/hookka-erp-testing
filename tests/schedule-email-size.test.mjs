// ---------------------------------------------------------------------------
// schedule-email-size.test.mjs: the Today's Production Orders email is the
// summary only (top boxes, department table, one "Show full list" link), so it
// stays small on any day; job rows live on the in-app page, which has a
// department filter (BUG-2026-10-01-240, BUG-36 follow-up).
//
// 256 job cards on 2026-10-01 rendered ~199 KB. MailSlurp (staging) refused
// it ("Free sandbox message body exceeds the 100000 byte limit") and Gmail
// clips past ~102 KB.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { renderScheduleHtml } from "../src/api/lib/schedule-overdue-report.ts";

function day(cards, depts = 7) {
  const byDepartment = Array.from({ length: depts }, (_, d) => {
    const n = Math.floor(cards / depts) + (d < cards % depts ? 1 : 0);
    const rows = Array.from({ length: n }, (_, i) => ({
      jobCardId: `jc${d}-${i}`, departmentCode: `D${d}`, departmentName: `Dept ${d}`, status: "WAITING",
      dueDate: "2026-10-01", productionOrderId: `po${i}`, poNo: `PO-2610-${String(i).padStart(4, "0")}`,
      customerName: "Fella Design Sdn Bhd", productCode: "HB-5530-QUEEN-GREY",
      productName: "Oslo Bedframe Queen with Storage — Grey Fabric", sizeLabel: "Queen",
      wipLabel: "Frame + Webbing + Foam lamination", quantity: 1, prodMinutes: 36,
      pic1Name: "Ahmad Faiz bin Ismail", pic2Name: "Muhammad Hafiz",
    }));
    return { code: `D${d}`, name: `Dept ${d}`, count: n, quantity: n, prodMinutes: n * 36, rows };
  });
  return {
    date: "2026-10-01", generatedAtIso: "2026-10-01T00:00:00.000Z",
    totals: { jobCards: cards, departments: depts, quantity: cards, prodMinutes: cards * 36 },
    byDepartment,
  };
}
const bytes = (s) => new TextEncoder().encode(s).length;
const url = "https://staging.example/api/reports/schedule?date=2026-10-01";

test("the email is the summary: no job rows, one Show full list link, small on any day", () => {
  for (const cards of [20, 256, 1000]) {
    const html = renderScheduleHtml(day(cards), { email: true, fullListUrl: url });
    assert.ok(bytes(html) < 30_000, `${cards} cards: ${bytes(html)} bytes`);
    assert.doesNotMatch(html, /<tr><td><strong>/, "no job rows in the email");
    assert.doesNotMatch(html, /class="dept-filter/, "the filter is on the page, not in the email");
    assert.equal(html.split(">Show full list</a>").length - 1, 1, "the link appears once");
    assert.ok(html.includes(`<a href="${url}">Show full list</a>`));
    for (let d = 0; d < 7; d++) assert.match(html, new RegExp(`<tr><td>Dept ${d}</td>`), "every department is in the table");
  }
});

test("no link without an origin: the email says where to look instead", () => {
  const html = renderScheduleHtml(day(1000), { email: true });
  assert.match(html, /Full list in Reports/);
  assert.doesNotMatch(html, /<a href=/);
});

test("the in-app page is the full list, with the same summary and a department filter", () => {
  const page = renderScheduleHtml(day(1000));
  assert.equal(page.match(/<tr><td><strong>/g).length, 1000);
  assert.match(page, /<table class="share">/);
  assert.match(page, /<div class="dept-filter no-print"><a class="chip on" href="\?date=2026-10-01">All<\/a>/);
  assert.match(page, /<a class="chip" href="\?date=2026-10-01&amp;dept=D3">Dept 3<\/a>/);
});

test("?dept= shows only that department's section; the summary stays whole; unknown dept shows all", () => {
  const one = renderScheduleHtml(day(70), { dept: "D3" });
  assert.equal(one.match(/<div class="dept-card">/g).length, 1);
  assert.match(one, /<span>Dept 3<\/span>/);
  assert.equal(one.match(/<tr><td><strong>/g).length, 10);
  for (let d = 0; d < 7; d++) assert.match(one, new RegExp(`<tr><td>Dept ${d}</td>`));
  assert.match(one, /<a class="chip on" href="\?date=2026-10-01&amp;dept=D3">Dept 3<\/a>/);
  const bad = renderScheduleHtml(day(70), { dept: "NOPE" });
  assert.equal(bad.match(/<div class="dept-card">/g).length, 7);
});
