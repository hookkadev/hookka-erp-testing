// Approval endpoints for service cases (mounted inside service-cases.ts BEFORE
// its "/:id" routes so "/approvals" is not swallowed as an id). Logic and the
// exchange gate live in ../lib/service-approval.ts.
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { emitAudit } from "../lib/audit";
import {
  APPROVAL_KINDS, ensureApprovalColumns, fileApprovalRequest, type ApprovalKind,
} from "../lib/service-approval";

const app = new Hono<Env>();

type Row = Record<string, string | null>;
const pick = (r: Row, snake: string, camel: string) => r[snake] ?? r[camel] ?? null;
const actorOf = (c: unknown): string | null =>
  (c as { get: (k: string) => string | undefined }).get("userId") ?? null;

// GET /api/service-cases/approvals — cases waiting for a decision, oldest first.
app.get("/approvals", async (c) => {
  const denied = await requirePermission(c, "service-cases", "read");
  if (denied) return denied;
  try {
    await ensureApprovalColumns(c.var.DB);
    const res = await c.var.DB
      .prepare(
        `SELECT * FROM service_cases WHERE approval_status = 'PENDING'
          ORDER BY approval_requested_at ASC LIMIT 200`,
      )
      .all<Row>();
    const data = (res.results ?? []).map((r) => ({
      id: r.id,
      caseNo: pick(r, "case_no", "caseNo"),
      customerName: pick(r, "customer_name", "customerName"),
      issue: (pick(r, "issue_description", "issueDescription") ?? "").slice(0, 200),
      caseStatus: r.status,
      kind: r.approval_kind,
      requestedAt: r.approval_requested_at,
      requestedBy: r.approval_requested_by,
      note: r.approval_note,
    }));
    return c.json({ success: true, data, total: data.length });
  } catch (err) {
    console.error("[GET /api/service-cases/approvals] failed:", err);
    return c.json({ success: false, error: err instanceof Error ? err.message : "failed" }, 500);
  }
});

// POST /api/service-cases/:id/approval/request  { kind?: EXCHANGE|GENERAL, note? }
app.post("/:id/approval/request", async (c) => {
  const denied = await requirePermission(c, "service-cases", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  try {
    const body = (await c.req.json().catch(() => ({}))) as { kind?: string; note?: string };
    const kind = (body.kind ?? "GENERAL") as ApprovalKind;
    if (!APPROVAL_KINDS.includes(kind)) {
      return c.json({ success: false, error: "kind must be EXCHANGE or GENERAL" }, 400);
    }
    await ensureApprovalColumns(c.var.DB);
    const row = await c.var.DB
      .prepare("SELECT status, approval_status FROM service_cases WHERE id = ?")
      .bind(id)
      .first<{ status: string; approval_status: string | null }>();
    if (!row) return c.json({ success: false, error: "Service case not found" }, 404);
    if (row.status === "CLOSED" || row.status === "CANCELLED") {
      return c.json({ success: false, error: `Case is ${row.status}; reopen it first.` }, 409);
    }
    if (row.approval_status === "PENDING") {
      return c.json({ success: false, error: "An approval is already pending on this case." }, 409);
    }
    await fileApprovalRequest(c, id, kind, body.note?.trim() || null);
    return c.json({ success: true, data: { id, kind, approvalStatus: "PENDING" } });
  } catch (err) {
    console.error("[POST approval/request] failed:", err);
    return c.json({ success: false, error: err instanceof Error ? err.message : "failed" }, 500);
  }
});

// Approve / reject share one body. Gated by service-cases:approve (ADMIN and
// SUPER_ADMIN pass via the wildcard; other roles need that grant seeded in
// role_permissions — same model as purchase-orders:approve).
for (const decision of ["approve", "reject"] as const) {
  app.post(`/:id/approval/${decision}`, async (c) => {
    const denied = await requirePermission(c, "service-cases", "approve");
    if (denied) return denied;
    const id = c.req.param("id");
    try {
      const body = (await c.req.json().catch(() => ({}))) as { note?: string };
      const note = body.note?.trim() || null;
      if (decision === "reject" && !note) {
        return c.json({ success: false, error: "A reason is required to reject." }, 400);
      }
      await ensureApprovalColumns(c.var.DB);
      const row = await c.var.DB
        .prepare("SELECT approval_kind, approval_status FROM service_cases WHERE id = ?")
        .bind(id)
        .first<{ approval_kind: string | null; approval_status: string | null }>();
      if (!row) return c.json({ success: false, error: "Service case not found" }, 404);
      if (row.approval_status !== "PENDING") {
        return c.json({ success: false, error: "There is no pending approval on this case." }, 409);
      }
      const status = decision === "approve" ? "APPROVED" : "REJECTED";
      const actor = actorOf(c);
      const at = new Date().toISOString();
      // AND approval_status='PENDING' so two approvers cannot both "win".
      await c.var.DB
        .prepare(
          `UPDATE service_cases SET approval_status = ?, approved_by = ?, approved_at = ?,
                  approval_note = COALESCE(?, approval_note)
            WHERE id = ? AND approval_status = 'PENDING'`,
        )
        .bind(status, actor, at, note, id)
        .run();
      await emitAudit(c, {
        resource: "service-cases",
        resourceId: id,
        action: decision,
        before: row,
        after: { approval_kind: row.approval_kind, approval_status: status, approved_by: actor, approved_at: at, approval_note: note },
      });
      return c.json({ success: true, data: { id, approvalStatus: status } });
    } catch (err) {
      console.error(`[POST approval/${decision}] failed:`, err);
      return c.json({ success: false, error: err instanceof Error ? err.message : "failed" }, 500);
    }
  });
}

export default app;
