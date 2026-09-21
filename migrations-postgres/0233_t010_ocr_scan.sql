-- ============================================================================
-- 0233 — PRD T-010: document scanning (OCR) — faster, self-learning, originals kept.
--
-- ⚠ THIS FILE IS INERT ON DEPLOY (see CLAUDE.md). Every statement below is ALSO
-- self-applied at runtime, awaited before the first read/write that needs it:
--   • src/api/routes/scan-queue.ts   ensureScanQueueTable   — scan_queue columns + back-fill
--   • src/api/lib/ocr-learning.ts    OCR_LEARNING_DDL       — the four learning tables,
--                                                             po_scan_samples tenant columns + back-fills
--   • src/api/routes/files.ts        ensureRetentionSchema  — file_assets columns + access log
-- This file exists so a clean rebuild from migrations-postgres/ produces the same
-- schema (the 0178 catch-up pattern). All statements are idempotent.
--
-- ⚠ ADAPTER RULE: every *_at column is written by the app as an ISO STRING, so it
-- stays TEXT — never timestamptz — or the SupabaseAdapter will not round-trip it.
-- All identifiers are snake_case, so column-rename-map.json needs no entries.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- R2 / R1 / R3 / R6 — scan_queue: bytes leave the row; the row measures itself.
-- `file_hash` (already present) IS the SHA-256 checksum; `file_size` and
-- `mime_type` already exist. `file_bytes_b64` is kept ONLY so rows written before
-- the move stay readable — a configured deployment never writes it again.
-- scan_queue itself is runtime-created; the guard keeps a fresh rebuild green.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.scan_queue') IS NOT NULL THEN
    ALTER TABLE scan_queue ADD COLUMN IF NOT EXISTS storage_key        TEXT;
    ALTER TABLE scan_queue ADD COLUMN IF NOT EXISTS parent_id          TEXT;
    ALTER TABLE scan_queue ADD COLUMN IF NOT EXISTS party_hint         TEXT;
    ALTER TABLE scan_queue ADD COLUMN IF NOT EXISTS party_id           TEXT;
    ALTER TABLE scan_queue ADD COLUMN IF NOT EXISTS wait_ms            INTEGER;
    ALTER TABLE scan_queue ADD COLUMN IF NOT EXISTS duration_ms        INTEGER;
    ALTER TABLE scan_queue ADD COLUMN IF NOT EXISTS identify_ms        INTEGER;
    ALTER TABLE scan_queue ADD COLUMN IF NOT EXISTS extract_ms         INTEGER;
    ALTER TABLE scan_queue ADD COLUMN IF NOT EXISTS tokens_in          INTEGER;
    ALTER TABLE scan_queue ADD COLUMN IF NOT EXISTS tokens_out         INTEGER;
    ALTER TABLE scan_queue ADD COLUMN IF NOT EXISTS cache_read_tokens  INTEGER;
    ALTER TABLE scan_queue ADD COLUMN IF NOT EXISTS cache_write_tokens INTEGER;
    ALTER TABLE scan_queue ADD COLUMN IF NOT EXISTS ai_attempts        INTEGER;
    ALTER TABLE scan_queue ADD COLUMN IF NOT EXISTS alias_hits         INTEGER;
    ALTER TABLE scan_queue ADD COLUMN IF NOT EXISTS low_confidence     INTEGER;
    -- R13: the `(org_id = ? OR org_id IS NULL)` escape hatch is gone from every
    -- read, so tenant-less rows get their scanner's org (else the founding org).
    UPDATE scan_queue q
       SET org_id = COALESCE((SELECT u.org_id FROM users u WHERE u.id = q.created_by), 'hookka')
     WHERE q.org_id IS NULL OR q.org_id = '';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- R7 — field-level correction log. One row per field the operator changed,
