// ---------------------------------------------------------------------------
// t010-ocr-scan.test.mjs — PRD T-010 (OCR: faster, self-learning, originals kept).
//
// Behaviour tests for the pure / injectable pieces, plus source pins for the
// rules that live inside route handlers (no worker or DB is booted here — see
// the note in docs/CODEBASE-MAP.md about what source-text tests do and don't
// prove).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { callAnthropic, isRetryableStatus } from "../src/api/lib/ai-http.ts";
import { correctionPairs, diffSupplierSample } from "../src/api/lib/ocr-accuracy-core.ts";
import { applyCodeAliases, recordCorrections } from "../src/api/lib/ocr-learning.ts";
import { distillCustomerRules } from "../src/api/lib/ocr-distill.ts";

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// ---- R5: shared AI HTTP helper ---------------------------------------------
const okBody = JSON.stringify({
  content: [{ type: "text", text: "{}" }],
  usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 7, cache_creation_input_tokens: 0 },
});
const resp = (status, body = "overloaded", headers = {}) => new Response(body, { status, headers });
const noSleep = { sleep: async () => {} };

test("ai-http: a 529 is retried and the usage block is mapped", async () => {
  const seq = [resp(529), resp(529), resp(200, okBody)];
  let calls = 0;
  const r = await callAnthropic("k", {}, { ...noSleep, fetchImpl: async () => seq[calls++] });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
  assert.deepEqual(r.usage, { tokensIn: 10, tokensOut: 2, cacheReadTokens: 7, cacheWriteTokens: 0 });
});

test("ai-http: a 400 is NOT retried (a bad request stays bad)", async () => {
  let calls = 0;
  const r = await callAnthropic("k", {}, { ...noSleep, fetchImpl: async () => (calls++, resp(400, "bad")) });
  assert.equal(r.ok, false);
  assert.equal(calls, 1);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(429), true);
});

test("ai-http: a timeout is NOT retried (the caller's budget is already spent)", async () => {
  let calls = 0;
  const r = await callAnthropic("k", {}, {
    ...noSleep,
    fetchImpl: async () => {
      calls++;
      throw Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
    },
  });
  assert.equal(r.ok, false);
  assert.equal(calls, 1);
  assert.match(r.error, /timed out/);
});

test("ai-http: retries are exhausted, not infinite", async () => {
  let calls = 0;
  const r = await callAnthropic("k", {}, { ...noSleep, retries: 2, fetchImpl: async () => (calls++, resp(503)) });
  assert.equal(r.ok, false);
  assert.equal(calls, 3);
});

// ---- R7: correction pairs ---------------------------------------------------
const RAW_PO = {
  pos: [
    { customerPO: "PO-1", customerName: "Houzs Century Sdn Bhd", items: [{ productCode: "X" }] },
    {
      customerPO: "PO-009753",
      customerName: "Houzs Century",
      items: [
        { productCode: "ZNT6055", fabricCode: "NX011", quantity: 1, rawSpec: "SOFA 5540 2A(LHF)" },
        { productCode: "5540-L(RHF)", fabricCode: "NX011", quantity: 1 },
      ],
    },
  ],
};
const FIXED_PO = {
  customerPO: "PO-009753",
  customerName: "Houzs Century",
  items: [
    { productCode: "5540-2A(LHF)", fabricCode: "NX011", quantity: 1 },
    { productCode: "5540-L(RHF)", fabricCode: "NX011", quantity: 2 },
  ],
};

test("correctionPairs: matches the PO by NUMBER inside the envelope and keeps the values", () => {
  const pairs = correctionPairs("po", RAW_PO, FIXED_PO);
  assert.deepEqual(
    pairs.map((p) => [p.field, p.lineNo, p.rawValue, p.finalValue]),
    [
      ["productCode", 0, "ZNT6055", "5540-2A(LHF)"],
      ["quantity", 1, "1", "2"],
    ],
  );
  assert.equal(pairs[0].context, "SOFA 5540 2A(LHF)");
});

test("correctionPairs: an untouched scan yields nothing (and agrees with the dashboard diff)", () => {
  const doc = { docs: [{ docNo: "INV-1", supplierName: "ACME", lines: [{ supplierCode: "A1", qty: 5 }] }] };
  assert.deepEqual(correctionPairs("supplier", doc, doc), []);
  assert.equal(diffSupplierSample(doc, doc).changed, false);
});

test("correctionPairs: supplier raw is narrowed to the imported docNo", () => {
  const raw = { docs: [{ docNo: "A", lines: [{ qty: 1 }] }, { docNo: "B", lines: [{ qty: 9 }] }] };
  const pairs = correctionPairs("supplier", raw, { docNo: "B", lines: [{ qty: 8 }] });
  assert.deepEqual(pairs.map((p) => [p.field, p.rawValue, p.finalValue]), [["qty", "9", "8"]]);
});

