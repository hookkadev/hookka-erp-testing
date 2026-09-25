// ---------------------------------------------------------------------------
// invoice-pdf-line-refs — BUG-22 (INV-2609-067). Invoice print-extras
// (computeInvoicePrintExtras) name each line's refs customerSOLine /
// customerRefLine / companySO; the DO extras call them customerSO / customerRef
// / salesOrderNo. The unified invoice builder read only the DO names, so every
// line printed the invoice-level SO/REF ("FAIR ITEM PG") and a blank CO SO,
// while the PO — named customerPOId on both sides — was correct.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }

const load = (p) => import(pathToFileURL(resolve(process.cwd(), p)).href);
const { buildUnifiedInvoiceData } = await load("src/lib/build-unified-doc-data.ts");

test("each invoice line prints its OWN SO / REF / CO SO, falling back only when unresolved", () => {
  const data = buildUnifiedInvoiceData({
    invoiceNo: "INV-TEST-002", docDate: "2026-09-22", customerName: "Houzs",
    fallbackCustomerSO: "FAIR ITEM PG", fallbackCustomerRef: "FAIR ITEM PG",
    items: [
      { id: "a", productCode: "1007-(K)", productName: "CODY", quantity: 1, priceSen: 55000, lineTotalSen: 55000,
        extra: { customerPOId: "HC-PO-2609-078", customerSOLine: "HC-SO-078", customerRefLine: "REF-A", companySO: "SO-2609-010" } },
      { id: "b", productCode: "1013-(SS)", productName: "JAGER", quantity: 1, priceSen: 28750, lineTotalSen: 28750,
        extra: { customerPOId: "HC-PO-2609-020" } },
    ],
    subtotalSen: 83750, totalSen: 83750,
  });
  const [a, b] = data.groups.flatMap((g) => g.items);
  assert.deepEqual(a.orderRefs, ["PO: HC-PO-2609-078", "SO: HC-SO-078", "REF: REF-A", "CO SO: SO-2609-010"]);
  assert.deepEqual(b.orderRefs, ["PO: HC-PO-2609-020", "SO: FAIR ITEM PG", "REF: FAIR ITEM PG", "CO SO: -"]);
});
