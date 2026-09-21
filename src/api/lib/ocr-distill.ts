// ---------------------------------------------------------------------------
// OCR rule distillation — reusable core, one function for both party types.
//
// For one customer / supplier it: loads up to 50 operator-confirmed samples,
// refuses if fewer than 2 (no model call), loads that party's CORRECTION PAIRS
// from ocr_corrections, makes one Claude call, and writes the result into
// <party>.ocrPromptRules (REPLACING the old value — "regenerate", not "merge").
//
// T-010 changes
// -------------
//   R9  The distiller used to see only the corrected result, never the mistake.
//       It now also gets (what the model read → what the person typed) pairs.
//   R12 Every distillation is a numbered row in ocr_rule_versions carrying the
//       success rate of the scans made under the PREVIOUS rules; the same number
//       closes that previous version's `success_rate_after`. Before/after is one
//       computation, stored twice.
//   R5  The model call goes through ai-http (timeout + retry — this file had
//       neither). The sweep is time-budgeted, and confirm-time work arrives via
//       ocr_distill_queue, one party per job.
//   R13 Customer samples are tenant-filtered (they had no tenant column at all).
//
// The customer and supplier distillers were two ~200-line copies of each other;
// they are now one function driven by a small spec.
//
// Callers: the manual routes (RBAC-gated there), the confirm endpoints (gold
// mark), and the cron /api/internal/distill-ocr-rules (CRON_SECRET-gated in
// worker.ts). Auth is ALWAYS the caller's job — this lib has no user session.
// ---------------------------------------------------------------------------

import { runSelfApply } from "../lib/self-apply";
import { callAnthropic } from "./ai-http";
import { diffSalesOrderSample, diffSupplierSample, rateOf } from "./ocr-accuracy-core";
import { ensureOcrLearningSchema, popDistillJob, type LearnDb, type LearnPartyType } from "./ocr-learning";

const CLAUDE_MODEL = "claude-sonnet-4-6";
// Distillation had NO timeout before T-010; one stalled call could eat the
// cron's whole 280s. 90s is ~3x a normal distill.
const DISTILL_TIMEOUT_MS = 90_000;

// Minimal structural DB surface. Kept local so this lib has no import cycle
// with the routes.
type DistillQuery = {
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results?: T[] }>;
  run: () => Promise<{ success: boolean; meta: { changes: number } }>;
};
type DistillDb = {
  prepare: (sql: string) => { bind: (...args: unknown[]) => DistillQuery };
};

// Only the field this lib reads off the worker env.
type DistillEnv = { ANTHROPIC_API_KEY?: string };

/**
 * Outcome of one party's distillation. Deliberately small — the cron
 * aggregates these into a {distilled, skipped, errored} summary, and the
 * routes map it back to their existing JSON response shape.
 */
export type DistillResult = {
  status: "distilled" | "skipped" | "error";
  /** Human-readable reason for skip/error (omitted on success). */
  reason?: string;
  /** Distilled rule text (present only on status === "distilled"). */
  rulesGenerated?: string;
  /** Samples fed to Claude (also set on the <2-samples skip). */
  sampleCount?: number;
  /** Correction pairs fed to Claude. */
  pairCount?: number;
  /** Version number written to ocr_rule_versions. */
  version?: number;
  /** Success rate (0-100) of scans made under the previous rules; null = none. */
  successRateBefore?: number | null;
  tokensIn?: number;
  tokensOut?: number;
};

const DISTILL_META_PROMPT = `You are reviewing operator-confirmed correct extractions of customer Purchase Orders for a furniture manufacturer (Hookka). Your task is to write a concise customer-specific OCR rule block that captures the patterns unique to THIS customer's POs so a future OCR call applies them automatically.

Look at the patterns in the confirmed extractions below and identify what is BESPOKE TO THIS CUSTOMER:
  • Their PO number format (prefix, length, letter/digit pattern).
  • The size codes they use (e.g. "(K)", "(Q)", "K-size", "Queen", etc.).
  • Their fabric code conventions (prefix families like PC151-*, KN390-*, BO315-*).
  • Their spec-line shorthand for divan / leg / gap / drawer / no-leg phrasings.
  • Sofa module shorthand (1+1+1, 2+L, 1R+1R, "3 Seater" splits, etc.).
  • Special-order phrasings they use in handwritten notes (urgency cues, fabric overrides, backrest specials).
  • Any letterhead / header layout cues that identify them.
  • Hub / state defaults if they consistently ship to one location.
  • Quirks that conflict with the universal rules — call those out explicitly.

DO NOT restate universal rules that apply to all customers.
DO NOT enumerate every line item from the examples.
DO NOT write a generic OCR primer.
DO write 100-300 words of plain prose, focused on what is DIFFERENT about this customer.
DO use bullet points or short paragraphs. No markdown headers, no fences, no preamble, no closing.

You are ALSO given CORRECTION PAIRS: what the OCR model actually read, and what the operator changed it to, on this party's past documents. These are the model's real mistakes. Prioritise rules that prevent each recurring pair — a pair seen several times outweighs any pattern you infer from the clean examples. State the cue that distinguishes the right reading; do not just list the pairs back.

Output ONLY the rule text. The very first character of your response must be a letter or a bullet marker (•, -, *). Anything else will be stored verbatim into the prompt and corrupt downstream extractions.`;

