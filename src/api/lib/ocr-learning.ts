// ---------------------------------------------------------------------------
// ocr-learning.ts — the closed loop (PRD T-010 R7 / R8 / R12 / R13).
//
//   confirm ──► ocr_corrections   (what the model read → what the person typed)
//          ├──► ocr_code_aliases  (deterministic: next scan is fixed with NO model)
//          └──► ocr_distill_queue (one party per job; pairs feed the distiller)
//
// party-alias.ts is the precedent and this file copies its shape on purpose:
// runtime-created tables (migrations are inert on deploy), one answer per key,
// most recent human decision wins, never throws into the caller's save path.
//
// What becomes an alias is decided by the EXISTING classifier in
// ocr-code-misses.ts, which until now only reported:
//   unknown_raw     → alias.   The customer's own part number; one correction
//                              fixes it forever.
//   normalisable    → nothing. Same code, different punctuation — the lookup
//                              below already matches on the normalised form.
//   real_but_wrong  → NEVER.   The raw value is a valid code of ours; aliasing it
//                              would rewrite every genuine use of that code.
//   blank_raw       → nothing. There is no key to look up.
// ---------------------------------------------------------------------------
import { memoizeSelfApply, runSelfApply } from "./self-apply";
import { correctionPairs, type CorrectionPair } from "./ocr-accuracy-core";
import { classifyCodeMiss, normaliseCode } from "./ocr-code-misses";
import { DEFAULT_ORG_ID } from "./tenant";

export type ScanKind = "po" | "supplier";
export type LearnPartyType = "CUSTOMER" | "SUPPLIER";

type Stmt = {
  run: () => Promise<unknown>;
  first: <T = unknown>() => Promise<T | null>;
  all: <T = unknown>() => Promise<{ results?: T[] }>;
};
export type LearnDb = {
  prepare: (sql: string) => { bind: (...args: unknown[]) => Stmt } & Partial<Stmt>;
};

/** Code-bearing fields per kind → the catalogue they must be checked against. */
const CODE_FIELDS: Record<ScanKind, Record<string, "products" | "materials">> = {
  po: { productCode: "products", fabricCode: "materials" },
  supplier: { supplierCode: "materials" },
};

// Back-fill: a sample with no tenant belongs to whoever scanned it, else to the
// founding org — the same default migration 0049 used for every other table.
const backfill = (table: string, col: string, by: string) =>
  `UPDATE ${table} s SET ${col} = COALESCE(
     (SELECT u.org_id FROM users u WHERE u.id = s.${by}), '${DEFAULT_ORG_ID}')
   WHERE s.${col} IS NULL`;

