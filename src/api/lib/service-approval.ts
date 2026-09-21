// ---------------------------------------------------------------------------
// service-approval.ts — approval on a service case, and the 1-to-1 exchange gate.
//
// HOW AN EXCHANGE IS REPRESENTED (read from source 2026-09-21): there is no
// "EXCHANGE" mode anywhere. The plural service-orders module hands the customer
// a REPLACEMENT UNIT in exactly two modes — STOCK_SWAP (pull a finished unit
// from FG, ship now) and REPRODUCE (open a single-unit PO; the service-orders.ts
// header calls it "a single-unit replacement"). REPAIR ships nothing new. So an
// exchange = a service order whose mode is in EXCHANGE_MODES.
//
// THE GATE: setting one of those modes (POST /api/service-orders with a mode,
// or PUT /api/service-orders/:id/mode) is refused with 409 until the parent
// case carries an APPROVED approval of kind EXCHANGE. If none was requested,
// the refusal itself files a PENDING request, so the approver sees it on the
// Service dashboard. One approval slot per case (columns on service_cases);
// a GENERAL approval never satisfies an exchange — the gate re-files as EXCHANGE.
//
// Not covered (stated, not implied): the SINGULAR /service-order/* SV orders
// ride /api/sales-orders and have no resolution mode, so they are not gated.
//
// Columns are snake_case, runtime self-applied (migrations are inert on deploy).
// ---------------------------------------------------------------------------
import type { Context } from "hono";
import type { Env } from "../worker";
import { runSelfApply } from "./self-apply";
import { emitAudit } from "./audit";

export type ApprovalKind = "EXCHANGE" | "GENERAL";
export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";
export const APPROVAL_KINDS: ApprovalKind[] = ["EXCHANGE", "GENERAL"];
export const EXCHANGE_MODES: readonly string[] = ["STOCK_SWAP", "REPRODUCE"];
export const isExchangeMode = (mode: unknown): boolean =>
  typeof mode === "string" && EXCHANGE_MODES.includes(mode);

const APPROVAL_DDL = [
  "ALTER TABLE service_cases ADD COLUMN IF NOT EXISTS approval_kind TEXT",
  "ALTER TABLE service_cases ADD COLUMN IF NOT EXISTS approval_status TEXT",
  "ALTER TABLE service_cases ADD COLUMN IF NOT EXISTS approval_requested_by TEXT",
  "ALTER TABLE service_cases ADD COLUMN IF NOT EXISTS approval_requested_at TEXT",
  "ALTER TABLE service_cases ADD COLUMN IF NOT EXISTS approved_by TEXT",
  "ALTER TABLE service_cases ADD COLUMN IF NOT EXISTS approved_at TEXT",
  "ALTER TABLE service_cases ADD COLUMN IF NOT EXISTS approval_note TEXT",
];

// Boolean memo, never a promise (tests/self-apply-memo-is-boolean).
let _applied = false;
export async function ensureApprovalColumns(db: D1Database): Promise<void> {
  if (_applied) return;
  await runSelfApply(db as never, "service-approval", APPROVAL_DDL);
  _applied = true;
}
export function _resetApprovalColumnsForTests(): void {
  _applied = false;
}

type GateRow = { approval_kind?: string | null; approval_status?: string | null } | null;
export type GateVerdict = "allow" | "pending" | "rejected" | "needs-request";

/** Pure: may a replacement be issued for a case in this approval state? */
export function exchangeGateVerdict(row: GateRow): GateVerdict {
  if (!row || row.approval_kind !== "EXCHANGE") return "needs-request";
  if (row.approval_status === "APPROVED") return "allow";
  if (row.approval_status === "REJECTED") return "rejected";
  return "pending";
}

const actorOf = (c: Context<Env>): string | null =>
  (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;

/** File (or re-file) a PENDING approval on a case. Clears any earlier decision. */
export async function fileApprovalRequest(
  c: Context<Env>,
  caseId: string,
  kind: ApprovalKind,
  note: string | null,
): Promise<void> {
  await ensureApprovalColumns(c.var.DB);
  await c.var.DB
    .prepare(
      `UPDATE service_cases
          SET approval_kind = ?, approval_status = 'PENDING',
              approval_requested_by = ?, approval_requested_at = ?,
              approved_by = NULL, approved_at = NULL, approval_note = ?
        WHERE id = ?`,
    )
    .bind(kind, actorOf(c), new Date().toISOString(), note, caseId)
    .run();
  await emitAudit(c, {
    resource: "service-cases",
    resourceId: caseId,
    action: "submit",
    after: { approval_kind: kind, approval_status: "PENDING", approval_note: note },
  });
}

/**
 * The exchange gate. Returns null when the mode may proceed, else the 409 body
 * to send. Call BEFORE any write.
 */
export async function gateExchange(
  c: Context<Env>,
  caseId: string | null | undefined,
  mode: unknown,
): Promise<{ status: 409; error: string } | null> {
  if (!isExchangeMode(mode) || !caseId) return null;
  await ensureApprovalColumns(c.var.DB);
  const row = await c.var.DB
    .prepare("SELECT approval_kind, approval_status FROM service_cases WHERE id = ?")
    .bind(caseId)
    .first<{ approval_kind: string | null; approval_status: string | null }>();
  const verdict = exchangeGateVerdict(row);
  if (verdict === "allow") return null;
  if (verdict === "pending") {
    return { status: 409, error: "This 1-to-1 exchange is waiting for approval. Nothing was created; an approver must approve it first." };
  }
  if (verdict === "rejected") {
    return { status: 409, error: "The exchange for this case was rejected. Nothing was created; request a new approval on the case first." };
  }
  await fileApprovalRequest(c, caseId, "EXCHANGE", "Auto-filed: a replacement unit was requested for this case");
  return { status: 409, error: "A 1-to-1 exchange needs approval. An approval request has been filed for this case and nothing was created. Retry after it is approved." };
}
