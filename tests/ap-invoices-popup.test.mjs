// ---------------------------------------------------------------------------
// ap-invoices-popup.test.mjs — owner 2026-09-29 「ap invoice 就 pop out 出来给我
// 填相关之类不可以吗？」+「other creditor maintenance 放 sidebar 旁边」→「3. 做」.
//
// AP Invoices used to open a second copy of the other-creditor bills list (with
// its own editor) below the mirror, and the user had to scroll down to it.
// Now: New AP bill opens the bill form in a popup; double-clicking an AP bill
// opens its detail popup (Print / Edit / Copy / Void); Edit and Copy reuse the
// same popup form; the duplicate list below is gone; the creditor names list
// is a sidebar entry again (Creditors › Other Creditors).
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const ui = readFileSync("src/pages/accounting/index.tsx", "utf8").replace(/\r\n/g, "\n");
const block = (from, to) => { const a = ui.indexOf(from); assert.notEqual(a, -1, from); const b = ui.indexOf(to, a + 1); return ui.slice(a, b === -1 ? undefined : b); };
const ap = block("function ApInvoicesTab(", "function DocDetailModal(");
const mgr = block("function OtherPartyBillsManager(", "function OtherPartyPaymentForm(");

// The one prefill builder, run for real (only its signature carries types).
const fnSrc = block("function billFormFrom(", "\n}\n") + "\n}\n";
const billFormFrom = new Function(
  fnSrc.replace(/^function billFormFrom\([^)]*\) \{/, "function billFormFrom(b, mode, today) {") + "\nreturn billFormFrom;",
)();

const bill = {
  billNo: "OCB-2609-004", partyId: "p1", billDate: "2026-09-10", referenceNo: "INV-77", description: "Fabric",
  taxSen: 1234, isOpening: true,
  items: [{ counterAccount: "130-0000", amountSen: 44200, description: "roll", lineNo: 1 }],
};

test("Edit keeps the bill as it is; Copy starts a fresh one (today, no reference, never an opening)", () => {
  const e = billFormFrom(bill, "edit", "2026-09-29");
  assert.equal(e.billDate, "2026-09-10");
  assert.equal(e.referenceNo, "INV-77");
  assert.equal(e.isOpening, true);
  assert.equal(e.taxStr, "12.34");
  assert.deepEqual(e.lines, [{ counterAccount: "130-0000", amountStr: "442", description: "roll" }]);
  const c = billFormFrom(bill, "copy", "2026-09-29");
  assert.equal(c.billDate, "2026-09-29");
  assert.equal(c.referenceNo, "");
  assert.equal(c.isOpening, false);
  assert.equal(c.partyId, "p1");
  assert.deepEqual(c.lines, e.lines);
  const empty = billFormFrom({ ...bill, items: [], taxSen: 0, description: null }, "copy", "2026-09-29");
  assert.deepEqual(empty.lines, [{ counterAccount: "", amountStr: "", description: "" }], "a bill with no lines still gets one blank line");
  assert.equal(empty.taxStr, "");
  assert.equal(empty.description, "");
});

test("the manager's Edit / Copy buttons and the popup share that builder", () => {
  assert.match(mgr, /setForm\(billFormFrom\(b, "copy", today\)\);/);
  assert.match(mgr, /setForm\(billFormFrom\(b, "edit", today\)\);/);
  assert.match(mgr, /formOnly\?\.bill && formOnly\.mode !== "new"\s*\n\s*\? billFormFrom\(formOnly\.bill, formOnly\.mode, today\)/);
});