const SUPPLIER_DISTILL_META_PROMPT = `You are reviewing operator-confirmed correct extractions of SUPPLIER documents (delivery notes / invoices) for a furniture manufacturer (Hookka). These documents drive Goods Received Notes (GRN) and Purchase Invoices. Your task is to write a concise supplier-specific OCR rule block that captures the patterns unique to THIS supplier's documents so a future OCR call applies them automatically.

Look at the patterns in the confirmed extractions below and identify what is BESPOKE TO THIS SUPPLIER:
  • Their document number format — DO/invoice no. prefix, length, letter/digit pattern.
  • Their date format and where the doc date sits.
  • How they print MATERIAL / item codes vs descriptions (prefix families, leading zeros, packaging-unit suffixes).
  • Unit-of-measure conventions (rolls / metres / kg / pcs / sets) and how qty is shown.
  • Unit-price vs line-amount column layout; whether tax (SST/GST) is per-line or a footer; rounding habits.
  • Letterhead / header layout cues that identify them.
  • Quirks that conflict with the universal rules — call those out explicitly.

DO NOT restate universal rules that apply to all suppliers.
DO NOT enumerate every line item from the examples.
DO NOT write a generic OCR primer.
DO write 100-300 words of plain prose, focused on what is DIFFERENT about this supplier.
DO use bullet points or short paragraphs. No markdown headers, no fences, no preamble, no closing.

You are ALSO given CORRECTION PAIRS: what the OCR model actually read, and what the operator changed it to, on this party's past documents. These are the model's real mistakes. Prioritise rules that prevent each recurring pair — a pair seen several times outweighs any pattern you infer from the clean examples. State the cue that distinguishes the right reading; do not just list the pairs back.

Output ONLY the rule text. The very first character of your response must be a letter or a bullet marker (•, -, *). Anything else will be stored verbatim into the prompt and corrupt downstream extractions.`;

type PartySpec = {
  partyType: LearnPartyType;
  kind: "po" | "supplier";
  noun: "customer" | "supplier";
  Noun: "Customer" | "Supplier";
  partyTable: "customers" | "suppliers";
  metaPrompt: string;
  /** Operator-confirmed samples for one party name, newest first, tenant-scoped. */
  sampleSql: string;
  docLabel: string;
  diff: (raw: unknown, corrected: unknown) => { changed: boolean };
  schema: string[];
};

// Sample selection — two ways to match the party:
//   1. hint == party.name (case-insensitive exact), OR
//   2. NORMALIZED prefix — the OCR saves the document's full legal name as the
//      hint ("Houzs Century Sdn Bhd") but the party record is the short name
//      ("Houzs Century"). BUG-2026-06-07: the old exact-only match wasted ~92%
//      of gold samples.
const nameMatch = (col: string) => `(
                 UPPER(${col}) = UPPER(?)
              OR regexp_replace(UPPER(COALESCE(${col}, '')), '[^A-Z0-9]', '', 'g')
                   LIKE regexp_replace(UPPER(?), '[^A-Z0-9]', '', 'g') || '%'
           )`;

