// ---------------------------------------------------------------------------
// Phase B.4 — File assets API.
//
// Storage backend: Supabase Storage (was Cloudflare R2 before the
// storage-supabase-migration refactor). The wrapper module retains the
// historic R2-flavoured names — putFile / getFile / signedDownloadUrl /
// deleteFile — so route logic didn't change shape, only the import path.
//
// Routes:
//   POST   /api/files                  — multipart upload; stores to Supabase
//                                        Storage + records the row in file_assets.
//   GET    /api/files                  — list (filter by resourceType,
//                                        resourceId).
//   GET    /api/files/:id              — fetch metadata.
//   GET    /api/files/:id/download     — 302 to a short-lived presigned
//                                        URL (or the /stream proxy if signing
//                                        fails). `?inline=1` opens it in the
//                                        browser instead of saving it.
//   GET    /api/files/:id/stream       — proxy stream the body, INLINE for
//                                        images / PDFs / video ("View
//                                        original" points here).
//   DELETE /api/files/:id              — ARCHIVES the row. Nothing is ever
//                                        hard-deleted, and the original of a
//                                        posted document refuses even that.
//
// Originals are records (PRD T-010 R14-R16): every file carries a SHA-256
// `checksum` and a `source`, can be `locked`, is `archived` rather than deleted,
// and every view writes a row to `ocr_file_access_log`.
//
// Behavior when Supabase Storage isn't configured:
//   Every route returns 503 with `{ ok: false, error: "file storage
//   unavailable" }`. Frontend can detect this and hide upload controls.
//
// Persistence note: the DB column is still named `r2Key` / `r2_key`. We
// kept the column name to avoid a data-migrating schema change for what
// is effectively just an opaque object identifier — its semantic meaning
// is "storage object key", and the underlying backend is now Supabase
// Storage. Renaming the column is tracked as a follow-up.
//
// The migrations live at:
//   migrations/0055_file_assets.sql           (D1 source-of-truth schema)
//   migrations-postgres/0055_file_assets.sql  (Supabase mirror)
// Both stay in sync — the SupabaseAdapter adapter routes camelCase queries to
// snake_case columns via column-rename-map.json (see lib/supabase-compat.ts).
// ---------------------------------------------------------------------------
import { Hono, type Context } from "hono";
import type { Env } from "../worker";
import { getOrgId } from "../lib/tenant";
import {
  SupabaseStorageNotConfiguredError,
  putFile,
  getFile,
  signedDownloadUrl,
  deleteFile,
} from "../lib/supabase-storage";
import { requirePermission } from "../lib/rbac";
import { emitAudit } from "../lib/audit";
import { isBenignSelfApplyError, memoizeSelfApply, runSelfApply } from "../lib/self-apply";

const app = new Hono<Env>();

// Upload size guard — 50 MB ceiling. Sized for typical PDF/PNG
// attachments; anything bigger should go through a presigned-PUT direct
// upload (Phase B.4 finish).
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// Allowlist of MIME types we accept. Adding here is a deliberate decision —
// HTML/SVG/JS would let an attacker host script in the same origin if
// they tricked a victim into opening the /stream URL inline. The list
// covers everything the existing UI uploads (POD photos, BOM PDFs,
// service-case attachments).
const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "application/pdf",
  // Video (announcement tutorials / clips). MP4 & MOV share the ISO-BMFF ftyp
  // box; WebM is EBML; both are brand/magic-byte checked in sniffMime below.
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/3gpp",
]);

// Magic-byte signatures for the allowed MIME types. We enforce that the
// declared `file.type` matches what the bytes actually look like so a
// malicious client can't upload an HTML payload labelled as image/png.
function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  // GIF87a / GIF89a: 47 49 46 38 (37|39) 61
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  )
    return "image/gif";
  // WebP: RIFF....WEBP — 52 49 46 46 ?? ?? ?? ?? 57 45 42 50
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  // PDF: %PDF — 25 50 44 46
  if (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  )
    return "application/pdf";
  // WebM (EBML header): 1A 45 DF A3
  if (
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  )
    return "video/webm";
  // ISO Base Media: an "ftyp" box at bytes 4-7 covers BOTH HEIC/HEIF still
  // images AND MP4 / MOV / 3GP video. Disambiguate by the major brand at
  // bytes 8-11 (previously every ftyp file was mislabelled image/heic, which
  // is why video uploads — declared video/mp4 — failed the type match).
  if (
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(
      bytes[8],
      bytes[9],
      bytes[10],
      bytes[11],
    );
    if (/^(heic|heix|hevc|heim|heis|hevm|hevs|mif1|msf1)$/.test(brand))
      return "image/heic";
    if (brand === "qt  ") return "video/quicktime";
    if (brand.startsWith("3gp")) return "video/3gpp";
    // isom / iso2 / mp41 / mp42 / avc1 / M4V / dash / … → MP4 family.
    return "video/mp4";
  }
  return null;
}

