// ---------------------------------------------------------------------------
// stock-take-priced-count.test.mjs — owner 2026-10-09: the month-end count now
// comes as the raw-material master export (Item Code / Item Group / Balance
// Qty) with quantities and no prices 「你看可以从 purchase 那边 capture 吗？」→
// 「用最近一次进货价」:
//   · the file is recognised and every counted item (qty > 0) read;
//   · each item is priced at its latest purchase-invoice line on or before
//     month-end (line total ÷ qty: after discount, before SST); a code bought
//     at prices > 3× apart or last bought as 1–2 against a count of 20+ is
//     marked to check; an item never bought gets hints only, never a price;
//   · the owner reviews, ticks groups (earlier-counted groups ticked), and
//     "Put into the month" fills the group totals; Save keeps the priced lines
//     with the month, and never saves totals without them or with an
//     unpriced counted item.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isRmCountShape, parseRmCountRows, itemCodeKey, priceCheckReasons, unitPriceToSen, lastDayOfYm,
  isCleanImportShape, detectRawShape,
} from "../src/lib/stock-take-import.ts";

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const api = read("src/api/routes/accounting.ts");
const ui = read("src/pages/accounting/index.tsx");
const slice = (src, from, to) => { const a = src.indexOf(from); assert.notEqual(a, -1, from); const b = src.indexOf(to, a + 1); assert.notEqual(b, -1, to); return src.slice(a, b); };

const header = ["ID", "Item Code *", "Description *", "Base UOM *", "Item Group *", "Balance Qty", "Active"];

test("the master export is its own shape — not the clean template, not the raw Total sheet", () => {
  assert.equal(isRmCountShape(header), true);
  assert.equal(isCleanImportShape(header), false);
  assert.equal(detectRawShape(header), null);
  assert.equal(isRmCountShape(["Material Group", "Closing Stock (RM)"]), false);
  assert.equal(isRmCountShape(["Item Code", "Item Group"]), false, "no Balance Qty → not a count");
});

test("every counted item is read; zero, blank and negative are not counts; float noise is cleaned", () => {
  const rows = parseRmCountRows([
    header,
    ["rm-1", " AB-01 ", "FABRIC ONE", "MTR", "S.M-FABR", 4.39999999999999, "TRUE"],
    ["rm-2", "AB-02", "FABRIC TWO", "MTR", "S.M-FABR", 0, "TRUE"],
    ["rm-3", "AB-03", "BLANK", "PCS", "OTHERS", "", "TRUE"],
    ["rm-4", "AB-04", "MINUS", "PCS", "OTHERS", -2, "TRUE"],
    ["rm-5", "", "NO CODE", "PCS", "OTHERS", 5, "TRUE"],
    ["rm-6", "SCREW 1", "SCREW", "PCS", "B.OTHERS", "1,500", "TRUE"],
  ]);
  assert.deepEqual(rows, [
    { id: "rm-1", code: "AB-01", description: "FABRIC ONE", uom: "MTR", group: "S.M-FABR", qty: 4.4 },
    { id: "rm-6", code: "SCREW 1", description: "SCREW", uom: "PCS", group: "B.OTHERS", qty: 1500 },
  ]);
});

test("item codes match the purchase lines' material codes loosely (case, spacing)", () => {
  assert.equal(itemCodeKey("  pc151-01 "), "PC151-01");
  assert.equal(itemCodeKey("NON  WOVEN black"), "NON WOVEN BLACK");
});

test("a price to check: units that differ between purchases, or a pack price", () => {
  assert.deepEqual(priceCheckReasons({ countQty: 1750, lastQty: 3, minUnitSen: 87, maxUnitSen: 24000 }), ["units"]);
  assert.deepEqual(priceCheckReasons({ countQty: 400, lastQty: 1, minUnitSen: 1800, maxUnitSen: 1800 }), ["pack"]);
  assert.deepEqual(priceCheckReasons({ countQty: 300, lastQty: 55.2, minUnitSen: 1500, maxUnitSen: 1700 }), []);
  assert.deepEqual(priceCheckReasons({ countQty: 5, lastQty: 1, minUnitSen: 900, maxUnitSen: 900 }), [], "a few items bought singly is not a pack");
});

test("a typed unit price: up to 4 decimals, thousands commas only, otherwise unreadable", () => {
  assert.equal(unitPriceToSen("14"), 1400);
  assert.equal(unitPriceToSen("0.0198"), 1.98);
  assert.equal(unitPriceToSen("1,234.50"), 123450);
  assert.equal(unitPriceToSen("1,2"), null);
  assert.equal(unitPriceToSen("12.34567"), null);
  assert.equal(unitPriceToSen("abc"), null);
  assert.equal(lastDayOfYm("2026-09"), "2026-09-30");
  assert.equal(lastDayOfYm("2026-02"), "2026-02-28");
  assert.equal(lastDayOfYm("2028-02"), "2028-02-29");
});

