// ---------------------------------------------------------------------------
// T-006 R10, client half. The six create/convert routes were wrapped in
// withIdempotency, but that wrapper no-ops without an `Idempotency-Key`
// header and no screen was sending one — the requirement was satisfied on
// paper and inert in the product. These tests fail if that happens again.
//
// Two halves:
//   1. every call site that posts to a wrapped route sends the header, and
//      takes it from the shared hook rather than minting a fresh uuid at the
//      fetch (a new uuid per call is not an idempotency key, it is noise);
//   2. the keep-or-rotate rule behind the key is exercised for real.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* native type-stripping handles it on newer Node */
}

// --- 1. the call sites ------------------------------------------------------
// file → the request it makes to a withIdempotency-wrapped route.
const CALL_SITES = [
  ["src/pages/delivery/index.tsx", "DO create from the Delivery page"],
  ["src/pages/sales/index.tsx", "SO → DO transfer (the duplicate-DO entry point)"],
  ["src/pages/consignment/note.tsx", "CN → invoice convert"],
  ["src/pages/delivery-returns/index.tsx", "delivery return create"],
  ["src/pages/purchase-returns/index.tsx", "purchase return create"],
  ["src/components/scan-supplier-modal.tsx", "scanned GRN + PI create"],
  ["src/pages/m/screens/DocumentDetailScreen.tsx", "mobile GRN create"],
];

for (const [file, what] of CALL_SITES) {
  test(`${what} sends an Idempotency-Key`, () => {
    const src = readFileSync(file, "utf8");
    assert.match(
      src,
      /"Idempotency-Key": key/,
      `${file} posts to an idempotent route but sends no key — the server wrapper is a no-op without it`,
    );
    assert.match(
      src,
      /useIdempotencyKeys?\(\)/,
      `${file} must take its key from the shared hook, not an inline crypto.randomUUID() (a fresh uuid per call protects nothing)`,
    );
  });
}

// --- 2. the keep-or-rotate rule --------------------------------------------
const { serverAnswered, resultAnswered } = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/idempotency-key.ts")).href
);
const { FetchJsonError } = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/fetch-json.ts")).href
);

test("a timed-out / dropped request counts as UNANSWERED — the key survives", () => {
  // fetchJson reports a timeout or network drop as status 0. That request may
  // well have committed on the server, so the retry must carry the same key.
  assert.equal(serverAnswered(new FetchJsonError("took too long", 0, "/api/grn")), false);
  assert.equal(serverAnswered(new TypeError("Failed to fetch")), false);
  assert.equal(resultAnswered({ ok: false, status: 0, error: "Network error" }), false);
});

test("any real response counts as ANSWERED — the key rotates", () => {
  // Including 4xx: the server caches those deliberately, so a form fixed and
  // resubmitted under the same key would replay the old rejection forever.
  for (const status of [200, 201, 400, 409, 500]) {
    assert.equal(
      serverAnswered(new FetchJsonError("x", status, "/api/grn")),
      true,
      `HTTP ${status} must rotate the key`,
    );
    assert.equal(resultAnswered({ ok: status < 400, status }), true);
  }
  assert.equal(resultAnswered(new Response(null, { status: 201 })), true);
});