// ---- R8: code aliases -------------------------------------------------------
test("applyCodeAliases: rewrites a learned code, keeps the model's reading, ignores punctuation", () => {
  const data = { pos: [{ items: [{ productCode: "znt-6055" }, { productCode: "5540-L(RHF)" }] }] };
  const hits = applyCodeAliases("po", data, new Map([["productCode|ZNT6055", "5540-2A(LHF)"]]));
  assert.equal(hits.length, 1);
  assert.deepEqual(data.pos[0].items[0], { productCode: "5540-2A(LHF)", productCodeOcr: "znt-6055" });
  assert.deepEqual(data.pos[0].items[1], { productCode: "5540-L(RHF)" });
});

// A fake DB that records every statement and answers the two catalogue reads.
function fakeDb({ productCodes = [] } = {}) {
  const log = [];
  const stmt = (sql, args = []) => ({
    async run() {
      log.push({ sql, args });
      return { success: true, meta: { changes: 1 } };
    },
    async first() {
      log.push({ sql, args });
      return null;
    },
    async all() {
      log.push({ sql, args });
      if (sql.includes("FROM products")) return { results: productCodes.map((code) => ({ code })) };
      return { results: [] };
    },
  });
  return { log, prepare: (sql) => ({ ...stmt(sql), bind: (...args) => stmt(sql, args) }) };
}
const wrote = (db, table) => db.log.filter((l) => l.sql.includes(`INSERT INTO ${table}`));

test("recordCorrections: a customer's own part number becomes an alias and queues a distill", async () => {
  const db = fakeDb({ productCodes: ["5540-2A(LHF)", "5540-L(RHF)"] });
  const out = await recordCorrections(db, {
    tenantId: "hookka", kind: "po", sampleId: "pos-1", partyId: "cust-houzs",
    raw: RAW_PO, corrected: FIXED_PO, correctedBy: "u1",
  });
  assert.deepEqual(out, { corrections: 2, aliases: 1, queued: true });
  assert.equal(wrote(db, "ocr_corrections").length, 2);
  const alias = wrote(db, "ocr_code_aliases")[0].args;
  assert.ok(alias.includes("ZNT6055") && alias.includes("5540-2A(LHF)") && alias.includes("cust-houzs"));
  assert.equal(wrote(db, "ocr_distill_queue").length, 1);
});

test("recordCorrections: a VALID code that was still wrong is never aliased", async () => {
  // Aliasing 5540-L(RHF) → 5540-2A(LHF) would rewrite every genuine 5540-L(RHF).
  const db = fakeDb({ productCodes: ["5540-2A(LHF)", "5540-L(RHF)"] });
  const out = await recordCorrections(db, {
    tenantId: "hookka", kind: "po", sampleId: "pos-2", partyId: "cust-houzs",
    raw: { customerPO: "P", items: [{ productCode: "5540-L(RHF)" }] },
    corrected: { customerPO: "P", items: [{ productCode: "5540-2A(LHF)" }] },
    correctedBy: null,
  });
  assert.equal(out.corrections, 1);
  assert.equal(out.aliases, 0);
});