export const OCR_LEARNING_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS ocr_corrections (
     id           TEXT PRIMARY KEY,
     tenant_id    TEXT NOT NULL,
     kind         TEXT NOT NULL,
     sample_id    TEXT NOT NULL,
     party_id     TEXT,
     field        TEXT NOT NULL,
     line_no      INTEGER,
     raw_value    TEXT,
     final_value  TEXT,
     context      TEXT,
     corrected_by TEXT,
     created_at   TEXT NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS ocr_corrections_party_idx ON ocr_corrections (tenant_id, kind, party_id, created_at)",
  "CREATE INDEX IF NOT EXISTS ocr_corrections_sample_idx ON ocr_corrections (sample_id)",
  `CREATE TABLE IF NOT EXISTS ocr_code_aliases (
     id           TEXT PRIMARY KEY,
     tenant_id    TEXT NOT NULL,
     kind         TEXT NOT NULL,
     party_id     TEXT NOT NULL DEFAULT '',
     field        TEXT NOT NULL,
     alias_norm   TEXT NOT NULL,
     alias_raw    TEXT NOT NULL,
     code         TEXT NOT NULL,
     hits         INTEGER NOT NULL DEFAULT 1,
     created_by   TEXT,
     created_at   TEXT NOT NULL,
     last_used_at TEXT
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ocr_code_aliases_key_idx
     ON ocr_code_aliases (tenant_id, kind, party_id, field, alias_norm)`,
  `CREATE TABLE IF NOT EXISTS ocr_rule_versions (
     id                  TEXT PRIMARY KEY,
     tenant_id           TEXT NOT NULL,
     party_type          TEXT NOT NULL,
     party_id            TEXT NOT NULL,
     version             INTEGER NOT NULL,
     rules               TEXT NOT NULL,
     sample_count        INTEGER NOT NULL DEFAULT 0,
     pair_count          INTEGER NOT NULL DEFAULT 0,
     success_rate_before REAL,
     success_rate_after  REAL,
     scans_before        INTEGER,
     scans_after         INTEGER,
     created_at          TEXT NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ocr_rule_versions_key_idx
     ON ocr_rule_versions (tenant_id, party_type, party_id, version)`,
  `CREATE TABLE IF NOT EXISTS ocr_distill_queue (
     tenant_id    TEXT NOT NULL,
     party_type   TEXT NOT NULL,
     party_id     TEXT NOT NULL,
     requested_at TEXT NOT NULL,
     PRIMARY KEY (tenant_id, party_type, party_id)
   )`,
  // R13 — samples carry the tenant. supplier_scan_samples already has the
  // column but tolerated NULL; po_scan_samples never had one.
  "ALTER TABLE po_scan_samples ADD COLUMN IF NOT EXISTS org_id TEXT",
  "ALTER TABLE po_scan_samples ADD COLUMN IF NOT EXISTS party_id TEXT",
  "CREATE INDEX IF NOT EXISTS po_scan_samples_org_idx ON po_scan_samples (org_id, created_at)",
  backfill("po_scan_samples", "org_id", "created_by"),
  // supplier_scan_samples is created lazily by ocr-distill; on a database that
  // has never distilled, this is a benign "does not exist".
  backfill("supplier_scan_samples", "org_id", "created_by"),
];

let learningSchemaMemo: Promise<void> | null = null;
export const ensureOcrLearningSchema = (db: LearnDb): Promise<void> =>
  memoizeSelfApply(
    () => learningSchemaMemo,
    (p) => { learningSchemaMemo = p; },
    () => runSelfApply(db, "ocr-learning", OCR_LEARNING_DDL),
  );

