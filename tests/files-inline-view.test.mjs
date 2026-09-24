// ---------------------------------------------------------------------------
// PI "View source document" downloaded instead of opening (2026-09-24).
//
// af09716b made /api/files/:id/download always append Supabase's `download=`
// param (fixing UUID-named saves), which forces a SAVE for every caller —
// including "View" buttons. `?inline=1` is the opt-out, honoured only for the
// upload allowlist so HTML/SVG can never render same-origin.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { wantsInline } from "../src/api/routes/files.ts";

test("inline only when asked AND the type is allowlisted", () => {
  assert.equal(wantsInline("1", "application/pdf"), true);
  assert.equal(wantsInline("1", "image/jpeg"), true);
  assert.equal(wantsInline(undefined, "application/pdf"), false, "default stays a download");
  assert.equal(wantsInline("1", "text/html"), false);
  assert.equal(wantsInline("1", "image/svg+xml"), false);
  assert.equal(wantsInline("1", null), false);
});

test("the PI View source document button asks for inline", () => {
  const src = readFileSync(new URL("../src/pages/procurement/PurchaseInvoiceDetail.tsx", import.meta.url), "utf8");
  assert.match(src, /\/download\?inline=1`;\s*window\.open\(/);
});
