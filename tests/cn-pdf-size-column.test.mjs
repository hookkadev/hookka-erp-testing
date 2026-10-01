// ---------------------------------------------------------------------------
// cn-pdf-size-column.test.mjs — the CN PDF prints the CO line's size (a
// sofa's seat size, e.g. "28") in its own Size column, left of Set (DEV-30).
//
// The size comes from GET /api/consignment-notes/:id/print-extras (PO
// sizeLabel, CO line as fallback), NOT products.sizeLabel, which for a sofa
// is the module code ("1A(LHF)") and stays in the Description.
//
// Style: structural regex pins on source (cn-packing-list.test.mjs pattern);
// generate-cn-pdf.ts imports a .png so it can't be loaded under plain node.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p) => readFileSync(join(process.cwd(), ...p), "utf8");
const PDF = read("src", "lib", "generate-cn-pdf.ts");
const PAGE = read("src", "pages", "consignment", "note.tsx");
const API = read("src", "api", "routes", "consignment-notes.ts");

test("PDF head has Size between Description and Set", () => {
  assert.match(
    PDF,
    /content: "Description" \},\s*\{ content: "Size"[^}]*\} \},\s*\{ content: "Set"/,
  );
  assert.match(PDF, /desc,\s*it\.coSizeLabel \|\| "-",/);
});

test("PDF column indices shifted by one for the new column", () => {
  assert.match(PDF, /content: "Total", colSpan: 4,/);
  assert.match(PDF, /3: \{ cellWidth: \d+, halign: "center" \}, \/\/ Size/);
  // Quantity (rack sub-line) is col 5, the dashed row rule draws on col 7.
  assert.equal(
    (PDF.match(/d\.section === "body" && d\.column\.index === 5\)/g) || []).length,
    2,
  );
  assert.match(PDF, /d\.column\.index === 7\) \{\s*const y = d\.cell\.y \+ d\.cell\.height;/);
});

test("print-extras returns the PO / CO line size", () => {
  assert.match(API, /legHeightInches, specialOrder, sizeLabel\s+FROM consignment_order_items/);
  // PO stores "" when blank, so the fallback must be ||, not ??.
  assert.match(API, /sizeLabel: r\.sizeLabel \|\| fb\?\.sizeLabel \|\| null,/);
});

test("page maps print-extras sizeLabel to coSizeLabel, not the product sizeLabel", () => {
  assert.match(PAGE, /coSizeLabel: ex\?\.sizeLabel \?\? null,/);
  assert.match(PAGE, /sizeLabel: it\.sizeLabel,\s*fabricCode: it\.fabricCode,/);
});
