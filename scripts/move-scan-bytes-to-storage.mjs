// T-010 R2 — one-off: move legacy scan_queue.file_bytes_b64 into object storage.
//
//   HOOKKA_STAGING_DB_URL=… SUPABASE_PROJECT_REF=… SUPABASE_SERVICE_KEY=… \
//     node scripts/move-scan-bytes-to-storage.mjs --staging            # dry run
//   … node scripts/move-scan-bytes-to-storage.mjs --staging --apply    # do it
//   (--prod uses HOOKKA_PROD_DB_URL; --limit N caps the batch, default 200)
//
// Safe to re-run and to stop half-way: a row is touched only after its upload is
// read back and its SHA-256 equals `file_hash`; only then is storage_key set and
// the base64 column NULLed. A row that fails is left exactly as it was.
// Rows still being scanned (queued / processing) are skipped — the worker reads
// the base64 column for those. Same key layout as scan-queue.ts scanObjectKey().
import postgres from "postgres";
import { createHash } from "node:crypto";
import { prodUrl, stagingUrl } from "./_db.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const prod = args.includes("--prod");
if (!prod && !args.includes("--staging")) { console.error("Pass --staging or --prod."); process.exit(1); }
const limit = Number(args[args.indexOf("--limit") + 1]) || 200;
const ref = (process.env.SUPABASE_PROJECT_REF ?? "").trim();
const key = (process.env.SUPABASE_SERVICE_KEY ?? "").trim();
if (apply && (!ref || !key)) { console.error("--apply needs SUPABASE_PROJECT_REF and SUPABASE_SERVICE_KEY."); process.exit(1); }

const BUCKET = "hookka-files";
const base = `https://${ref}.supabase.co/storage/v1`;
const objUrl = (k) => `${base}/object/${BUCKET}/${k.split("/").map(encodeURIComponent).join("/")}`;
const objectKey = (orgId, id, name) => `${orgId || "no-org"}/scan-queue/${id}-${name.split(/[\/]/).pop() || "scan"}`;

const sql = postgres(prod ? prodUrl() : stagingUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM scan_queue WHERE file_bytes_b64 IS NOT NULL AND storage_key IS NULL AND status NOT IN ('queued','processing')`;
  console.log(`${prod ? "PROD" : "staging"}: ${n} movable row(s); this run handles up to ${limit}. ${apply ? "APPLYING" : "DRY RUN"}`);
  const rows = await sql`SELECT id, org_id, file_name, mime_type, file_hash, file_bytes_b64 FROM scan_queue
    WHERE file_bytes_b64 IS NOT NULL AND storage_key IS NULL AND status NOT IN ('queued','processing')
    ORDER BY created_at LIMIT ${limit}`;
  let moved = 0, skipped = 0;
  for (const r of rows) {
    const bytes = Buffer.from(r.file_bytes_b64, "base64");
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (r.file_hash && sha !== r.file_hash) { console.warn(`skip ${r.id}: bytes hash ${sha.slice(0, 8)} != file_hash ${String(r.file_hash).slice(0, 8)}`); skipped++; continue; }
    if (!apply) { moved++; continue; }
    const k = objectKey(r.org_id, r.id, r.file_name ?? "scan");
    try {
      const up = await fetch(objUrl(k), { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": r.mime_type || "application/octet-stream", "x-upsert": "true" }, body: bytes });
      if (!up.ok) throw new Error(`upload ${up.status}`);
      const back = await fetch(objUrl(k), { headers: { Authorization: `Bearer ${key}` } });
      if (!back.ok) throw new Error(`read-back ${back.status}`);
      if (createHash("sha256").update(Buffer.from(await back.arrayBuffer())).digest("hex") !== sha) throw new Error("read-back hash mismatch");
      await sql`UPDATE scan_queue SET storage_key = ${k}, file_bytes_b64 = NULL WHERE id = ${r.id} AND storage_key IS NULL`;
      moved++;
    } catch (e) { console.warn(`skip ${r.id}: ${e.message}`); skipped++; }
  }
  console.log(`${apply ? "moved" : "would move"} ${moved}, skipped ${skipped}. Re-run until "movable" is 0.`);
} finally { await sql.end(); }