const newId = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12)}`;

// ---- aliases ---------------------------------------------------------------

/** `field|aliasNorm` → code. Party-specific rows shadow tenant-wide ones. */
export type CodeAliasMap = Map<string, string>;
const aliasMapKey = (field: string, aliasNorm: string) => `${field}|${aliasNorm}`;

export async function loadCodeAliasMap(
  db: LearnDb,
  tenantId: string,
  kind: ScanKind,
  partyId: string | null,
): Promise<CodeAliasMap> {
  const map: CodeAliasMap = new Map();
  try {
    await ensureOcrLearningSchema(db);
    const res = await db
      .prepare(
        `SELECT field, alias_norm, code, party_id
           FROM ocr_code_aliases
          WHERE tenant_id = ? AND kind = ? AND party_id IN ('', ?)
          ORDER BY party_id ASC`, // '' first, so the party's own row overwrites it
      )
      .bind(tenantId, kind, partyId ?? "")
      .all<Record<string, string>>();
    for (const r of res.results ?? []) {
      const norm = r.alias_norm ?? r.aliasNorm;
      if (r.field && norm && r.code) map.set(aliasMapKey(r.field, norm), r.code);
    }
  } catch (e) {
    // Never block a scan on the alias table — the model's answer still stands.
    console.warn("[ocr-learning] alias load failed:", (e as Error).message);
  }
  return map;
}

export type AliasHit = { field: string; lineNo: number; from: string; to: string };

/**
 * Rewrite code fields in a raw extraction through the alias map, IN PLACE.
 * Pure apart from the mutation. The model's own reading is kept beside the
 * rewritten value as `<field>Ocr`, so the screen can show "learned" and the
 * distiller still sees what the model actually produced.
 */
export function applyCodeAliases(kind: ScanKind, data: unknown, map: CodeAliasMap): AliasHit[] {
  const hits: AliasHit[] = [];
  if (map.size === 0 || !data || typeof data !== "object") return hits;
  const env = data as { pos?: unknown; docs?: unknown };
  const parents = (kind === "po" ? env.pos : env.docs) ?? [];
  const lineKey = kind === "po" ? "items" : "lines";
  for (const parent of Array.isArray(parents) ? parents : []) {
    const lines = (parent as Record<string, unknown> | null)?.[lineKey];
    if (!Array.isArray(lines)) continue;
    lines.forEach((line: Record<string, unknown> | null, lineNo: number) => {
      if (!line || typeof line !== "object") return;
      for (const field of Object.keys(CODE_FIELDS[kind])) {
        const from = String(line[field] ?? "").trim();
        const to = map.get(aliasMapKey(field, normaliseCode(from)));
        if (!from || !to || normaliseCode(to) === normaliseCode(from)) continue;
        line[`${field}Ocr`] = from;
        line[field] = to;
        hits.push({ field, lineNo, from, to });
      }
    });
  }
  return hits;
}

async function loadKnownCodes(db: LearnDb, table: string, tenantId: string): Promise<Set<string>> {
  const known = new Set<string>();
  // Fabrics ARE raw materials here (scan-engine loadCatalog reads them from the
  // same table), so both code families check against raw_materials.itemCode.
  const isProduct = table === "products";
  try {
    const res = await (isProduct
      ? db.prepare("SELECT code FROM products WHERE orgId = ?").bind(tenantId)
      : db.prepare("SELECT itemCode AS code FROM raw_materials WHERE itemCode IS NOT NULL").bind()
    ).all<{ code?: string | null }>();
    for (const r of res.results ?? []) {
      const n = normaliseCode(r.code);
      if (n) known.add(n);
    }
  } catch (e) {
    console.warn(`[ocr-learning] known-codes(${table}) failed:`, (e as Error).message);
  }
  return known;
}

// ---- confirm hook ----------------------------------------------------------

export type RecordCorrectionsResult = { corrections: number; aliases: number; queued: boolean };

/**
 * Called by every confirm endpoint AFTER `correctedJson` is saved. Best-effort:
 * an import must never fail because the learning tables are unhappy.
 */
export async function recordCorrections(
  db: LearnDb,
  opts: {
    tenantId: string;
    kind: ScanKind;
    sampleId: string;
    partyId: string | null;
    raw: unknown;
    corrected: unknown;
    correctedBy: string | null;
  },
): Promise<RecordCorrectionsResult> {
  const out: RecordCorrectionsResult = { corrections: 0, aliases: 0, queued: false };
  try {
    await ensureOcrLearningSchema(db);
    const pairs: CorrectionPair[] = correctionPairs(opts.kind, opts.raw, opts.corrected);
    const now = new Date().toISOString();

    // Re-confirming a sample replaces its rows — the log holds the FINAL answer
    // per sample, not one row per click of Save.
    await db.prepare("DELETE FROM ocr_corrections WHERE sample_id = ? AND tenant_id = ?")
      .bind(opts.sampleId, opts.tenantId).run();

    const knownCache = new Map<string, Set<string>>();
    for (const p of pairs) {
      await db
        .prepare(
          `INSERT INTO ocr_corrections
             (id, tenant_id, kind, sample_id, party_id, field, line_no, raw_value, final_value, context, corrected_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(newId("occ"), opts.tenantId, opts.kind, opts.sampleId, opts.partyId, p.field,
          p.lineNo, p.rawValue.slice(0, 500), p.finalValue.slice(0, 500),
          p.context?.slice(0, 500) ?? null, opts.correctedBy, now)
        .run();
      out.corrections += 1;

      const table = CODE_FIELDS[opts.kind][p.field];
      if (!table || !p.finalValue) continue;
      // The model's own reading, not an alias we already applied on the way out.
      if (!knownCache.has(table)) knownCache.set(table, await loadKnownCodes(db, table, opts.tenantId));
      if (classifyCodeMiss(p.rawValue, p.finalValue, knownCache.get(table)!) !== "unknown_raw") continue;
      await db
        .prepare(
          `INSERT INTO ocr_code_aliases
             (id, tenant_id, kind, party_id, field, alias_norm, alias_raw, code, hits, created_by, created_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
           ON CONFLICT (tenant_id, kind, party_id, field, alias_norm) DO UPDATE SET
             code = EXCLUDED.code, alias_raw = EXCLUDED.alias_raw,
             hits = ocr_code_aliases.hits + 1, last_used_at = EXCLUDED.last_used_at`,
        )
        .bind(newId("oca"), opts.tenantId, opts.kind, opts.partyId ?? "", p.field,
          normaliseCode(p.rawValue), p.rawValue, p.finalValue, opts.correctedBy, now, now)
        .run();
      out.aliases += 1;
    }

    if (pairs.length > 0 && opts.partyId) {
      await enqueueDistill(db, opts.tenantId, opts.kind === "po" ? "CUSTOMER" : "SUPPLIER", opts.partyId);
      out.queued = true;
    }
  } catch (e) {
    console.warn("[ocr-learning] recordCorrections failed:", (e as Error).message);
  }
  return out;
}

