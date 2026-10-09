// ---------------------------------------------------------------------------
// finance-row-menu-esc.test.mjs — owner 2026-10-02:
//   · 「这个显示太多了，能不能 right click 才选我的东西」: the finance document
//     lists carry no action links — right-click a row (or its ⋮) for the
//     data grid's own menu; double-click still opens the popup;
//   · 「点开后无法用 esc 关闭，create new pv 时也是这样」: Esc closes the popup on
//     top — one shared stack the confirm dialog joins, so an Esc answering a
//     confirm never also closes the form under it; a form with something
//     keyed asks before it is dropped;
//   · 「FUND TRANSFER无法edit?」: the old Fund Transfer page never had an edit;
//     the popup no longer says it does.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const ui = read("src/pages/accounting/index.tsx");
const sp = read("src/pages/invoices/supplier-payments.tsx");
const slice = (src, from, to) => { const a = src.indexOf(from); assert.notEqual(a, -1, from); const b = src.indexOf(to, a + 1); assert.notEqual(b, -1, to); return src.slice(a, b); };

// A window stand-in: the stack only needs add/removeEventListener + dispatch.
globalThis.window = new EventTarget();
const { pushEscape } = await import("../src/lib/escape-stack.ts");
const key = (k, { prevented = false, composing = false } = {}) => {
  const e = new Event("keydown", { cancelable: true });
  Object.defineProperty(e, "key", { value: k });
  Object.defineProperty(e, "isComposing", { value: composing });
  if (prevented) e.preventDefault();
  window.dispatchEvent(e);
  return e;
};

test("Esc runs only the popup on top, then the one under it", () => {
  const ran = [];
  const popForm = pushEscape(() => ran.push("form"));
  const popConfirm = pushEscape(() => ran.push("confirm"));
  const e = key("Escape");
  assert.deepEqual(ran, ["confirm"], "the confirm answers; the form stays");
  assert.equal(e.defaultPrevented, true, "the key is used up");
  popConfirm();
  key("Escape");
  assert.deepEqual(ran, ["confirm", "form"]);
  popForm();
  key("Escape");
  assert.deepEqual(ran, ["confirm", "form"], "nothing open — nothing runs (the listener is gone)");
});

test("a key an inner control used, an IME composition or another key is left alone", () => {
  const ran = [];
  const pop = pushEscape(() => ran.push("x"));
  key("Escape", { prevented: true });
  key("Escape", { composing: true });
  key("Enter");
  assert.deepEqual(ran, []);
  pop();
});

