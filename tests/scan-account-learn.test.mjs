// ---------------------------------------------------------------------------
// scan-account-learn.test.mjs — finance plan batch 3 (owner 2026-10-01): the
// account of a scanned bill line is learned from what was saved before, by
// description; a bill already on the books is caught; the SST gets its own
// line. Pure, finance-only (src/lib/scan-account-learn.ts). Names and numbers
// below are made up.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const m = await import(pathToFileURL(resolve(process.cwd(), "src/lib/scan-account-learn.ts")).href);

const H = [
  { payee: "ACME FREIGHT SDN. BHD.", description: "TRANSPORT CHARGES H0001 2CTNS", accountCode: "700-1015", date: "2026-09-22" },
  { payee: "CITY POWER BERHAD", description: "Electric Bill For Aug'26", accountCode: "900-E001", date: "2026-09-30" },
  { payee: "CITY POWER BERHAD", description: "Electric Bill For Jul'26", accountCode: "900-E001", date: "2026-08-30" },
  { payee: "STAFF ONE", description: "ChatGPT Plus subscription", accountCode: "900-S010", date: "2026-10-01" },
  { payee: "STAFF ONE", description: "Parking at HQ", accountCode: "900-T001", date: "2026-09-01" },
];

test("same payee: the most similar earlier line decides", () => {
  const g = m.guessAccount(H, "Staff One", "Parking — Klang office");
  assert.deepEqual([g.accountCode, g.source], ["900-T001", "payee-description"]);
  const g2 = m.guessAccount(H, "STAFF ONE", "ChatGPT Plus Claim from 1st Oct26");
  assert.deepEqual([g2.accountCode, g2.source], ["900-S010", "payee-description"]);
});

test("same payee, nothing similar: that payee's most-used account", () => {
  const g = m.guessAccount(H, "City Power Berhad", "Meter deposit");
  assert.deepEqual([g.accountCode, g.source], ["900-E001", "payee-usual"]);
  assert.match(g.basis, /2 earlier lines/);
});

test("a new payee: someone else's similar line, marked as a suggestion; nothing similar → no guess", () => {
  const g = m.guessAccount(H, "NEW FORWARDER SDN BHD", "Transport charges Shenzhen → Klang");
  assert.deepEqual([g.accountCode, g.source], ["700-1015", "suggested"]);
  assert.match(g.basis, /^ACME FREIGHT SDN\. BHD\.: /);
  assert.equal(m.guessAccount(H, "NEW SHOP", "Office chairs"), null);
  assert.equal(m.guessAccount([], "ACME", "Transport"), null);
});

test("a shared rare word beats a shared common one (prod check 2026-10-01: a place name won over 'transport')", () => {
  const H2 = [
    ...["DO-0001 KLANG", "DO-0002 KLANG", "DO-0003 KLANG", "DO-0004 KLANG", "DO-0005 KLANG & BALAKONG"].map((d, i) => ({ payee: "COURIER A", description: d, accountCode: "900-D001", date: `2026-09-0${i + 1}` })),
    { payee: "HAULIER B", description: "Transport charges - Penang", accountCode: "900-T003", date: "2026-08-01" },
  ];
  const g = m.guessAccount(H2, "NEW HAULIER SDN BHD", "Transport charges Shah Alam to Klang");
  assert.deepEqual([g.accountCode, g.source], ["900-T003", "suggested"]);
  assert.match(g.basis, /^HAULIER B: Transport charges/, "the reason shown is the transport line, not a delivery to Klang");
  // A payee's own lines are judged on that payee's own words.
  const own = m.guessAccount(H2, "COURIER A", "DO-0009 to Klang, urgent");
  assert.deepEqual([own.accountCode, own.source], ["900-D001", "payee-description"]);
});

test("generic words never make two lines look alike", () => {
  // "CHARGES" / "INVOICE" / "SDN BHD" are not what was bought.
  assert.equal(m.guessAccount(H, "SOMEONE ELSE", "Service charges invoice"), null);
});

test("a bill number already on the books is caught (payee must agree when both are known)", () => {
  const known = [
    { docNo: "AF-2609-0102", payee: "ACME FREIGHT SDN. BHD.", ref: "OCB-0000-001" },
    { docNo: "CS-00001", payee: "SAMPLE SUPPLIES SDN BHD", ref: "OCB-0000-002" },
  ];
  assert.equal(m.findDuplicate(known, "af 2609 0102", "Acme Freight Sdn Bhd")?.ref, "OCB-0000-001", "spacing / case do not hide it");
  assert.equal(m.findDuplicate(known, "AF-2609-0102", null)?.ref, "OCB-0000-001", "no payee read → the number alone");
  assert.equal(m.findDuplicate(known, "CS-00001", "ANOTHER COMPANY"), null, "same number, different supplier → not a duplicate");
  assert.equal(m.findDuplicate(known, "12", "ACME"), null, "too short to trust");
});

test("SST gets its own line only when the printed lines leave it out", () => {
  const lines = [{ description: "TRANSPORT CHARGES", amountSen: 10000 }];
  assert.deepEqual(m.linesWithTax(lines, 600, 10600), [...lines, { description: "SST", amountSen: 600, isTax: true }]);
  assert.deepEqual(m.linesWithTax([{ description: "Total incl. SST", amountSen: 10600 }], 600, 10600), [{ description: "Total incl. SST", amountSen: 10600 }]);
  assert.deepEqual(m.linesWithTax(lines, 0, 10000), lines);
  assert.deepEqual(m.linesWithTax(lines, 600, null), [...lines, { description: "SST", amountSen: 600, isTax: true }], "no total read → the tax still shows");
});
