// ---------------------------------------------------------------------------
// report-emails-mobile.test.mjs: the Schedule, Efficiency and Morning Brief
// emails must read on a phone (BUG-2026-09-29-232, BUG-36 follow-up; the
// Overdue email is covered by overdue-email-mobile.test.mjs).
//
// Each was a desktop / A4 page with no viewport tag, so phones shrank it to
// unreadable text. The Brief also carried a Chinese notice, against the
// English-only UI rule.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { renderScheduleHtml } from "../src/api/lib/schedule-overdue-report.ts";
import { renderEfficiencyHtml } from "../src/api/lib/efficiency-report.ts";
import { renderBriefHtml } from "../src/api/lib/production-brief.ts";

const schedule = {
  date: "2026-09-29", generatedAtIso: "2026-09-29T00:00:00.000Z",
  totals: { jobCards: 1, departments: 1, quantity: 2, prodMinutes: 70 },
  byDepartment: [{ code: "FOAM", name: "Foam", count: 1, quantity: 2, prodMinutes: 70, rows: [{
    jobCardId: "jc1", departmentCode: "FOAM", departmentName: "Foam", status: "IN_PROGRESS", dueDate: "2026-09-29",
    productionOrderId: "po1", poNo: "PO-2609-140", customerName: "Fella Design", productCode: "HB-5530",
    productName: "Oslo Bedframe", sizeLabel: null, wipLabel: null, quantity: 2, prodMinutes: 70, pic1Name: "Ahmad", pic2Name: "",
  }] }],
};
const efficiency = {
  date: "2026-09-29", generatedAtIso: "2026-09-29T10:30:00.000Z",
  totals: { presentCount: 1, workerCount: 1, workingMinutes: 480, productionMinutes: 360, efficiencyPct: 75, jobsCompleted: 3 },
  departments: [{ code: "FOAM", name: "Foam", shortName: "Foam", workerCount: 1, workingMinutes: 480, productionMinutes: 360, efficiencyPct: 75, flagged: false }],
  workers: [{ workerId: "w1", empNo: "HK100", name: "Ahmad Faiz", departmentCode: "FOAM", departmentName: "Foam",
    clockIn: "08:00", clockOut: "17:30", status: "PRESENT", workingMinutes: 480, productionMinutes: 360,
    efficiencyPct: 75, jobsCompleted: 3, punchOutOfArea: false }],
};
const viewport = /<meta name="viewport" content="width=device-width/;

test("schedule email: viewport, screen-only card layout, no print button", () => {
  const html = renderScheduleHtml(schedule, { email: true });
  assert.match(html, viewport);
  assert.match(html, /@media screen and \(max-width: 900px\)/);
  assert.match(html, /class="m-lbl">Qty <\/span>2/);
  assert.match(html, />IN PROGRESS</);
  assert.doesNotMatch(html, /window\.print\(\)/);
  assert.match(renderScheduleHtml(schedule), /window\.print\(\)/);
});

test("efficiency email: viewport, employee cards, no print button", () => {
  const html = renderEfficiencyHtml(efficiency, { email: true });
  assert.match(html, viewport);
  assert.match(html, /@media screen and \(max-width: 640px\)/);
  assert.match(html, /<table class="data emp">/);
  assert.match(html, /class="m-lbl">Efficiency <\/span>75%/);
  assert.doesNotMatch(html, /window\.print\(\)/);
  assert.match(renderEfficiencyHtml(efficiency), /window\.print\(\)/);
});

test("morning brief: viewport, and every word English", () => {
  const html = renderBriefHtml({
    date: "2026-09-29", prevDate: "2026-09-28", generatedAtIso: "2026-09-29T00:00:00.000Z",
    schedule, efficiency,
    overdue: { date: "2026-09-29", generatedAtIso: "", totals: { salesOrders: 0, units: 0, totalSen: 0, worstDays: 0 }, rows: [] },
    lowWorkers: [], proposals: { pending: 3 }, learning: null, lateRisk: null, aiFocus: null,
  });
  assert.match(html, viewport);
  assert.match(html, /Schedule proposals: <b>3<\/b>/);
  assert.doesNotMatch(html, /[一-鿿]/);
});
