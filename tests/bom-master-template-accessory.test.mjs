// ---------------------------------------------------------------------------
// bom-master-template-accessory.test.mjs — the BOM page offers an ACCESSORY
// master template category, but PUT /api/bom-master-templates/:id only
// accepted BEDFRAME/SOFA and answered 400 "category must be BEDFRAME or SOFA"
// (confirmed on staging 2026-10-05), and migration 0006's CHECK had the same
// two values. The bulk PUT silently skipped ACCESSORY rows. Pins: the route
// accepts all three categories, and both PUTs widen the DB CHECK before
// writing.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isCategory } from "../src/api/routes/bom-master-templates.ts";

const src = readFileSync(
  resolve(process.cwd(), "src/api/routes/bom-master-templates.ts"),
  "utf8",
);

test("all three BOM categories are accepted, nothing else", () => {
  for (const c of ["BEDFRAME", "SOFA", "ACCESSORY"]) assert.ok(isCategory(c), c);
  for (const c of ["accessory", "", null, undefined, "OTHER"]) {
    assert.equal(isCategory(c), false, String(c));
  }
});

test("the runtime DDL allows ACCESSORY in the category CHECK", () => {
  assert.match(
    src,
    /ADD CONSTRAINT bom_master_templates_category_check CHECK \(category IN \('BEDFRAME','SOFA','ACCESSORY'\)\)/,
  );
});

test("both PUT handlers widen the CHECK before their first write", () => {
  for (const route of ['app.put("/:id"', 'app.put("/"']) {
    const start = src.indexOf(route);
    assert.ok(start >= 0, `${route} must exist`);
    const ensure = src.indexOf("await ensureCategoryCheck(", start);
    const write = src.indexOf("INSERT INTO bom_master_templates", start);
    assert.ok(ensure > start && ensure < write, `${route} must ensure before INSERT`);
  }
});
