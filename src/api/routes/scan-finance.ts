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
//   · the FIRST detected doc sits at the top level (a single-bill form uses
//     it and hints when there are more); `docs` carries every doc in the file
//     — Scan Bills makes one row per bill, a payment voucher takes them all
//     (owner 2026-10-01)
//   · amounts converted to integer SEN here (forms are MoneyInput-style)
//   · no learning-loop sample rows (finance parties aren't suppliers). What
//     finance scans learn — the account per line — comes from finance's own
//     saved vouchers and bills, client-side (src/lib/scan-account-learn.ts)
//
// The result only PREFILLS the form — the operator reviews, picks the GL
// account(s), and saves through the normal POST. Nothing posts automatically.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { runExtract } from "../lib/scan-engine";

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
    recordSample: false,
  });
  if (!result.ok) {
    return c.json({ success: false, error: result.error }, 502);
  }

  const env = result.data as { docs?: RawDoc[] };
  const docs = Array.isArray(env.docs) ? env.docs : [];
  const shaped = docs.map(shapeDoc);
  // The first bill at the top level (every caller reads it); `docs` carries
  // EVERY bill the file holds — one PDF can bundle several (owner 2026-10-01:
  // the batch scan opens one record per bill, not just the first).
  return c.json({
    success: true,
    data: {
      ...(shaped[0] ?? shapeDoc({})),
      extraDocs: docs.length > 1 ? docs.length - 1 : 0,
      docs: shaped,
    },
  });
});

function shapeDoc(d: RawDoc) {
  const lines = (Array.isArray(d.lines) ? d.lines : [])
    .map((l) => ({
      description: String(l.description ?? "").trim(),
      amountSen: toSen(l.amount) ?? (toSen(l.unitPrice) !== null && Number(l.qty) ? Math.round((Number(l.unitPrice) || 0) * (Number(l.qty) || 0) * 100) : null),
    }))
    .filter((l) => l.amountSen !== null && l.amountSen > 0) as { description: string; amountSen: number }[];
  return {
    partyName: String(d.supplierName ?? "").trim() || null,
    docType: String(d.docType ?? "").trim() || null,
    docNo: String(d.docNo ?? "").trim() || null,
    docDate: /^\d{4}-\d{2}-\d{2}$/.test(String(d.docDate ?? "")) ? String(d.docDate) : null,
    lines,
    subtotalSen: toSen(d.subtotal),
    taxSen: toSen(d.tax),
    totalSen: toSen(d.total),
  };
}

export default app;