/**
 * Save a supplier-shaped sample's corrected result and run the learning hook.
 * Shared by /api/scan-supplier and /api/scan-finance so the two confirm paths
 * cannot drift. Tenant-scoped: another tenant's sample id is simply not found.
 */
export async function confirmSupplierSample(
  db: unknown,
  opts: { tenantId: string; sampleId: string; correctedJson: string; gold: boolean; correctedBy: string | null },
): Promise<{ found: boolean; learned: RecordCorrectionsResult }> {
  const d = db as LearnDb;
  const learned: RecordCorrectionsResult = { corrections: 0, aliases: 0, queued: false };
  const row = await d
    // rawJson is a lower-cased physical column — alias it or it reads back as `rawjson`.
    .prepare(`SELECT rawJson AS "rawJson", supplierId FROM supplier_scan_samples WHERE id = ? AND orgId = ?`)
    .bind(opts.sampleId, opts.tenantId)
    .first<{ rawJson: string | null; supplierId: string | null }>();
  if (!row) return { found: false, learned };
  await d
    .prepare("UPDATE supplier_scan_samples SET correctedJson = ?, isGold = ? WHERE id = ? AND orgId = ?")
    .bind(opts.correctedJson, opts.gold ? 1 : 0, opts.sampleId, opts.tenantId)
    .run();
  const parse = (j: string | null): unknown => {
    try {
      return j ? JSON.parse(j) : null;
    } catch {
      return null;
    }
  };
  return {
    found: true,
    learned: await recordCorrections(d, {
      tenantId: opts.tenantId,
      kind: "supplier",
      sampleId: opts.sampleId,
      partyId: row.supplierId,
      raw: parse(row.rawJson),
      corrected: parse(opts.correctedJson),
      correctedBy: opts.correctedBy,
    }),
  };
}

// ---- distill queue (R5: one entity per job) --------------------------------

export async function enqueueDistill(
  db: LearnDb, tenantId: string, partyType: LearnPartyType, partyId: string,
): Promise<void> {
  await ensureOcrLearningSchema(db);
  await db
    .prepare(
      `INSERT INTO ocr_distill_queue (tenant_id, party_type, party_id, requested_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (tenant_id, party_type, party_id) DO NOTHING`,
    )
    .bind(tenantId, partyType, partyId, new Date().toISOString())
    .run();
}

/** Atomically take the oldest job. Two crons racing get two different parties. */
export async function popDistillJob(
  db: LearnDb,
): Promise<{ tenantId: string; partyType: LearnPartyType; partyId: string } | null> {
  await ensureOcrLearningSchema(db);
  const row = await db
    .prepare(
      `DELETE FROM ocr_distill_queue
        WHERE (tenant_id, party_type, party_id) IN (
          SELECT tenant_id, party_type, party_id FROM ocr_distill_queue
           ORDER BY requested_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING tenant_id, party_type, party_id`,
    )
    .bind()
    .first<Record<string, string>>();
  if (!row) return null;
  return {
    tenantId: row.tenant_id ?? row.tenantId,
    partyType: (row.party_type ?? row.partyType) as LearnPartyType,
    partyId: row.party_id ?? row.partyId,
  };
}
