// ---------------------------------------------------------------------------
// cashflow-statement-batching.test.mjs — owner 2026-09-29 「为什么他的 load 这么
// 慢」→「可以做，但是还是主要确保数据对」.
//
// Measured on prod: GET /cashflow-statement took 8.6–9.3 s while every other
// endpoint answered in 50–120 ms. The cause was one query per ticked supplier
// payment (115) plus one per settled purchase invoice (298) — ~415 serial
// round-trips from the Worker to Postgres. The same two reads now come in
// bulk (chunked IN lists) and the split arithmetic is unchanged, so every
// figure on the statement stays exactly what it was.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const api = readFileSync("src/api/routes/accounting.ts", "utf8").replace(/\r\n/g, "\n");
const body = api.slice(api.indexOf("async function computeCashflowStatement("), api.indexOf('app.get("/cashflow-statement"'));

test("no per-payment or per-PI query survives inside the statement", () => {
  // (A comment in the function still quotes the old per-PI SQL as history —
  // match the prepared statement, not the prose.)
  assert.doesNotMatch(body, /prepare\("SELECT \* FROM purchase_invoice_items WHERE pi_id = \?"\)/, "the per-PI item query is back");
  assert.doesNotMatch(body, /WHERE sp\.payment_no = \? AND/, "the per-payment allocation query is back");
  assert.doesNotMatch(body, /const piWeightsFor = async/, "piWeightsFor must be a pure lookup now");
  assert.doesNotMatch(body, /const weightsForPayment = async/, "weightsForPayment must be a pure lookup now");
});

test("the two reads are bulk, chunked IN lists over the ticked payments and their PIs", () => {
  assert.match(body, /for \(const part of chunk\(\[\.\.\.paymentNos\], 200\)\) \{/);
  assert.match(body, /WHERE sp\.payment_no IN \(\$\{part\.map\(\(\) => "\?"\)\.join\(","\)\}\) AND COALESCE\(sp\.method,''\) <> 'CREDIT_NOTE'/);
  assert.match(body, /for \(const part of chunk\(\[\.\.\.piIds\], 200\)\) \{/);
  assert.match(body, /SELECT \* FROM purchase_invoice_items WHERE pi_id IN \(\$\{part\.map\(\(\) => "\?"\)\.join\(","\)\}\)/);
  // Rows are grouped dual-keyed (the PG adapter camelCases columns).
  assert.match(body, /const no = String\(r\.paymentNo \?\? r\.payment_no \?\? ""\);/);
  assert.match(body, /const id = String\(it\.piId \?\? it\.pi_id \?\? ""\);/);
});

test("the split arithmetic is untouched — same labels, same weights, same rounding", () => {
  for (const re of [
    /const line = lt === "TAX" \? "SST \/ TAX" : grp \? \(sgOverride\[grp\] \?\? grp\) : `Unallocated — \$\{supplier\}`;/,
    /w\.set\(line, \(w\.get\(line\) \?\? 0\) \+ Math\.max\(0, amt\)\);/,
    /if \(String\(row\.method \?\? ""\) === "TF_REPAYMENT"\) \{ bump\("Trade finance repayment", booked\); continue; \}/,
    /if \(!piId\) \{ bump\("Supplier advance \/ deposit", booked\); continue; \}/,
    /if \(!totalW\) \{ bump\(piId\.startsWith\("pi-ob-"\) \? `Opening creditors — \$\{supplier\}` : `Unallocated — \$\{supplier\}`, booked\); continue; \}/,
    /for \(const \[line, lw\] of w\) bump\(line, \(booked \* lw\) \/ totalW\);/,
    /rmSplit\[payNo\] = \[\.\.\.weights\.entries\(\)\]\.map\(\(\[line, weight\]\) => \(\{ line, weight: Math\.round\(weight\) \}\)\);/,
  ]) assert.match(body, re);
});