test("the confirm dialog and the data grid's menu join the stack instead of their own Esc", () => {
  const cd = read("src/components/ui/confirm-dialog.tsx");
  assert.match(cd, /return pushEscape\(\(\) => settle\(false\)\);/);
  assert.doesNotMatch(cd, /addEventListener\("keydown"/, "no second Esc listener of its own");
  const dg = read("src/components/ui/data-grid.tsx");
  assert.match(dg, /export function ContextMenu\(\{/, "the grid's menu is shared");
  assert.match(dg, /if \(e\.key === "Escape"\) \{ e\.preventDefault\(\); onClose\(\); return; \}/);
  // The account picker's own Esc (closing its list) never closes the popup too.
  assert.match(ui, /\} else if \(e\.key === "Escape" && open\) \{\n\s+\/\/ Used up here: the popup around the picker stays open\.\n\s+e\.preventDefault\(\);/);
  // The shared dropdown focuses its search box a tick after opening (later in
  // a background tab) — so an open list sits on the stack itself: the first
  // Esc closes the list wherever the focus is (found in a browser 2026-10-02).
  const ss = read("src/components/ui/searchable-select.tsx");
  assert.match(ss, /const \[open, setOpen\] = React\.useState\(false\);\n\s+useEscapeClose\(\(\) => setOpen\(false\), open\);/);
});

test("every finance popup closes on Esc", () => {
  const modal = slice(ui, "function DocDetailModal(", "function DetailField(");
  assert.match(modal, /useEscapeClose\(onClose\);/);
  assert.match(ui, /useEscapeClose\(\(\) => setDetailJv\(null\), !!detailJv\);/);
  assert.match(ui, /useEscapeClose\(\(\) => \{ if \(!busy\) setOpen\(false\); \}, open\);/, "the scan drop zone");
  assert.match(ui, /useEscapeClose\(\(\) => void escClose\(\), open\);/, "the Scan dialog");
  assert.match(ui, /useEscapeClose\(\(\) => \{ if \(!creatingParty\) setNewPartyDraft\(null\); \}, !!newPartyDraft\);/);
  assert.match(ui, /useEscapeClose\(\(\) => setDetail\(null\), !!detail\);/, "other-party payment popup");
  assert.match(ui, /useEscapeClose\(closeImgPopup, !!imgPopup\);/, "report image");
  assert.match(sp, /useEscapeClose\(\(\) => setDetail\(null\), !!detail\);/);
  assert.match(read("src/pages/invoices/payments.tsx"), /useEscapeClose\(\(\) => setDetail\(null\), !!detail\);/);
  assert.match(read("src/pages/invoices/e-invoice.tsx"), /useEscapeClose\(\(\) => \{ if \(!cancelling\) setCancelConfirmId\(null\); \}, !!cancelConfirmId\);/);
});

test("a form popup asks before Esc drops what was keyed", () => {
  const tab = slice(ui, "function PaymentsTab(", "// =============== TAB: OFFICIAL RECEIPT");
  assert.match(tab, /useEscapeClose\(\(\) => void requestCloseForm\(\), showForm\);/);
  const req = slice(tab, "const requestCloseForm = async () => {", "useEscapeClose(");
  assert.match(req, /if \(saving\) return;/, "never mid-save");
  assert.match(req, /if \(formKeyed\(\) && !\(await confirm\(\{ title: "Close without saving\?"/);
  assert.match(req, /resetForm\(\);/);
  const keyed = slice(tab, "const formKeyed = (): boolean => {", "const requestCloseForm");
  assert.match(keyed, /if \(editingId\) return JSON\.stringify\(formKind === "AP" \? \[apForm, apAlloc\] : \[form, lines\]\) !== editBaseline\.current;/, "an edit: only a change counts");
  assert.match(keyed, /if \(pendingScanFiles\.length > 0\) return true;/, "scanned receipts are never dropped silently");
  // The edit baseline is the very objects startEdit put in the form.
  const edit = slice(tab, "const startEdit = (r: PvRow) => {", "const selCls =");
  assert.match(edit, /editBaseline\.current = JSON\.stringify\(\[af, alloc\]\);/);
  assert.match(edit, /editBaseline\.current = JSON\.stringify\(\[f, ls\]\);/);
  // The AP bill popup: compared with the form as it opened, plus held files.
  const mgr = slice(ui, "function OtherPartyBillsManager(", "\ntype OpenBill = ");
  assert.match(mgr, /const \[formAtOpen\] = useState\(\(\) => JSON\.stringify\(form\)\);/);
  assert.match(mgr, /if \(\(JSON\.stringify\(form\) !== formAtOpen \|\| pendingBillFiles\.length > 0\)/);
  assert.match(mgr, /useEscapeClose\(\(\) => void requestCloseBillPopup\(\), !!formOnly\);/, "the page's inline form is not a popup");
});

test("row menus: right-click or ⋮, the grid's own menu, in a portal; Shift keeps the browser's", () => {
  const rm = read("src/components/accounting/row-menu.tsx");
  assert.match(rm, /import \{ ContextMenu, type ContextMenuItem \} from "@\/components\/ui\/data-grid";/);
  assert.match(rm, /if \(e\.shiftKey\) return;\n\s+e\.preventDefault\(\);/);
  assert.match(rm, /createPortal\(<ContextMenu x=\{menu\.x\} y=\{menu\.y\} items=\{menu\.items\} onClose=\{close\} \/>, document\.body\)/);
  assert.match(rm, /title="Actions — or right-click the row"/);
  // Void / delete / unvoid follow the same states as LifecycleActions.
  assert.match(rm, /if \(s === "VOID"\) return \[\{ label: "Unvoid", action: on\.unvoid \}, \{ label: "Delete", danger: true, action: on\.delete \}\];/);
  assert.match(rm, /if \(s === "DELETED"\) return \[\{ label: "Unvoid", action: on\.unvoid \}\];/);
});

test("the finance lists carry no action links — each row opens its menu", () => {
  assert.doesNotMatch(ui, /<LifecycleActions/, "no inline void / delete links left on the accounting page");
  assert.doesNotMatch(sp, /<LifecycleActions/);
  const lists = [
    ["function PaymentsTab(", "// =============== TAB: OFFICIAL RECEIPT", ["payRowMenu(g)", "pvRowMenu(r)"]],
    ["function ReceiptsHubTab(", "// =============== TAB: FUND TRANSFER", ["receiptRowMenu(r)"]],
    ["function FundTransferTab(", "// =============== TAB: STOCK SUMMARY", ["ftRowMenu(r)"]],
    ["function OtherPartyBillsManager(", "function OtherPartyPaymentForm(", ["billRowMenu(b)"]],
    ["function OtherPartyPaymentsManager(", "// =============== TAB: GENERAL LEDGER", ["opayRowMenu(g)"]],
  ];
  for (const [from, to, builders] of lists) {
    const src = slice(ui, from, to);
    assert.match(src, /const rowMenu = useRowMenu\(\);/, from);
    assert.match(src, /\{rowMenu\.element\}/, from);
    for (const b of builders) {
      assert.ok(src.includes(`onContextMenu={rowMenu.onContextMenu(`) && src.includes(`, () => ${b})}`), `${from} right-click → ${b}`);
      assert.ok(src.includes(`{rowMenu.button(`) && src.includes(`() => ${b})}`), `${from} ⋮ → ${b}`);
    }
    assert.doesNotMatch(src, /decoration-dotted cursor-pointer mr-3"><Printer className="h-3 w-3" \/>print/, `${from}: no inline print link`);
  }
  assert.match(sp, /onContextMenu=\{rowMenu\.onContextMenu\(p\.paymentNo, \(\) => payRowMenu\(p\)\)\}/);
  assert.match(sp, /\{rowMenu\.button\(p\.paymentNo, \(\) => payRowMenu\(p\)\)\}/);
  assert.match(sp, /\{rowMenu\.element\}/);
});

test("the voucher menu holds every action the row used to show, with the same gates", () => {
  const menu = slice(ui, "const pvRowMenu = (r: PvRow): RowMenuGroups => {", "const payRowMenu = ");
  for (const rung of ['"prepare"', '"withdraw"', '"reject"', '"check"', '"approve"']) assert.ok(menu.includes(`action: () => void handleLadder(r, ${rung})`), rung);
  assert.match(menu, /disabled: ladderBusy/);
  assert.match(menu, /\.\.\.\(isPosted\(r\) && r\.pvKind !== "AP" \? \[\{ label: "Edit", action: \(\) => startEdit\(r\) \}\] : \[\]\),/, "a posted AP payment is never edited");
  assert.match(menu, /\.\.\.\(isPosted\(r\) && r\.accrued === 1 && !r\.settledAt \? \[\{ label: "Settle"/);
  assert.match(menu, /label: "Print", action: \(\) => void printPvWithDetail\(r\)/);
  assert.match(menu, /\(r\.attachmentCount \?\? 0\) > 0 \? \[\{ label: bundleBusy === r\.id \? "Print \+ files \(preparing…\)" : "Print \+ files"/);
  assert.match(menu, /lifecycleMenuItems\(r\.lifecycleState, \{/);
  // A row from another door voids through its own endpoint and opens its page.
  const foreign = slice(ui, "const payRowMenu = (g: PayRow): RowMenuGroups => [", "\n  return (\n");
  assert.match(foreign, /action: \(\) => navigate\(foreignHref\(g\)\)/);
  assert.match(foreign, /void: \(\) => void handleForeignLifecycle\(g, "void"\),/);
  // A bill paid against cannot be voided — said in the menu, not just greyed.
  assert.match(ui, /\}, active && b\.paidAmountSen > 0 \? "paid against" : undefined\),/);
});

test("Fund Transfer: the popup no longer claims its page edits it; the description is editable", () => {
  assert.doesNotMatch(ui, /no approval ladder\)\. Edit, knock-off and FX live on that page\.<\/div>/, "the old one-size line is gone");
  assert.match(ui, /\{g\.ft\n\s+\? "Its description can be edited here; to change the accounts, amount or date, void it and post it again\."\n\s+: g\.sp \? "Edit, knock-off and FX live on that page\." : "Edit lives on that page\."\}/);
  const ft = slice(ui, "function FundTransferTab(", "// =============== TAB: STOCK SUMMARY");
  assert.match(ft, /Its description can be edited; to change the accounts, amount or date, void it and post it again\./);
});

test("Fund Transfer description edit (owner 「我要可以edit, 因为我发现description 少了」): text only, never the money", () => {
  const api = read("src/api/routes/accounting.ts");
  // The only write route on a transfer besides create / lifecycle is this one.
  assert.deepEqual((api.match(/app\.(put|patch|post|delete)\("\/fund-transfers[^"]*"/g) ?? []).sort(),
    ['app.post("/fund-transfers"', 'app.post("/fund-transfers/:no/lifecycle"', 'app.put("/fund-transfers/:no/description"'].sort());
  const r = slice(api, 'app.put("/fund-transfers/:no/description", async (c) => {', "\n});\n");
  assert.match(r, /requirePermission\(c, "accounting", "update"\)/);
  assert.match(r, /if \(\(await getDocState\(c\.var\.DB, orgId, "fund_transfer", no\)\) !== "ACTIVE"\) \{/, "a voided / deleted transfer is not edited");
  assert.match(r, /const description = `Transfer \$\{no\}\$\{reference \? ` · \$\{reference\}` : ""\}`;/, "the same text shape as a new transfer");
  assert.match(r, /"UPDATE ledger_journal_entries SET description = \? WHERE sourceType = 'fund_transfer' AND sourceId = \? AND orgId = \? AND hidden = 0",/);
  assert.equal((r.match(/UPDATE ledger_journal_entries SET/g) ?? []).length, 1);
  assert.doesNotMatch(r, /accountCode =|debitSen =|creditSen =|postedAt =|INSERT INTO|fund_transfers/, "accounts, amounts, date and legs untouched");
  // UI: one editor, from the Fund Transfer page and from Payment Vouchers.
  const ed = slice(ui, "function FtDescriptionEditor(", "function FundTransferTab(");
  assert.match(ed, /fetch\(`\/api\/accounting\/fund-transfers\/\$\{encodeURIComponent\(ft\.no\)\}\/description`, \{\n\s+method: "PUT",/);
  assert.match(ed, /useEscapeClose\(\(\) => void requestClose\(\)\);/);
  assert.match(ed, /if \(changed && !\(await confirm\(\{ title: "Close without saving\?"/);
  const ftTab = slice(ui, "function FundTransferTab(", "// =============== TAB: STOCK SUMMARY");
  assert.match(ftTab, /\.\.\.\(\(r\.lifecycleState \?\? "ACTIVE"\) === "ACTIVE" \? \[\{ label: "Edit description", action: \(\) => setEditFt\(r\.no\) \}\] : \[\]\),/);
  assert.match(ftTab, /<FtDescriptionEditor ft=\{r\} onClose=\{\(\) => setEditFt\(null\)\} onSaved=\{load\} \/>/);
  const tab = slice(ui, "function PaymentsTab(", "// =============== TAB: OFFICIAL RECEIPT");
  assert.match(tab, /\.\.\.\(g\.ft && g\.state === "ACTIVE" \? \[\{ label: "Edit description", action: \(\) => setEditFtNo\(g\.no\) \}\] : \[\]\),/);
  assert.match(tab, /\{g\.ft && g\.state === "ACTIVE" && <Button variant="outline" size="sm" onClick=\{\(\) => \{ close\(\); setEditFtNo\(g\.no\); \}\}>Edit description<\/Button>\}/);
  assert.match(tab, /<FtDescriptionEditor ft=\{t\} onClose=\{\(\) => setEditFtNo\(null\)\} onSaved=\{load\} \/>/);
});
