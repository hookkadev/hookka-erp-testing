// The PO list search must find an order by a line item's internal code,
// supplier SKU or description (src/lib/po-items-search.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }

const { poItemsSearchText } = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/po-items-search.ts")).href
);

const items = [
  { materialCode: "CBP 1000", supplierSKU: "", materialName: 'LAMINATED GREY CGIPBOARD 1,000 GM 31" X 43"' },
  { materialCode: "ASC1010F", supplierSKU: "OST- ASC1010F", materialName: "C -1010F AIR STAPLES 5,000PCS X 40 BOX" },
];

test("internal code, supplier SKU and description are all searchable", () => {
  const text = poItemsSearchText(items).toLowerCase();
  for (const q of ["cbp 1000", "ost- asc1010f", "air staples", "cgipboard"]) {
    assert.ok(text.includes(q), `"${q}" not findable`);
  }
});

test("dual-keyed supplierSku is honoured; empty/null items yield empty text", () => {
  assert.equal(poItemsSearchText([{ supplierSku: "X-1" }]), "X-1");
  assert.equal(poItemsSearchText([{ materialCode: null, materialName: "  " }]), "");
  assert.equal(poItemsSearchText([]), "");
  assert.equal(poItemsSearchText(undefined), "");
});
