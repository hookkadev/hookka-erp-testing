// ---------------------------------------------------------------------------
// schedule-email-size.test.mjs: the Today's Production Orders email must stay
// under 100,000 bytes (BUG-2026-10-01, BUG-36 follow-up).
//
// 256 job cards on 2026-10-01 rendered ~199 KB. MailSlurp (staging) refused
// it ("Free sandbox message body exceeds the 100000 byte limit") and Gmail
// clips past ~102 KB. The email now caps rows per department and links to the
// full list; the in-app page is not capped.
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

test("a heavy day stays under the 100,000-byte limit and links to the full list", () => {
  for (const cards of [256, 1000]) {
    const html = renderScheduleHtml(day(cards), { email: true, fullListUrl: url });
    assert.ok(bytes(html) < 100_000, `${cards} cards: ${bytes(html)} bytes`);
    assert.match(html, new RegExp(`This email lists \\d+ of ${cards} job cards`));
    assert.match(html, /more job cards in Dept 0 not shown in this email/);
    assert.ok(html.includes(`<a href="${url}">open the full list</a>`));
    // Every department still shows its totals.
    for (let d = 0; d < 7; d++) assert.match(html, new RegExp(`<span>Dept ${d}</span>`));
  }
});

test("a light day is not capped, and the in-app page never is", () => {
  const light = renderScheduleHtml(day(20), { email: true, fullListUrl: url });
  assert.doesNotMatch(light, /class="more"/);
  assert.equal(light.match(/<tr>/g).length - 7, 20); // minus one header row per dept
  const page = renderScheduleHtml(day(1000));
  assert.doesNotMatch(page, /class="more"/);
  assert.equal(page.match(/<tr>/g).length - 7, 1000);
});

test("no link without an origin: the email says where to look instead", () => {
  const html = renderScheduleHtml(day(1000), { email: true });
  assert.match(html, /open Reports in the ERP for the full list/);
  assert.doesNotMatch(html, /<a href=/);
});