// ---- R9 / R12: the distiller sees the mistakes and versions its output -------
test("distill: correction pairs reach the prompt, and the result is written as a version", async () => {
  const log = [];
  const db = {
    prepare: (sql) => ({
      bind: (...args) => ({
        async first() {
          if (sql.includes("FROM customers WHERE id")) return { id: "c1", code: "HZ", name: "Houzs Century" };
          return null; // no previous ocr_rule_versions row → version 1
        },
        async all() {
          if (sql.includes("FROM po_scan_samples"))
            return { results: [1, 2].map((n) => ({ id: `s${n}`, correctedJson: "{}", rawJson: "{}", createdAt: "2026-09-01" })) };
          if (sql.includes("FROM ocr_corrections"))
            return { results: [{ field: "productCode", raw_value: "ZNT6055", final_value: "5540-2A(LHF)", context: "SOFA 5540", n: 4 }] };
          return { results: [] };
        },
        async run() {
          log.push({ sql, args });
          return { success: true, meta: { changes: 1 } };
        },
      }),
    }),
  };
  const realFetch = globalThis.fetch;
  let sent = "";
  globalThis.fetch = async (_url, init) => {
    sent = String(init.body);
    return new Response(JSON.stringify({ content: [{ type: "text", text: "- ZNT codes are the customer's REF, not ours." }], usage: {} }), { status: 200 });
  };
  try {
    const res = await distillCustomerRules(db, { ANTHROPIC_API_KEY: "k" }, "hookka", "c1");
    assert.equal(res.status, "distilled");
    assert.equal(res.pairCount, 1);
    assert.equal(res.version, 1);
    assert.match(sent, /CORRECTION PAIRS/);
    assert.match(sent, /ZNT6055 \| 5540-2A\(LHF\)/);
    assert.ok(log.some((l) => l.sql.includes("INSERT INTO ocr_rule_versions")));
    assert.ok(log.some((l) => l.sql.includes("UPDATE customers SET ocrPromptRules")));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- source pins: rules that live inside handlers ----------------------------
test("R2/R13 scan-queue: no tenant escape hatch, and one INSERT that writes a storage key", () => {
  const q = src("src/api/routes/scan-queue.ts");
  assert.doesNotMatch(q, /OR org_id IS NULL\)/, "tenant-less rows must not be readable");
  assert.equal(q.match(/INSERT INTO scan_queue/g)?.length, 1, "upload + split share insertQueueRow");
  assert.match(q, /storage_key, file_bytes_b64/);
  // base64 is written ONLY on the storage-not-configured fallback.
  assert.equal(q.match(/toBase64\(/g)?.length, 2, "one definition + one fallback use");
});

test("R3 scan-engine: only the issuing customer's rules, two 1-hour cache breakpoints, no raw fetch", () => {
  const e = src("src/api/lib/scan-engine.ts");
  assert.match(e, /formatCustomerRules\(\{ \.\.\.catalog, customers: \[issuer\] \}\)/);
  assert.ok((e.match(/cache_control: CACHE_1H/g) ?? []).length >= 4);
  assert.doesNotMatch(e, /await fetch\(/, "every model call goes through ai-http");
  assert.doesNotMatch(src("src/api/lib/ocr-distill.ts"), /await fetch\(/);
  assert.match(src("src/api/lib/ai-http.ts"), /ttl: "1h"/);
});

test("R14-R16 files: archive instead of delete, posted originals refuse, views are inline + logged", () => {
  const f = src("src/api/routes/files.ts");
  assert.doesNotMatch(f, /DELETE FROM file_assets/);
  assert.match(f, /SET archived = TRUE/);
  assert.match(f, /code: "FILE_LOCKED" \}, 409/);
  assert.match(f, /delivery_orders WHERE sales_order_id = \? AND status NOT IN \('DRAFT','CANCELLED'\)/);
  assert.match(f, /purchase_invoices WHERE source_document_file_id = \?/);
  assert.match(f, /\? "inline" : "attachment"/);
  assert.equal(f.match(/logAccess\(c, id,/g)?.length, 2, "download and stream both log");
});

test("R13 scan-po: every sample read/write is tenant-scoped", () => {
  const p = src("src/api/routes/scan-po.ts");
  for (const m of p.matchAll(/(UPDATE po_scan_samples SET[^"`]*|FROM po_scan_samples\s+WHERE[^`"]*)/g)) {
    assert.match(m[0], /org_id = \?/, m[0].slice(0, 80));
  }
});

// ---- Slice 2: R10 / R11 / R17 UI + server wiring (source pins) -------------
test("R11 review endpoint is tenant-scoped and registered before /:id", () => {
  const q = src("src/api/routes/scan-queue.ts");
  const at = q.indexOf('app.get("/review"');
  assert.ok(at > 0 && at < q.indexOf('app.get("/:id"'), "/review must precede /:id");
  assert.match(q.slice(at, at + 1200), /org_id = \? AND status IN \('done', 'cached'\) AND consumed_at IS NULL/);
});

test("R10 finance forms confirm the scan sample and clear it when the form closes", () => {
  const a = src("src/pages/accounting/index.tsx");
  assert.equal(a.match(/confirmFinanceScan\(scanRef\.current/g)?.length, 2, "bill + receipt both confirm");
  assert.equal(a.match(/if \(!showForm\) scanRef\.current = null/g)?.length, 2, "a closed form must not leak its scan");
  assert.match(a, /samples\/\$\{encodeURIComponent\(scan\.sampleId\)\}\/confirm/);
});

test("R17 assistant attachments are kept via saveOriginalFile, off the response path", () => {
  const a = src("src/api/routes/assistant.ts");
  assert.match(a, /saveOriginalFile\(c\.var\.DB, c\.env,/);
  assert.match(a, /executionCtx\.waitUntil\(keep\)/);
  const f = src("src/api/routes/files.ts");
  assert.match(f, /if \(!ALLOWED_MIME\.has\(f\.contentType\)\) return false;/);
});