// Map of which sniffed MIME values are acceptable substitutes for a
// declared MIME — handles benign mismatches like client declaring
// image/jpg vs sniffer returning image/jpeg.
function mimeMatches(declared: string, sniffed: string): boolean {
  if (declared === sniffed) return true;
  if (declared === "image/jpg" && sniffed === "image/jpeg") return true;
  if (declared === "image/heif" && sniffed === "image/heic") return true;
  // A .mov may be declared video/quicktime but carry a generic MP4 ftyp brand
  // (or the reverse) — accept any pairing within the MP4/MOV family.
  if (
    (declared === "video/quicktime" || declared === "video/mp4") &&
    (sniffed === "video/mp4" || sniffed === "video/quicktime")
  )
    return true;
  if (declared === "video/3gpp" && sniffed === "video/mp4") return true;
  return false;
}

type FileAssetRow = {
  id: string;
  resourceType: string;
  resourceId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  r2Key: string;
  uploadedBy: string | null;
  uploadedAt: string;
  orgId: string;
  checksum?: string | null;
  source?: string | null;
  locked?: boolean | null;
  archived?: boolean | null;
};

// Migration files are inert on deploy (CLAUDE.md) — the columns and the access
// log are created here, awaited before the first read or write that needs them.
let retentionMemo: Promise<void> | null = null;
const ensureRetentionSchema = (db: Env["Variables"]["DB"]): Promise<void> =>
  memoizeSelfApply(
    () => retentionMemo,
    (p) => {
      retentionMemo = p;
    },
    () =>
      runSelfApply(db, "files-retention", [
        "ALTER TABLE file_assets ADD COLUMN IF NOT EXISTS checksum TEXT",
        "ALTER TABLE file_assets ADD COLUMN IF NOT EXISTS source TEXT",
        "ALTER TABLE file_assets ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE file_assets ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE file_assets ADD COLUMN IF NOT EXISTS archived_at TEXT",
        "ALTER TABLE file_assets ADD COLUMN IF NOT EXISTS archived_by TEXT",
        `CREATE TABLE IF NOT EXISTS ocr_file_access_log (
           id          TEXT PRIMARY KEY,
           org_id      TEXT NOT NULL,
           user_id     TEXT,
           file_id     TEXT NOT NULL,
           action      TEXT NOT NULL,
           ip_address  TEXT,
           accessed_at TEXT NOT NULL
         )`,
        "CREATE INDEX IF NOT EXISTS ocr_file_access_log_file_idx ON ocr_file_access_log (file_id, accessed_at)",
      ]),
  );

/**
 * A file that is the original of a POSTED document is evidence; it cannot be
 * removed by anyone. One row per way a file can be tied to such a document.
 * `by` says which value the query is bound with.
 */
export const POSTED_DOC_CHECKS: {
  label: string;
  by: "resourceId" | "id";
  resourceType?: string;
  sql: string;
}[] = [
  {
    label: "a posted Delivery Order",
    by: "resourceId",
    resourceType: "SO",
    sql: "SELECT id FROM delivery_orders WHERE sales_order_id = ? AND status NOT IN ('DRAFT','CANCELLED') LIMIT 1",
  },
  {
    label: "a Sales Invoice",
    by: "resourceId",
    resourceType: "SO",
    sql: "SELECT id FROM invoices WHERE sales_order_id = ? AND status NOT IN ('DRAFT','CANCELLED') LIMIT 1",
  },
  {
    label: "a posted Purchase Invoice",
    by: "id",
    sql: "SELECT id FROM purchase_invoices WHERE source_document_file_id = ? AND status NOT IN ('DRAFT','CANCELLED') LIMIT 1",
  },
];

