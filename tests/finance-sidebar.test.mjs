// ---------------------------------------------------------------------------
// finance-sidebar.test.mjs — the FINANCE menu slim-down (owner 2026-09-22,
// 「很多功能重复」): one door per job, 40 entries → 32. Retired from the MENU
// only — every old tab key still renders on its direct URL, and the jobs the
// retired pages did are hosted inside the pages that stayed.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const side = read("src/components/layout/sidebar.tsx");
const ui = read("src/pages/accounting/index.tsx");

// Comments stripped — the retirement note names the old URLs on purpose.
const finance = side.slice(side.indexOf('label: "FINANCE"'), side.indexOf('label: "FORECASTING"')).replace(/^\s*\/\/.*$/gm, "");
const names = [...finance.matchAll(/name: "([^"]+)"/g)].map((m) => m[1]);
const hrefs = [...finance.matchAll(/href: "([^"]+)"/g)].map((m) => m[1]);

test("seven groups, one door per job", () => {
  const groups = [...finance.matchAll(/^\s{8}name: "([^"]+)", href: "[^"]+", icon: \w+, children: \[/gm)].map((m) => m[1]);
  assert.deepEqual(groups, ["Reports", "Daily", "Monthly", "Debtors", "Creditors", "Setup"]);
  assert.ok(names.includes("e-Invoice"));
  const leaves = names.filter((n) => !groups.includes(n));
  assert.equal(leaves.length, 32, `expected 32 menu entries, saw ${leaves.length}: ${leaves.join(", ")}`);
});

test("the duplicates are gone from the menu", () => {
  for (const gone of ["Customer Payment", "Supplier Payment", "Other Creditor Payments", "Other Debtor Receipts", "Other Creditor Bills", "Other Creditor", "Other Debtor", "Monthly P&L", "Cost Structure", "Maintenance", "Monthly Report", "Daily Operation", "Monthly Operation"]) {
    assert.ok(!names.includes(gone), `"${gone}" should no longer be a menu entry`);
  }
  for (const gone of ["tab=ocreditorpay", "tab=odebtorpay", "tab=ocreditor\"", "tab=odebtor\"", "tab=ocreditorbills", "tab=plmonthly", "tab=coststruct", "/invoices/payments\"", "/invoices/supplier-payments"]) {
    assert.ok(!finance.includes(gone), `${gone} should no longer be linked from the menu`);
  }
});

test("what stayed is filed where it belongs", () => {
  const group = (name) => {
    const at = finance.indexOf(`name: "${name}"`);
    const before = finance.slice(0, at);
    const last = [...before.matchAll(/^\s{8}name: "([^"]+)", href/gm)].pop();
    return last?.[1];
  };
  assert.equal(group("Stock Summary"), "Reports");
  assert.equal(group("Stock Take"), "Monthly");
  assert.equal(group("Labour"), "Monthly");
  assert.equal(group("Credit Notes"), "Debtors");
  assert.equal(group("Debit Notes"), "Debtors");
  assert.equal(group("AP Invoices"), "Creditors");
  assert.equal(group("Receipts"), "Daily");
  assert.equal(group("Payment Vouchers"), "Daily");
  assert.equal(group("Opening Balance"), "Setup");
});

test("every menu tab key still has a screen, and the retired keys still answer their URL", () => {
  const tabKeys = hrefs.filter((h) => h.startsWith("/accounting?tab=")).map((h) => h.split("tab=")[1]);
  for (const k of new Set(tabKeys)) {
    assert.ok(ui.includes(`{ key: "${k}",`), `tab key "${k}" missing from TABS`);
    assert.ok(ui.includes(`tab === "${k}"`), `tab key "${k}" has no render branch`);
  }
  for (const k of ["ocreditorpay", "odebtorpay", "ocreditor", "odebtor", "ocreditorbills", "plmonthly", "coststruct"]) {
    assert.ok(ui.includes(`tab === "${k}"`), `retired key "${k}" must still render on its direct URL`);
  }
});

test("the retired jobs live inside the pages that stayed", () => {
  // P&L: one entry, three views; the old deep links land on their view.
  assert.match(ui, /\{tab === "pl" && <PlHubTab key="pl" initialView="statement" \/>\}/);
  assert.match(ui, /\{tab === "plmonthly" && <PlHubTab key="plmonthly" initialView="monthly" \/>\}/);
  assert.match(ui, /\{tab === "coststruct" && <PlHubTab key="coststruct" initialView="cost" \/>\}/);
  // Bills pages host the names list and the settle page.
  const bills = ui.slice(ui.indexOf("function OtherPartyBillsTab("), ui.indexOf("function OtherPartyPaymentsTab("));
  assert.match(bills, /<OtherPartiesTab side=\{side\} \/>/);
  assert.match(bills, /<OtherPartyPaymentsManager parties=\{parties\} accounts=\{accounts\} side=\{side\} \/>/);
  // AP Invoices raises / edits other-creditor bills itself.
  const ap = ui.slice(ui.indexOf("function ApInvoicesTab("), ui.indexOf("function FoldSection("));
  assert.match(ap, /<OtherPartyBillsManager parties=\{parties\} accounts=\{accounts\} side="CREDITOR" \/>/);
  assert.match(ap, /<OtherPartiesTab side="CREDITOR" \/>/);
  assert.doesNotMatch(ap, /tab=ocreditorbills/, "AP Invoices no longer sends the user to the retired page");
  // Payment Vouchers points at the one thing only the Supplier Payment page does.
  assert.match(ui, /<Link to="\/invoices\/supplier-payments" className="underline decoration-dotted text-\[#6B5C32\]">Supplier Payment page<\/Link>/);
});