const SPECS: Record<LearnPartyType, PartySpec> = {
  CUSTOMER: {
    partyType: "CUSTOMER",
    kind: "po",
    noun: "customer",
    Noun: "Customer",
    partyTable: "customers",
    metaPrompt: DISTILL_META_PROMPT,
    sampleSql: `SELECT id, correctedJson, rawExtracted AS "rawJson", poIdentifier AS "docIdentifier", createdAt
         FROM po_scan_samples
         WHERE correctedJson IS NOT NULL
           AND org_id = ?
           AND ${nameMatch("customerHint")}
         ORDER BY isGold DESC, createdAt DESC
         LIMIT 50`,
    docLabel: "PO",
    diff: diffSalesOrderSample,
    schema: [
      "ALTER TABLE customers ADD COLUMN IF NOT EXISTS ocrPromptRules TEXT",
      "ALTER TABLE po_scan_samples ADD COLUMN IF NOT EXISTS isGold INTEGER NOT NULL DEFAULT 0",
    ],
  },
  SUPPLIER: {
    partyType: "SUPPLIER",
    kind: "supplier",
    noun: "supplier",
    Noun: "Supplier",
    partyTable: "suppliers",
    metaPrompt: SUPPLIER_DISTILL_META_PROMPT,
    // rawJson / docIdentifier have no rename-map entry, so Postgres stores them
    // lower-cased; un-aliased they come back as `rawjson` / `docidentifier`.
    sampleSql: `SELECT id, correctedJson, rawJson AS "rawJson", docIdentifier AS "docIdentifier", createdAt
         FROM supplier_scan_samples
         WHERE correctedJson IS NOT NULL
           AND orgId = ?
           AND ${nameMatch("supplierHint")}
         ORDER BY isGold DESC, createdAt DESC
         LIMIT 50`,
    docLabel: "Doc",
    diff: diffSupplierSample,
    schema: [
      "ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS ocrPromptRules TEXT",
      `CREATE TABLE IF NOT EXISTS supplier_scan_samples (
         id TEXT PRIMARY KEY,
         orgId TEXT,
         supplierId TEXT,
         supplierHint TEXT,
         docIdentifier TEXT,
         docType TEXT,
         correctedJson TEXT,
         rawJson TEXT,
         isGold INTEGER NOT NULL DEFAULT 0,
         createdBy TEXT,
         createdAt TEXT
       )`,
    ],
  },
};

// Self-applying schema, memoised per party type; a FAILED round is forgotten so
// the next request retries (one transient blip must not stick for the isolate).
const schemaMemo: Partial<Record<LearnPartyType, Promise<void>>> = {};
function ensureSchema(db: DistillDb, spec: PartySpec): Promise<void> {
  return (schemaMemo[spec.partyType] ??= (async () => {
    await runSelfApply(db, "ocr-distill", spec.schema);
    await ensureOcrLearningSchema(db as unknown as LearnDb);
  })().catch((err) => {
    delete schemaMemo[spec.partyType];
    throw err;
  }));
}

