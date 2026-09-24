// ---------------------------------------------------------------------------
// Scan autofill: the supplier's code is OUR code in another form.
//
// Meditex SMI2608/599 (2026-09-24): NICCA-6-FOG came through blank because
// nothing linked it yet, there was no usable PO, and "TEXTILE FABRIC,- FOG
// WIDTH 145CM" cannot single out NICCA-06 (whose description is just
// "FABRIC"). The operators want scans to fill themselves, and the codes on
// that one invoice show the pattern: ours inside theirs, theirs inside ours,
// or identical. `codeFamilyMatch` is that rule; these pin it and its refusals.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  codeParts,
  codeFamilyMatch,
  sameSupplierCode,
  resolveMaterialForLine,
  buildCandidateTiers,
  indexByCode,
} from "../src/lib/supplier-material-candidates.ts";

const CATALOG = [
  { itemCode: "NICCA-06", description: "FABRIC" },
  { itemCode: "MED-PSF15.064HCS(14)(L)", description: "POLYESTER FIBER 15D X 64MM" },
  { itemCode: 'TARONI-CREAM 82"', description: "CREAM" },
  { itemCode: "NICCA-08", description: "FABRIC" },
  { itemCode: "PLY-9-48", description: "9MM PLYWOOD" },
];

test("codeParts: punctuation, spacing and zero-padding do not matter", () => {
  assert.deepEqual(codeParts("NICCA-06"), ["NICCA", "6"]);
  assert.deepEqual(codeParts("nicca 6 fog"), ["NICCA", "6", "FOG"]);
  assert.deepEqual(codeParts("PSF15.064HCS(14)"), ["PSF", "15", "64", "HCS", "14"]);
  assert.deepEqual(codeParts("00"), ["0"]);
});

test("the three Meditex lines resolve on the supplier's code alone", () => {
  assert.equal(codeFamilyMatch("NICCA-6-FOG", CATALOG)?.itemCode, "NICCA-06", "ours inside theirs");
  assert.equal(codeFamilyMatch("PSF15.064HCS(14)", CATALOG)?.itemCode, "MED-PSF15.064HCS(14)(L)", "theirs inside ours");
  assert.equal(codeFamilyMatch('TARONI-CREAM 82"', CATALOG)?.itemCode, 'TARONI-CREAM 82"', "identical");
});

test("the longest shared run wins; an equal tie is refused, not guessed", () => {
  const withColour = [...CATALOG, { itemCode: "NICCA-06-FOG", description: "FABRIC FOG" }];
  assert.equal(codeFamilyMatch("NICCA-6-FOG", withColour)?.itemCode, "NICCA-06-FOG");
  const twins = [{ itemCode: "AB-12" }, { itemCode: "CD-AB-12-X" }];
  // "AB-12" sits inside both, with the same 2-part run → ambiguous.
  assert.equal(codeFamilyMatch("AB-12", twins), null);
});

test("too little to identify: short runs, row numbers and blanks never match", () => {
  assert.equal(codeFamilyMatch("FOG", CATALOG), null, "one part");
  assert.equal(codeFamilyMatch("N-6", [{ itemCode: "N-6-X" }]), null, "under 5 chars");
  assert.equal(codeFamilyMatch("2", CATALOG), null, "a row number is not a code");
  assert.equal(codeFamilyMatch("", CATALOG), null);
  assert.equal(codeFamilyMatch("NICCA-7-FOG", CATALOG), null, "a different number is a different item");
});

test("resolveMaterialForLine: the code beats the wording, tier by tier", () => {
  const tiers = buildCandidateTiers({
    supplierId: "sup-med",
    linkedPo: null,
    purchaseOrders: [],
    bindings: [],
    materialByCode: indexByCode(CATALOG),
    catalog: CATALOG,
  });
  const hit = resolveMaterialForLine("NICCA-6-FOG TEXTILE FABRIC,- FOG WIDTH: 145CM +/- 2", tiers, {
    supplierSku: "NICCA-6-FOG",
  });
  assert.equal(hit?.item.itemCode, "NICCA-06");
  assert.equal(hit?.via, "code");
  assert.equal(hit?.tier, "catalog");
});

test("a saved code with different zero-padding is the same code (NICCA-6-FOG = NICCA-06-FOG)", () => {
  assert.equal(sameSupplierCode("NICCA-6-FOG", "NICCA-06-FOG"), true);
  assert.equal(sameSupplierCode("nicca 6 fog", "NICCA06FOG"), true);
  assert.equal(sameSupplierCode("NICCA-6", "NICCA-6-FOG"), false, "a longer code is not the same code");
  assert.equal(sameSupplierCode("NICCA-6-FOG", "NICCA-7-FOG"), false);
  assert.equal(sameSupplierCode("", ""), false);
  // The PO-learned code index honours it too.
  const nicca = { itemCode: "NICCA-06", description: "FABRIC" };
  const hit = resolveMaterialForLine("anything", [], {
    supplierSku: "NICCA-6-FOG",
    skuIndex: new Map([["NICCA06FOG", nicca]]),
  });
  assert.equal(hit?.item.itemCode, "NICCA-06");
  assert.equal(hit?.via, "sku");
});

test("expected fill for the Meditex line: FABRIC / NICCA-06 / the saved supplier code", () => {
  // What the card builds: Description = the material's description,
  // Internal Code = the match, Supplier SKU = the saved binding's code.
  const hit = codeFamilyMatch("NICCA-6-FOG", CATALOG);
  assert.equal(hit?.itemCode, "NICCA-06");
  assert.equal(hit?.description, "FABRIC");
  const src = readFileSync(new URL("../src/components/scan-supplier-modal.tsx", import.meta.url), "utf8");
  assert.match(src, /materialName: rm\?\.description \?\? descOut/);
  assert.match(src, /const sku = resolvedBinding\?\.supplierSku \?\? rawSku;/);
  assert.equal((src.match(/sameSupplierCode\(b\.supplierSku, supplierSku\)/g) ?? []).length, 2, "PI + GRN binding lookups");
});

test("scan card: a hand pick clears the machine-match flags so Create can learn it", () => {
  const src = readFileSync(new URL("../src/components/scan-supplier-modal.tsx", import.meta.url), "utf8");
  const picks = src.match(/materialCode: o\.itemCode,[\s\S]{0,900}?matchVia: null,/g) ?? [];
  assert.equal(picks.length, 2, "PI and GRN wizards");
  assert.match(src, /if \(via === "code"\) return "Matched on the supplier's code/);
});

test("PI edit teaches the binding for CORRECTED lines only", () => {
  const src = readFileSync(new URL("../src/api/routes/purchase-invoices.ts", import.meta.url), "utf8");
  assert.match(src, /const priorPairs = normalizedItems && normalizedItems\.ok/);
  assert.match(src, /learnable: !priorPairs\.has\(supplierPairKey\(r\.materialCode, r\.supplierSku\)\)/);
  assert.equal((src.match(/await learnSupplierBindings\(/g) ?? []).length, 2, "create + edit");
});
