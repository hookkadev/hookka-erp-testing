// ---------------------------------------------------------------------------
// scan-finance.ts — OCR for FINANCE documents (owner request 2026-07-08):
// Other Creditor/Debtor bills and Expense Payment (PV) receipts.
//
// Thin HTTP wrapper over the SAME supplier-document extraction engine the
// PI/GRN scan uses (src/api/lib/scan-engine.ts runExtract kind:"supplier" —
// utility bills / rent invoices / petrol receipts are structurally supplier
// invoices: letterhead + doc no + date + amount lines + totals). Differences
// from /api/scan-supplier/extract:
//   · permission gate = accounting:create (finance clerks don't hold
//     purchase-orders:create)
//   · single-doc contract — the FIRST detected doc prefills the form; a
//     multi-doc PDF surfaces a hint so the operator splits it
//   · amounts converted to integer SEN here (forms are MoneyInput-style)
//   · T-010 R10: it now RECORDS a sample like every other scan and returns its
//     `sampleId`; POST /samples/:id/confirm (accounting:create) saves what the
//     clerk actually posted, which feeds the same correction log. Finance
//     parties are not suppliers, so party_id stays null: corrections are
//     logged and counted, but no per-party rules or aliases are distilled.
//
// The result only PREFILLS the form — the operator reviews, picks the GL
// account(s), and saves through the normal POST. Nothing posts automatically.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { runExtract } from "../lib/scan-engine";
import { confirmSupplierSample } from "../lib/ocr-learning";

const app = new Hono<Env>();

const MAX_FILE_BYTES = 32 * 1024 * 1024;

type RawLine = {
  description?: string | null;
  qty?: number | null;
  unitPrice?: number | null;
  amount?: number | null;
  tax?: number | null;
};
type RawDoc = {
  supplierName?: string | null;
  docType?: string | null;
  docNo?: string | null;
  docDate?: string | null;
  lines?: RawLine[];
  subtotal?: number | null;
  tax?: number | null;
  total?: number | null;
};

const toSen = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? Math.round(n * 100) : null;
};

app.post("/extract", async (c) => {
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch (e) {
    return c.json(
      { success: false, error: `Invalid multipart body: ${(e as Error).message}` },
      400,
    );
  }
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return c.json({ success: false, error: "Missing `file` field." }, 400);
  }
  if (file.size > MAX_FILE_BYTES) {
    return c.json(
      { success: false, error: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 32MB.` },
      400,
    );
  }
  const mime = file.type || "";
  const name = file.name || "";
  const isPdf = mime === "application/pdf" || name.toLowerCase().endsWith(".pdf");
  const isImage =
    mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|heic|heif)$/i.test(name);
  if (!isPdf && !isImage) {
    return c.json({ success: false, error: "Only PDF or image files are accepted." }, 400);
  }

  const result = await runExtract(c.var.DB, c.env, {
    kind: "supplier",
    bytes: await file.arrayBuffer(),
    mimeType: mime,
    fileName: name,
    orgId: getOrgId(c),
    createdBy: (c.get("userId" as never) as string | undefined) ?? null,
    recordSample: true,
    aiRetries: 1,
  });
  if (!result.ok) {
    return c.json({ success: false, error: result.error, sampleId: result.sampleId }, 502);
  }

  const env = result.data as { docs?: RawDoc[] };
  const docs = Array.isArray(env.docs) ? env.docs : [];
  const d = docs[0] ?? {};
  const lines = (Array.isArray(d.lines) ? d.lines : [])
    .map((l) => ({
      description: String(l.description ?? "").trim(),
      amountSen: toSen(l.amount) ?? (toSen(l.unitPrice) !== null && Number(l.qty) ? Math.round((Number(l.unitPrice) || 0) * (Number(l.qty) || 0) * 100) : null),
    }))
    .filter((l) => l.amountSen !== null && l.amountSen > 0) as { description: string; amountSen: number }[];

  return c.json({
    success: true,
    data: {
      partyName: String(d.supplierName ?? "").trim() || null,
      docType: String(d.docType ?? "").trim() || null,
      docNo: String(d.docNo ?? "").trim() || null,
      docDate: /^\d{4}-\d{2}-\d{2}$/.test(String(d.docDate ?? "")) ? String(d.docDate) : null,
      lines,
      subtotalSen: toSen(d.subtotal),
      taxSen: toSen(d.tax),
      totalSen: toSen(d.total),
      extraDocs: docs.length > 1 ? docs.length - 1 : 0,
      lowConfidence: (d as { lowConfidence?: string[] }).lowConfidence ?? [],
    },
    sampleId: result.sampleId ?? null,
  });
});

// POST /api/scan-finance/samples/:id/confirm  body: { correctedJson }
// `correctedJson` uses the ENGINE's shape ({docNo, supplierName, lines:[{description,
// qty, unitPrice}]}) so it diffs against the stored raw extraction.
app.post("/samples/:id/confirm", async (c) => {
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;
  let body: { correctedJson?: unknown };
  try {
    body = (await c.req.json()) as { correctedJson?: unknown };
  } catch {
    return c.json({ success: false, error: "Invalid JSON body." }, 400);
  }
  if (body.correctedJson === undefined) {
    return c.json({ success: false, error: "Missing `correctedJson`." }, 400);
  }
  const saved = await confirmSupplierSample(c.var.DB, {
    tenantId: getOrgId(c),
    sampleId: c.req.param("id"),
    correctedJson:
      typeof body.correctedJson === "string" ? body.correctedJson : JSON.stringify(body.correctedJson),
    gold: false,
    correctedBy: (c.get("userId" as never) as string | undefined) ?? null,
  });
  if (!saved.found) return c.json({ success: false, error: "Sample not found." }, 404);
  return c.json({ success: true, learned: saved.learned });
});

export default app;