const parse = (json: string | null): unknown => {
  try {
    return json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
};

type SampleRow = {
  id: string;
  correctedJson: string | null;
  rawJson: string | null;
  docIdentifier: string | null;
  createdAt: string | null;
};
// Dual-keyed: the adapter re-camelCases any result key containing an underscore.
type PairRow = {
  field: string;
  raw_value?: string | null;
  rawValue?: string | null;
  final_value?: string | null;
  finalValue?: string | null;
  context: string | null;
  n: number;
};

/**
 * Distill one party's OCR rule block and store it (replacing the old value).
 *
 * Does NOT enforce RBAC — the caller is responsible for auth.
 *
 * Cheap-skip contract: a party with fewer than 2 confirmed samples is skipped
 * WITHOUT an Anthropic call, so the sweep can safely iterate every party.
 */
export async function distillPartyRules(
  db: D1Database,
  env: DistillEnv,
  orgId: string,
  partyType: LearnPartyType,
  partyId: string,
): Promise<DistillResult> {
  const spec = SPECS[partyType];
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      status: "error",
      reason:
        "ANTHROPIC_API_KEY not configured. Run `npx wrangler secret put ANTHROPIC_API_KEY` to enable rule distillation.",
    };
  }

  const dbLike = db as unknown as DistillDb;
  await ensureSchema(dbLike, spec);

  const party = await dbLike
    .prepare(`SELECT id, code, name FROM ${spec.partyTable} WHERE id = ? AND orgId = ?`)
    .bind(partyId, orgId)
    .first<{ id: string; code: string; name: string }>();
  if (!party) return { status: "error", reason: `${spec.Noun} not found.` };

  const samplesRes = await dbLike.prepare(spec.sampleSql).bind(orgId, party.name, party.name).all<SampleRow>();
  const rows = (samplesRes.results ?? []).filter((r) => r.correctedJson);

  // Floor at 2 — one example isn't a pattern, and this skip burns no API call.
  if (rows.length < 2) {
    return {
      status: "skipped",
      reason: `Need at least 2 confirmed samples to distill rules; this ${spec.noun} has ${rows.length}.`,
      sampleCount: rows.length,
    };
  }

  // R9 — the mistakes themselves, most frequent first.
  const pairsRes = await dbLike
    .prepare(
      `SELECT field, raw_value, final_value, context, COUNT(*) AS n
         FROM ocr_corrections
        WHERE tenant_id = ? AND kind = ? AND party_id = ?
        GROUP BY field, raw_value, final_value, context
        ORDER BY n DESC
        LIMIT 60`,
    )
    .bind(orgId, spec.kind, partyId)
    .all<PairRow>();
  const pairs = pairsRes.results ?? [];
  const pairsText = pairs.length
    ? `CORRECTION PAIRS (field | model read | operator corrected to | line text | times seen):\n` +
      pairs
        .map((p) => `${p.field} | ${(p.raw_value ?? p.rawValue) || "(blank)"} | ${(p.final_value ?? p.finalValue) || "(blank)"} | ${p.context ?? "—"} | ${p.n}`)
        .join("\n") +
      "\n\n"
    : "";

  // Keep the examples as raw JSON so Claude sees the structured fields
  // (productCode, fabricCode, rawSpec, ...) — that's where the patterns live.
  const examplesText = rows
    .map((r, i) => `Example ${i + 1} (${spec.docLabel}: ${r.docIdentifier ?? "—"}):\n${r.correctedJson}`)
    .join("\n\n");

  const userPayload =
    `${spec.Noun}: ${party.name} (code: ${party.code})\n\n` +
    pairsText +
    `Here are ${rows.length} confirmed correct extractions for this ${spec.noun}. Look at the patterns in their document format and write the ${spec.noun}-specific rule block:\n\n` +
    examplesText;

  const ai = await callAnthropic(
    apiKey,
    {
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      // Determinism: same pool → same distilled rules.
      temperature: 0,
      system: spec.metaPrompt,
      messages: [{ role: "user", content: [{ type: "text", text: userPayload }] }],
    },
    { timeoutMs: DISTILL_TIMEOUT_MS },
  );
  if (!ai.ok) return { status: "error", reason: ai.error };

  // The output is plain prose, not JSON — but Claude sometimes wraps it in
  // fences anyway. Strip them (do NOT slice to first/last brace).
  let distilledText = ai.text.trim();
  const fenced = distilledText.match(/^```(?:\w+)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenced) distilledText = fenced[1].trim();
  if (!distilledText) return { status: "error", reason: "Claude returned empty rules." };
  // Same 32k ceiling as the PUT endpoint so the cached prefix can't blow up.
  if (distilledText.length > 32_000) distilledText = distilledText.slice(0, 32_000);

  const result = await dbLike
    .prepare(`UPDATE ${spec.partyTable} SET ocrPromptRules = ? WHERE id = ? AND orgId = ?`)
    .bind(distilledText, partyId, orgId)
    .run();
  if (!result.success || result.meta.changes === 0) {
    return { status: "error", reason: `${spec.Noun} update failed after distillation.` };
  }

  // R12 — version the rules. The scans confirmed since the last version ran
  // UNDER that version: their success rate is its "after" and this one's "before".
  let version = 1;
  let successRateBefore: number | null = null;
  try {
    const last = await dbLike
      .prepare(
        `SELECT id, version, created_at FROM ocr_rule_versions
          WHERE tenant_id = ? AND party_type = ? AND party_id = ?
          ORDER BY version DESC LIMIT 1`,
      )
      .bind(orgId, partyType, partyId)
      .first<{ id: string; version: number; created_at?: string; createdAt?: string }>();
    const since = last?.created_at ?? last?.createdAt ?? "";
    const under = rows.filter((r) => String(r.createdAt ?? "") > since);
    const success = under.filter((r) => !spec.diff(parse(r.rawJson), parse(r.correctedJson)).changed).length;
    successRateBefore = rateOf({ total: under.length, success });
    if (last) {
      version = Number(last.version) + 1;
      await dbLike
        .prepare("UPDATE ocr_rule_versions SET success_rate_after = ?, scans_after = ? WHERE id = ?")
        .bind(successRateBefore, under.length, last.id)
        .run();
    }
    await dbLike
      .prepare(
        `INSERT INTO ocr_rule_versions
           (id, tenant_id, party_type, party_id, version, rules, sample_count, pair_count,
            success_rate_before, scans_before, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(`orv-${crypto.randomUUID().slice(0, 12)}`, orgId, partyType, partyId, version, distilledText,
        rows.length, pairs.length, successRateBefore, under.length, new Date().toISOString())
      .run();
  } catch (e) {
    // The rules are already saved; a versioning failure must not undo that.
    console.warn("[distill] version row failed:", (e as Error).message);
  }

  return {
    status: "distilled",
    rulesGenerated: distilledText,
    sampleCount: rows.length,
    pairCount: pairs.length,
    version,
    successRateBefore,
    tokensIn: ai.usage.tokensIn,
    tokensOut: ai.usage.tokensOut,
  };
}

