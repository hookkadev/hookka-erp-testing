// ---------------------------------------------------------------------------
// overdue-email-mobile.test.mjs: the emailed Overdue Report must read on a
// phone (BUG-2026-09-29-221, BUG-36 follow-up).
//
// It was a 10-column A4 table with no viewport tag and no small-screen rules,
// so phones shrank it to unreadable text, IN_PRODUCTION was cut off in its
// column, and a "Print / Save as PDF" button that does nothing sat on top of
// every email.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { renderOverdueHtml } from "../src/api/lib/schedule-overdue-report.ts";

const data = {
  date: "2026-09-29",
  generatedAtIso: "2026-09-29T00:00:00.000Z",
  totals: { salesOrders: 1, units: 2, totalSen: 485000, worstDays: 21 },
  rows: [{
    salesOrderId: "so1", companySOId: "SO-2609-310", customerName: "Harvey Norman",
    customerState: "Selangor", customerDeliveryDate: "2026-09-08", hookkaExpectedDD: null,
    status: "IN_PRODUCTION", itemCount: 1, totalQty: 2, totalSen: 485000, daysOverdue: 21,
    productSummary: "HB-5530",
  }],
};

test("overdue report has a phone layout that print does not use", () => {
  const html = renderOverdueHtml(data, { email: true });
  assert.match(html, /<meta name="viewport" content="width=device-width/);
  assert.match(html, /@media screen and \(max-width: 900px\)/);
  assert.doesNotMatch(html, /@media print[^{]*\{[^}]*m-inline/);
  assert.match(html, /class="m-lbl">Overdue <\/span>21d/);
});

test("status reads as words, so the column wraps instead of clipping", () => {
  const html = renderOverdueHtml(data);
  assert.match(html, />IN PRODUCTION</);
  assert.doesNotMatch(html, />IN_PRODUCTION</);
});

test("the email has no print button; the in-app page keeps it", () => {
  assert.doesNotMatch(renderOverdueHtml(data, { email: true }), /window\.print\(\)/);
  assert.match(renderOverdueHtml(data), /window\.print\(\)/);
});