-- written on every confirm from ocr-accuracy-core's own comparison.
-- `line_no` / `context` extend the PRD's column list: without them a pair cannot
-- say WHICH line it came from, which is what the distiller needs (R9).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ocr_corrections (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,            -- 'po' | 'supplier'
  sample_id    TEXT NOT NULL,            -- po_scan_samples.id | supplier_scan_samples.id
  party_id     TEXT,                     -- customers.id | suppliers.id; NULL = unidentified / finance
  field        TEXT NOT NULL,            -- JSON key: productCode, fabricCode, qty, docNo, …
  line_no      INTEGER,                  -- 0-based; NULL for a header field
  raw_value    TEXT,                     -- what the model read
  final_value  TEXT,                     -- what the operator imported
  context      TEXT,                     -- the line's own text (rawSpec / description)
  corrected_by TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ocr_corrections_party_idx  ON ocr_corrections (tenant_id, kind, party_id, created_at);
CREATE INDEX IF NOT EXISTS ocr_corrections_sample_idx ON ocr_corrections (sample_id);

-- ---------------------------------------------------------------------------
-- R8 — deterministic code aliases (the party_name_aliases pattern, for codes).
-- One answer per (tenant, kind, party, field, normalised raw value); re-teaching
-- overwrites. party_id '' = tenant-wide; a party's own row shadows it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ocr_code_aliases (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  party_id     TEXT NOT NULL DEFAULT '',
  field        TEXT NOT NULL,            -- productCode | fabricCode | supplierCode
  alias_norm   TEXT NOT NULL,            -- normaliseCode(raw): A-Z0-9 only, upper
  alias_raw    TEXT NOT NULL,
  code         TEXT NOT NULL,            -- OUR code
  hits         INTEGER NOT NULL DEFAULT 1,
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ocr_code_aliases_key_idx
  ON ocr_code_aliases (tenant_id, kind, party_id, field, alias_norm);

-- ---------------------------------------------------------------------------
-- R12 — every distillation is a numbered version. `success_rate_before` is the
-- rate of the scans confirmed under the PREVIOUS rules; the next distillation
-- writes the same figure into this row's `success_rate_after`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ocr_rule_versions (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  party_type          TEXT NOT NULL,     -- 'CUSTOMER' | 'SUPPLIER'
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
);
CREATE UNIQUE INDEX IF NOT EXISTS ocr_rule_versions_key_idx
  ON ocr_rule_versions (tenant_id, party_type, party_id, version);

-- ---------------------------------------------------------------------------
-- R5 — one party per distillation job. The PK de-duplicates: ten corrections on
-- one customer are one job.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ocr_distill_queue (
  tenant_id    TEXT NOT NULL,
  party_type   TEXT NOT NULL,
  party_id     TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, party_type, party_id)
);

-- ---------------------------------------------------------------------------
-- R13 — scan samples carry the tenant. po_scan_samples had NO tenant column at
-- all (0026); supplier_scan_samples had one but tolerated NULL.
-- ---------------------------------------------------------------------------
ALTER TABLE po_scan_samples ADD COLUMN IF NOT EXISTS org_id   TEXT;
ALTER TABLE po_scan_samples ADD COLUMN IF NOT EXISTS party_id TEXT;
CREATE INDEX IF NOT EXISTS po_scan_samples_org_idx ON po_scan_samples (org_id, created_at);

UPDATE po_scan_samples s
   SET org_id = COALESCE((SELECT u.org_id FROM users u WHERE u.id = s.created_by), 'hookka')
 WHERE s.org_id IS NULL;

UPDATE supplier_scan_samples s
   SET org_id = COALESCE((SELECT u.org_id FROM users u WHERE u.id = s.created_by), 'hookka')
 WHERE s.org_id IS NULL;

-- ---------------------------------------------------------------------------
-- R14 — originals are records. Delete becomes archive; a locked file (or the
-- original of a posted document — enforced in files.ts POSTED_DOC_CHECKS)
-- refuses even that.
-- ---------------------------------------------------------------------------
ALTER TABLE file_assets ADD COLUMN IF NOT EXISTS checksum    TEXT;                            -- SHA-256 hex
ALTER TABLE file_assets ADD COLUMN IF NOT EXISTS source      TEXT;                            -- scan-po | scan-supplier | scan-finance | assistant | upload
ALTER TABLE file_assets ADD COLUMN IF NOT EXISTS locked      BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE file_assets ADD COLUMN IF NOT EXISTS archived    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE file_assets ADD COLUMN IF NOT EXISTS archived_at TEXT;
ALTER TABLE file_assets ADD COLUMN IF NOT EXISTS archived_by TEXT;

-- ---------------------------------------------------------------------------
-- R16 — one row per view / download / stream of any stored file.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ocr_file_access_log (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  user_id     TEXT,
  file_id     TEXT NOT NULL,
  action      TEXT NOT NULL,             -- view | download | stream
  ip_address  TEXT,
  accessed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ocr_file_access_log_file_idx ON ocr_file_access_log (file_id, accessed_at);