export const distillCustomerRules = (db: D1Database, env: DistillEnv, orgId: string, customerId: string) =>
  distillPartyRules(db, env, orgId, "CUSTOMER", customerId);
export const distillSupplierRules = (db: D1Database, env: DistillEnv, orgId: string, supplierId: string) =>
  distillPartyRules(db, env, orgId, "SUPPLIER", supplierId);

export type SweepResult = {
  distilled: number;
  skipped: number;
  errored: number;
  total: number;
  /** Parties not reached before the deadline — the next run picks them up. */
  remaining: number;
};

async function sweep(
  db: D1Database,
  env: DistillEnv,
  parties: { partyType: LearnPartyType; id: string; orgId: string }[],
  deadline: number,
): Promise<SweepResult> {
  const out: SweepResult = { distilled: 0, skipped: 0, errored: 0, total: parties.length, remaining: 0 };
  for (let i = 0; i < parties.length; i++) {
    // The old loop was unbounded against a 280s request limit: one slow party
    // and the platform killed the run mid-write. Stop while there is still time.
    if (Date.now() > deadline) {
      out.remaining = parties.length - i;
      break;
    }
    const p = parties[i];
    try {
      const res = await distillPartyRules(db, env, p.orgId, p.partyType, p.id);
      if (res.status === "distilled") out.distilled += 1;
      else if (res.status === "skipped") out.skipped += 1;
      else {
        out.errored += 1;
        console.warn(`[distill-ocr-rules] ${p.partyType} ${p.id} (org=${p.orgId}) error: ${res.reason ?? "unknown"}`);
      }
    } catch (err) {
      // One party's failure must not abort the whole sweep.
      out.errored += 1;
      console.warn(`[distill-ocr-rules] ${p.partyType} ${p.id} (org=${p.orgId}) threw:`,
        err instanceof Error ? err.message : String(err));
    }
  }
  return out;
}

const DEFAULT_BUDGET_MS = 200_000;
const capLimit = (limit: number) => Math.max(1, Math.min(limit, 1000));

/** Weekly sweep over every active customer, bounded by `deadline` (epoch ms). */
export async function distillAllCustomerRules(
  db: D1Database, env: DistillEnv, limit = 200, deadline = Date.now() + DEFAULT_BUDGET_MS,
): Promise<SweepResult> {
  const res = await db
    .prepare("SELECT id, orgId FROM customers WHERE isActive = 1 ORDER BY code LIMIT ?")
    .bind(capLimit(limit))
    .all<{ id: string; orgId: string }>();
  return sweep(db, env, (res.results ?? []).map((r) => ({ ...r, partyType: "CUSTOMER" as const })), deadline);
}

/** Weekly sweep over every supplier, bounded by `deadline` (epoch ms). */
export async function distillAllSupplierRules(
  db: D1Database, env: DistillEnv, limit = 200, deadline = Date.now() + DEFAULT_BUDGET_MS,
): Promise<SweepResult> {
  const res = await db
    .prepare("SELECT id, orgId FROM suppliers ORDER BY code LIMIT ?")
    .bind(capLimit(limit))
    .all<{ id: string; orgId: string }>();
  return sweep(db, env, (res.results ?? []).map((r) => ({ ...r, partyType: "SUPPLIER" as const })), deadline);
}

/**
 * Drain ocr_distill_queue — the parties whose scans were CORRECTED since their
 * last distillation. One party per job, oldest first, until the queue is empty
 * or the deadline passes. Runs before the blanket sweep: these are the parties
 * where new rules will actually change the next scan.
 */
export async function drainDistillQueue(
  db: D1Database, env: DistillEnv, deadline = Date.now() + DEFAULT_BUDGET_MS,
): Promise<{ processed: number; distilled: number }> {
  let processed = 0;
  let distilled = 0;
  while (Date.now() < deadline) {
    const job = await popDistillJob(db as unknown as LearnDb);
    if (!job) break;
    processed += 1;
    try {
      const res = await distillPartyRules(db, env, job.tenantId, job.partyType, job.partyId);
      if (res.status === "distilled") distilled += 1;
    } catch (e) {
      console.warn(`[distill-queue] ${job.partyType} ${job.partyId} threw:`, (e as Error).message);
    }
  }
  return { processed, distilled };
}