test("server: the latest purchase price per code on or before month-end; hints never become prices", () => {
  const r = slice(api, 'app.get("/stock-take/purchase-prices", async (c) => {', "\n});\n");
  assert.match(r, /requirePermission\(c, "accounting", "read"\)/);
  assert.match(r, /WHERE pi\.orgId = \? AND pi\.status NOT IN \('DRAFT','CANCELLED'\) AND pii\.lineType = 'STOCKED'/);
  assert.match(r, /if \(!key \|\| !date \|\| date > asOf \|\| qty <= 0 \|\| total <= 0\) continue;/, "nothing after month-end");
  assert.match(r, /const unitSen = Math\.round\(\(total \/ qty\) \* 10000\) \/ 10000;/, "the line's own total ÷ its qty");
  assert.match(r, /if \(date > cur\.date \|\| \(date === cur\.date && piNo > cur\.piNo\)\) Object\.assign\(cur, \{ unitSen, piNo, date, supplier, qty \}\);/, "newest wins");
  assert.match(r, /cur\.minUnitSen = Math\.min\(cur\.minUnitSen, unitSen\);\n\s+cur\.maxUnitSen = Math\.max\(cur\.maxUnitSen, unitSen\);/);
  assert.match(r, /return c\.json\(\{ success: true, data: \{ asOf, prices, priceList, batchCost \} \}\);/, "hints kept apart from prices");
  // BUG-2026-10-09-273: the price list is kept in sen (the PO screen reads it
  // as unitPriceSen) — a ×100 made every hint 100× too high.
  assert.match(r, /const unitSen = Math\.round\(Number\(r\.unitPrice\) \* 10000\) \/ 10000;/);
  assert.match(read("src/pages/procurement/create.tsx"), /unitPriceSen: binding\.unitPrice,/, "the price list is sen where purchase orders use it");
  assert.match(api, /import \{ itemCodeKey \} from "\.\.\/\.\.\/lib\/stock-take-import";/, "one matching rule, server and page");
});

test("server: the priced lines are kept with the month; the group count stays honest", () => {
  const put = slice(api, 'app.put("/stock-take", async (c) => {', "\n});\n");
  assert.match(put, /const groupsSaved = stmts\.length - cleared - aliasesSaved;/, "counted before the lines record joins the batch");
  assert.match(put, /\.bind\(stockTakeLinesKey\(orgId, ym\), JSON\.stringify\(\{ file: str\(body\.linesFile, 200\), asOf: str\(body\.linesAsOf, 10\), savedAt: now, lines \}\), now\)/);
  assert.match(api, /const stockTakeLinesKey = \(orgId: string, ym: string\) => `stock_take_lines:\$\{orgId\}:\$\{ym\}`;/);
  const get = slice(api, 'app.get("/stock-take/lines", async (c) => {', "\n});\n");
  assert.match(get, /requirePermission\(c, "accounting", "read"\)/);
});

test("page: import → review → put into the month → save with the lines", () => {
  const tab = slice(ui, "function StockTakeTab() {", "\nfunction OpeningStockTab()");
  const imp = slice(tab, "if (isRmCountShape(headerRow)) {", "// Shape 2:");
  assert.match(imp, /const asOf = lastDayOfYm\(ym\);/);
  assert.match(imp, /fetch\(`\/api\/accounting\/stock-take\/purchase-prices\?asOf=\$\{asOf\}`/);
  assert.match(imp, /const before = new Set\(entries\.filter\(\(e\) => e\.valueSen > 0 && !\(WIP_FG_KEYS as readonly string\[\]\)\.includes\(e\.itemGroup\)\)\.map\(\(e\) => e\.itemGroup\)\);/, "groups counted before are ticked");
  assert.doesNotMatch(imp, /setValueFor|setEdits/, "nothing fills the grid at import");
  const put = slice(tab, "const putPricedIntoMonth = () => {", "// The priced count already saved");
  assert.match(put, /const missing = pricedMissing\(priced\);\n\s+if \(missing\.length\) \{/, "no unpriced counted item goes in");
  const save = slice(tab, "const save = async () => {", "  return (\n");
  assert.match(save, /if \(pricedToSave && pricedStale\) \{/, "never with another month's prices");
  assert.match(save, /if \(pricedToSave && pricedMissing\(pricedToSave\)\.length\) \{/);
  assert.match(save, /linesFile: pricedToSave\.file,\n\s+linesAsOf: pricedToSave\.asOf,/);
  assert.match(save, /counted: i\.counted && !!pricedToSave\.groupsOn\[i\.group\],/);
  assert.match(tab, /if \(priced\.applied\) for \(const g of groupsInFile\) clearEditFor\(g\);/, "Close takes back what it filled");
  // A price typed over the purchase's is said as such.
  assert.match(ui, /return i\.unitStr\.trim\(\) === i\.piUnitStr \? i\.source : `typed in \(purchase RM \$\{i\.piUnitStr\}: \$\{i\.source\}\)`;/);
  assert.match(tab, /Priced count on file: \{linesOnFile\.lines\.filter\(\(l\) => l\.counted\)\.length\} of \{linesOnFile\.lines\.length\} items counted in/);
});