/** Why this file may not be removed — or null when it may. Fails CLOSED. */
async function lockReason(db: Env["Variables"]["DB"], row: FileAssetRow): Promise<string | null> {
  if (row.locked) return "This file is locked and cannot be deleted.";
  for (const chk of POSTED_DOC_CHECKS) {
    if (chk.resourceType && chk.resourceType !== row.resourceType) continue;
    try {
      const hit = await db.prepare(chk.sql).bind(row[chk.by]).first<{ id: string }>();
      if (hit) return `This file is the original of ${chk.label} (${hit.id}) and cannot be deleted.`;
    } catch (err) {
      // A table/column this deployment never created means "not linked". Any
      // OTHER failure must not be read as permission to delete.
      if (isBenignSelfApplyError(err)) continue;
      throw err;
    }
  }
  return null;
}

/** R16 — one row per view. Off the response path; never fails the view. */
function logAccess(c: Context<Env>, fileId: string, action: "download" | "view" | "stream"): void {
  const write = c.var.DB.prepare(
    `INSERT INTO ocr_file_access_log (id, org_id, user_id, file_id, action, ip_address, accessed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      `fal-${crypto.randomUUID().slice(0, 12)}`,
      getOrgId(c),
      (c.get as unknown as (k: string) => string | undefined)("userId") ?? null,
      fileId,
      action,
      c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      new Date().toISOString(),
    )
    .run()
    .catch((e: unknown) => console.warn("[files] access log failed:", e instanceof Error ? e.message : e));
  // ponytail: one row per request, thumbnails included. If catalogue grids make
  // this table noisy, log only resourceTypes that hold originals.
  if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(write);
}

const INLINE_SAFE = /^(image\/(png|jpeg|webp|gif|heic)|application\/pdf|video\/(mp4|quicktime|webm|3gpp))$/;

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function genId(): string {
  return `fa-${crypto.randomUUID().slice(0, 12)}`;
}

/**
 * Server-side twin of POST / for callers that already hold the bytes (T-010 R17:
 * the assistant's attachments). Same key layout, checksum and `file_assets` row;
 * no audit event and no MIME sniff — the caller has validated the bytes. Returns
 * false (never throws) when the type is not storable or storage is unavailable,
 * so it is safe as a best-effort side effect.
 */
export async function saveOriginalFile(
  db: Env["Variables"]["DB"],
  env: Env["Bindings"],
  f: {
    orgId: string;
    resourceType: string;
    resourceId: string;
    filename: string;
    contentType: string;
    bytes: ArrayBuffer;
    uploadedBy: string | null;
    source: string;
  },
): Promise<boolean> {
  if (!ALLOWED_MIME.has(f.contentType)) return false;
  try {
    await ensureRetentionSchema(db);
    const id = genId();
    const r2Key = buildKey({ orgId: f.orgId, resourceType: f.resourceType, resourceId: f.resourceId, id, filename: f.filename });
    const checksum = await sha256Hex(f.bytes);
    await putFile(env, r2Key, f.bytes, f.contentType);
    await db
      .prepare(
        `INSERT INTO file_assets
           (id, resourceType, resourceId, filename, contentType, sizeBytes,
            r2Key, uploadedBy, uploadedAt, orgId, checksum, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, f.resourceType, f.resourceId, f.filename, f.contentType, f.bytes.byteLength, r2Key, f.uploadedBy, new Date().toISOString(), f.orgId, checksum, f.source)
      .run();
    return true;
  } catch (e) {
    console.warn("[files] saveOriginalFile failed:", e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * Build the storage object key. Format:
 *   <orgId>/<resourceType>/<resourceId>/<id>-<filename>
 *
 * orgId-prefixed so even an admin tool that walks the bucket can't
 * cross-list tenants by accident; resourceType+resourceId are the
 * folder hierarchy a future admin browser surfaces; the id+filename
 * tail keeps deletes idempotent and lets ops see what they're about
 * to delete from the bucket listing.
 */
function buildKey(parts: {
  orgId: string;
  resourceType: string;
  resourceId: string;
  id: string;
  filename: string;
}): string {
  // Strip any path traversal hijinks from filename — only keep basename.
  const basename = parts.filename.split(/[\\/]/).pop() || "file";
  return `${parts.orgId}/${parts.resourceType}/${parts.resourceId}/${parts.id}-${basename}`;
}

// ---------------------------------------------------------------------------
// POST /api/files — multipart upload
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  const denied = await requirePermission(c, "files", "create");
  if (denied) return denied;
  if (!c.env.SUPABASE_PROJECT_REF || !c.env.SUPABASE_SERVICE_KEY) {
    return c.json({ success: false, error: "file storage unavailable" }, 503);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ success: false, error: "invalid multipart body" }, 400);
  }

  const file = form.get("file");
  const resourceType = String(form.get("resourceType") ?? "").trim();
  const resourceId = String(form.get("resourceId") ?? "").trim();

  if (!(file instanceof File)) {
    return c.json({ success: false, error: "file field required" }, 400);
  }
  if (!resourceType || !resourceId) {
    return c.json(
      { success: false, error: "resourceType and resourceId are required" },
      400,
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    // Human-readable — this string surfaces directly in an operator toast.
    return c.json(
      {
        success: false,
        error: `File is too large (${Math.round(file.size / 1048576)} MB) — maximum is ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB`,
      },
      413,
    );
  }

  const declaredType = file.type || "application/octet-stream";
  if (!ALLOWED_MIME.has(declaredType)) {
    return c.json(
      {
        success: false,
        error: `file type not allowed: ${declaredType}`,
      },
      400,
    );
  }

  // Magic-byte sniff on the first 16 bytes. Reject if the declared type
  // doesn't match the actual content — closes the path where a malicious
  // client uploads HTML+JS labelled as image/png and later serves the
  // stream URL to a victim.
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const sniffed = sniffMime(head);
  if (!sniffed || !mimeMatches(declaredType, sniffed)) {
    return c.json(
      {
        success: false,
        error: "file content does not match declared type",
      },
      400,
    );
  }

  const orgId = getOrgId(c);
  const id = genId();
  const filename = file.name || "upload";
  // Use the sniffed MIME for storage so a client lying about the type can't
  // poison the served Content-Type later.
  const contentType = sniffed;
  const r2Key = buildKey({ orgId, resourceType, resourceId, id, filename });
  const uploadedBy = (
    c.get as unknown as (k: string) => string | undefined
  )("userId") ?? null;
  const uploadedAt = new Date().toISOString();
  // Where the file came from — "scan-po", "scan-supplier", "scan-finance",
  // "assistant", … Free text from the caller; "upload" when it says nothing.
  const source = String(form.get("source") ?? "").trim().slice(0, 40) || "upload";

  try {
    await ensureRetentionSchema(c.var.DB);
    const bytes = await file.arrayBuffer();
    const checksum = await sha256Hex(bytes);
    // Upload first, DB second — if the DB write fails we have an
    // orphan object in storage (cleanable by a sweeper job; cheaper than
    // an orphan DB row pointing at nothing).
    await putFile(c.env, r2Key, bytes, contentType);

    await c.var.DB.prepare(
      `INSERT INTO file_assets
         (id, resourceType, resourceId, filename, contentType, sizeBytes,
          r2Key, uploadedBy, uploadedAt, orgId, checksum, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        resourceType,
        resourceId,
        filename,
        contentType,
        file.size,
        r2Key,
        uploadedBy,
        uploadedAt,
        orgId,
        checksum,
        source,
      )
      .run();

    // Sprint 2 task 5 — emit one audit_events row on every successful upload.
    // Snapshot only metadata; bytes live in storage and aren't audit-friendly.
    await emitAudit(c, {
      resource: "files",
      resourceId: id,
      action: "create",
      after: {
        id,
        resourceType,
        resourceId,
        filename,
        contentType,
        sizeBytes: file.size,
        r2Key,
        uploadedBy,
        uploadedAt,
        orgId,
        checksum,
        source,
      },
    });

    return c.json({
      success: true,
      data: {
        id,
        resourceType,
        resourceId,
        filename,
        contentType,
        sizeBytes: file.size,
        r2Key,
        uploadedBy,
        uploadedAt,
        orgId,
        checksum,
        source,
      },
    });
  } catch (err) {
    if (err instanceof SupabaseStorageNotConfiguredError) {
      return c.json({ success: false, error: "file storage unavailable" }, 503);
    }
    console.error("[files/POST] upload failed:", err);
    // Best-effort cleanup of the storage object since we don't know if put
    // succeeded before the DB write blew up.
    try {
      await deleteFile(c.env, r2Key);
    } catch {
      // Already gone, or storage is transient — sweeper will catch it.
    }
    return c.json({ success: false, error: "upload failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/files?resourceType=&resourceId=
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const orgId = getOrgId(c);
  const resourceType = c.req.query("resourceType");
  const resourceId = c.req.query("resourceId");

  await ensureRetentionSchema(c.var.DB);
  let sql = "SELECT * FROM file_assets WHERE orgId = ?";
  // Archived files leave every list; they are still fetchable by id (audit).
  if (c.req.query("includeArchived") !== "1") sql += " AND archived IS NOT TRUE";
  const binds: unknown[] = [orgId];
  if (resourceType) {
    sql += " AND resourceType = ?";
    binds.push(resourceType);
  }
  if (resourceId) {
    sql += " AND resourceId = ?";
    binds.push(resourceId);
  }
  sql += " ORDER BY uploadedAt DESC LIMIT 500";

  const res = await c.var.DB.prepare(sql)
    .bind(...binds)
    .all<FileAssetRow>();
  return c.json({ success: true, data: res.results ?? [] });
});

// ---------------------------------------------------------------------------
// PATCH /api/files/:id/cover — mark this file as the cover photo for its
// resource. Used by the Products Catalog "Set as cover" action. The cover is
// the file with the lowest sort_order (clients sort by sort_order then date);
// we reset the resource's covers then stamp this one to 0 so there is exactly
// one. `sort_order` is an add-on snake_case column self-applied at runtime
// (migrations don't auto-run on deploy).
// ---------------------------------------------------------------------------
app.patch("/:id/cover", async (c) => {
  const id = c.req.param("id");
  const orgId = getOrgId(c);
  await c.var.DB.prepare(
    "ALTER TABLE file_assets ADD COLUMN IF NOT EXISTS sort_order INTEGER",
  ).run();
  const row = await c.var.DB.prepare(
    "SELECT * FROM file_assets WHERE id = ? AND orgId = ?",
  )
    .bind(id, orgId)
    .first<FileAssetRow>();
  if (!row) return c.json({ success: false, error: "Not found" }, 404);
  await c.var.DB.batch([
    c.var.DB.prepare(
      "UPDATE file_assets SET sort_order = NULL WHERE orgId = ? AND resourceType = ? AND resourceId = ?",
    ).bind(orgId, row.resourceType, row.resourceId),
    c.var.DB.prepare("UPDATE file_assets SET sort_order = 0 WHERE id = ?").bind(id),
  ]);
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// GET /api/files/:id — metadata
// ---------------------------------------------------------------------------
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const orgId = getOrgId(c);
  const row = await c.var.DB.prepare(
    "SELECT * FROM file_assets WHERE id = ? AND orgId = ?",
  )
    .bind(id, orgId)
    .first<FileAssetRow>();
  if (!row) return c.json({ success: false, error: "Not found" }, 404);
  return c.json({ success: true, data: row });
});

// ---------------------------------------------------------------------------
// GET /api/files/:id/download — 302 to a presigned URL.
// ---------------------------------------------------------------------------
app.get("/:id/download", async (c) => {
  if (!c.env.SUPABASE_PROJECT_REF || !c.env.SUPABASE_SERVICE_KEY) {
    return c.json({ success: false, error: "file storage unavailable" }, 503);
  }
  const id = c.req.param("id");
  const orgId = getOrgId(c);
  const row = await c.var.DB.prepare(
    "SELECT * FROM file_assets WHERE id = ? AND orgId = ?",
  )
    .bind(id, orgId)
    .first<FileAssetRow>();
  if (!row) return c.json({ success: false, error: "Not found" }, 404);

  const inline = c.req.query("inline") === "1";
  await ensureRetentionSchema(c.var.DB);
  logAccess(c, id, inline ? "view" : "download");
  try {
    const url = await signedDownloadUrl(c.env, row.r2Key, 300);
    if (url && inline) {
      // No `download` param → the storage host serves it with its stored
      // Content-Type and the browser renders it. Different origin, so nothing
      // it renders can touch this app's session.
      return c.redirect(url, 302);
    }
    if (url) {
      // Force the browser to save with the real filename. Without this the
      // presigned URL serves the object under its storage key, so the file
      // downloaded as a raw UUID (e.g. "a8793c72-…") instead of its name.
      // Supabase signed URLs honour a `download` query param.
      const sep = url.includes("?") ? "&" : "?";
      const named = `${url}${sep}download=${encodeURIComponent(row.filename || "download")}`;
      return c.redirect(named, 302);
    }
    // Presigning unavailable on this runtime — fall through to stream proxy.
    return c.redirect(`/api/files/${id}/stream`, 302);
  } catch (err) {
    if (err instanceof SupabaseStorageNotConfiguredError) {
      return c.json({ success: false, error: "file storage unavailable" }, 503);
    }
    console.error("[files/download] failed:", err);
    return c.json({ success: false, error: "download failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/files/:id/stream — proxy stream (fallback when presigning is
// not available on this runtime).
// ---------------------------------------------------------------------------
app.get("/:id/stream", async (c) => {
  if (!c.env.SUPABASE_PROJECT_REF || !c.env.SUPABASE_SERVICE_KEY) {
    return c.json({ success: false, error: "file storage unavailable" }, 503);
  }
  const id = c.req.param("id");
  const orgId = getOrgId(c);
  const row = await c.var.DB.prepare(
    "SELECT * FROM file_assets WHERE id = ? AND orgId = ?",
  )
    .bind(id, orgId)
    .first<FileAssetRow>();
  if (!row) return c.json({ success: false, error: "Not found" }, 404);

  await ensureRetentionSchema(c.var.DB);
  logAccess(c, id, "stream");
  try {
    const obj = await getFile(c.env, row.r2Key);
    if (!obj) return c.json({ success: false, error: "Not found" }, 404);
    // R15 — "View original" must SHOW the document. Inline only for the types
    // the upload sniffer can vouch for (images, PDF, video — none of which can
    // run script in this origin); anything else, e.g. a stale row from before
    // the allowlist, is still forced to download. `?download=1` forces it too.
    const disposition =
      INLINE_SAFE.test(row.contentType) && c.req.query("download") !== "1" ? "inline" : "attachment";
    return new Response(obj.body, {
      headers: {
        "Content-Type": row.contentType,
        "Content-Length": String(row.sizeBytes),
        "Content-Disposition": `${disposition}; filename="${row.filename.replace(/"/g, "")}"`,
        // Belt-and-braces: tell the browser not to MIME-sniff in case the
        // upload validator missed a polyglot file.
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof SupabaseStorageNotConfiguredError) {
      return c.json({ success: false, error: "file storage unavailable" }, 503);
    }
    console.error("[files/stream] failed:", err);
    return c.json({ success: false, error: "stream failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/files/:id — ARCHIVE (R14). The row and the storage object both
// stay; the file just leaves every list. The original of a posted document
// refuses even that, with an explicit reason.
//
// This also removes the old orphan path: a hard delete with storage down used to
// drop the row and strand the object.
// ---------------------------------------------------------------------------
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "files", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const orgId = getOrgId(c);
  await ensureRetentionSchema(c.var.DB);
  const row = await c.var.DB.prepare(
    "SELECT * FROM file_assets WHERE id = ? AND orgId = ?",
  )
    .bind(id, orgId)
    .first<FileAssetRow>();
  if (!row) return c.json({ success: false, error: "Not found" }, 404);

  const reason = await lockReason(c.var.DB, row);
  if (reason) return c.json({ success: false, error: reason, code: "FILE_LOCKED" }, 409);

  const archivedBy = (c.get as unknown as (k: string) => string | undefined)("userId") ?? null;
  await c.var.DB.prepare(
    "UPDATE file_assets SET archived = TRUE, archived_at = ?, archived_by = ? WHERE id = ? AND orgId = ?",
  )
    .bind(new Date().toISOString(), archivedBy, id, orgId)
    .run();

  await emitAudit(c, {
    resource: "files",
    resourceId: id,
    action: "delete",
    before: row,
    after: { ...row, archived: true },
  });

  return c.json({ success: true, archived: true });
});

export default app;
