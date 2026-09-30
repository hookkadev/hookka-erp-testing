// T-006 R2 — GRN over-receipt must be checked CUMULATIVELY against the PO
// line's receivedQty (every GRN already posted), not just this document's
// own quantity. Was per-document only: two separate 100-unit GRNs against a
// 100-unit PO line each individually read "100 <= 110" and both posted.
// Source-static — no live D1 in CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('src/api/routes/grn.ts', 'utf8');
const block = SRC.slice(
  SRC.indexOf('// Over-receipt validation'),
  SRC.indexOf('// Over-receipt validation') + 1200,
);

test('the tolerance check reads receivedQty already on the PO line, not just this document', () => {
  assert.match(block, /const alreadyReceived = Number\(poItem\.receivedQty\) \|\| 0;/);
  assert.match(block, /const cumulative = alreadyReceived \+ item\.receivedQty;/);
});

test('the comparison is against the CUMULATIVE total, not the per-document quantity alone', () => {
  assert.match(block, /if \(cumulative > tolerance\)/);
  assert.doesNotMatch(
    block,
    /if \(item\.receivedQty > tolerance\)/,
    'the old per-document-only comparison must be gone, not left alongside the new one',
  );
});

test('the error message names both the already-received and this-receipt quantities', () => {
  assert.match(block, /already received \$\{alreadyReceived\}/);
  assert.match(block, /this receipt \$\{item\.receivedQty\}/);
});

// The concurrency half: the ceiling also sits in the counter statement, and
// no path raises the counter around it. Behaviour is driven through the route
// in purchasing-convert-flow.test.mjs and purchase-edit-cascade.test.mjs.
test('no statement raises the PO counter without the ceiling guard', () => {
  assert.doesNotMatch(
    SRC,
    /SET receivedQty = receivedQty \+ \?/,
    'every increase must go through poCounterIncrement',
  );
  assert.equal(SRC.split('poCounterIncrement(db,').length - 1, 2, 'receipt post and qty edit');
});

test('a raised guard is mapped to 409 around both batches that can carry it', () => {
  assert.equal(
    SRC.split('if (isPoOverReceiptRace(e)) {').length - 1,
    2,
    'POST / and PUT /:id',
  );
  assert.match(SRC, /error: PO_OVER_RECEIPT_RACE_ERROR \}, 409\)/);
});