test("in the popup the manager is just the form: open at once, no list, closes on save or Cancel", () => {
  assert.match(ui, /type BillPopupSpec = \{ mode: "new" \| "edit" \| "copy"; bill\?: OtherPartyBill; onDone: \(\) => void \};/);
  assert.match(mgr, /const \[showForm, setShowForm\] = useState\(!!formOnly\);/);
  assert.match(mgr, /useState<string \| null>\(formOnly\?\.mode === "edit" && formOnly\.bill \? formOnly\.bill\.billNo : null\)/, "Edit re-posts the same bill number");
  // Save → close; Cancel → close.
  assert.match(mgr, /load\(\);\n\s*formOnly\?\.onDone\(\);\n\s*\} else toast\.error/);
  assert.match(mgr, /onClick=\{\(\) => \{ setShowForm\(false\); setEditingBillNo\(null\); formOnly\?\.onDone\(\); \}\}>Cancel<\/Button>/);
  // No "New Bill" toggle inside the popup; no scan while editing an existing bill.
  assert.match(mgr, /\{\(!formOnly \|\| formOnly\.mode !== "edit"\) && <ScanPrefillButton label="Scan Bill" onResult=\{applyScan\} \/>\}/);
  assert.match(mgr, /\{!formOnly && <Button variant="primary" size="sm" onClick=\{\(\) => \{/);
  // Search box, batch bar and the list render only outside the popup.
  const listStart = mgr.indexOf("{!formOnly && (<>");
  assert.notEqual(listStart, -1, "list wrapper missing");
  assert.ok(mgr.indexOf("Search bill no / party / reference / description") > listStart);
  assert.ok(mgr.indexOf("No bills match") > listStart);
});

test("AP Invoices: New AP bill → popup form; the duplicate list below is gone", () => {
  assert.doesNotMatch(ap, /setManage|Hide bill editor|Done — refresh the list/, "the editor-below toggle is back");
  assert.doesNotMatch(ap, /<OtherPartiesTab /, "the names list belongs to the sidebar now");
  assert.match(ap, /<Button variant="outline" size="sm" onClick=\{\(\) => setBillPopup\(\{ mode: "new" \}\)\}>New AP bill<\/Button>/);
  // One popup form, remounted per bill so a stale draft never carries over.
  assert.match(ap, /<OtherPartyBillsManager\n\s+key=\{`\$\{billPopup\.mode\}:\$\{billPopup\.bill\?\.billNo \?\? "new"\}`\}\n\s+parties=\{parties\}\n\s+accounts=\{accounts\}\n\s+side="CREDITOR"\n\s+formOnly=\{\{ mode: billPopup\.mode, bill: billPopup\.bill, onDone: \(\) => \{ setBillPopup\(null\); setVer\(\(v\) => v \+ 1\); \} \}\}/);
  assert.equal((ap.match(/<OtherPartyBillsManager/g) ?? []).length, 1);
  // A half-filled bill never vanishes on a stray click: the overlay has no click-to-close.
  assert.match(ap, /<div className="fixed inset-0 bg-black\/40 z-40 flex items-start justify-center overflow-y-auto p-4">/);
  assert.match(ap, /<button onClick=\{\(\) => setBillPopup\(null\)\} className="[^"]+" aria-label="Close">✕<\/button>/);
});

test("AP Invoices: double-click an AP bill → detail popup with Print / Edit / Copy / Void", () => {
  assert.match(ap, /else setDetailBillNo\(r\.no\); \}\}/);
  assert.match(ap, /<button type="button" onClick=\{\(\) => setDetailBillNo\(r\.no\)\}/);
  assert.match(ap, /fetch\("\/api\/accounting\/other-party-bills\?type=CREDITOR"\)/);
  assert.match(ap, /const b = bills\.find\(\(x\) => x\.billNo === detailBillNo\);/, "resolved from the reloaded list so it refreshes after actions");
  assert.match(ap, /title=\{`Other creditor bill \$\{b\.billNo\}`\}/);
  assert.match(ap, /printVoucher\(buildOtherPartyBillVoucher\(b, accounts\)\)/);
  assert.match(ap, /\{!voided && <Button variant="outline" size="sm" onClick=\{\(\) => \{ close\(\); setBillPopup\(\{ mode: "edit", bill: b \}\); \}\}>Edit<\/Button>\}/);
  assert.match(ap, /onClick=\{\(\) => \{ close\(\); setBillPopup\(\{ mode: "copy", bill: b \}\); \}\}>Copy<\/Button>/);
  assert.match(ap, /void billLifecycle\(b, "void"\)/);
  assert.match(ap, /void billLifecycle\(b, "unvoid"\)/);
  // Void goes through the same lifecycle endpoint as the Bills page, behind a confirm.
  assert.match(ap, /`\/api\/accounting\/other-party-bills\/\$\{encodeURIComponent\(b\.billNo\)\}\/lifecycle`/);
  assert.match(ap, /if \(!\(await confirm\(\{ title: `\$\{verb\} bill\?`/);
});
