// ---------------------------------------------------------------------------
// dashboard-service-slice.ts — the "Service (Zamri)" slice of GET
// /api/dashboard/prototype. Kept out of dashboard-prototype.ts to keep that
// (heavily shared) file's diff to a hook.
//
// AGE DEFINITION: a case's age is whole days from service_cases.created_at (the
// day the case was logged) to now, counted while it is still OPEN or
// IN_PROGRESS. There is no due-date column on service_cases (checked in
// tests/db-schema.json), so "overdue" = age > SERVICE_OVERDUE_DAYS.
// ---------------------------------------------------------------------------
import { ensureApprovalColumns } from "./service-approval";
import { parseCauses, parseProductLabels } from "./service-issue-stats";

/** Open/in-progress cases older than this many days are flagged overdue. */
export const SERVICE_OVERDUE_DAYS = 3;

const OPEN_STATUSES = new Set(["OPEN", "IN_PROGRESS"]);
const DAY_MS = 86_400_000;

export type ServiceCaseLite = {
  id: string;
  caseNo: string | null;
  customer: string | null;
  status: string;
  createdDate: string; // YYYY-MM-DD
  closedDate: string | null;
  issue: string;
  approvalKind: string | null;
  approvalStatus: string | null;
  causes: string[]; // distinct root-cause categories; [] = not yet analysed
  unit: string | null; // responsibleunit
  prevention: string | null; // prevention_status
  products: string[]; // affected product labels (max 10)
  ageDays: number | null; // only for OPEN / IN_PROGRESS
  daysOverdue: number; // 0 unless open past the threshold
};

export type ServiceSlice = { overdueAfterDays: number; cases: ServiceCaseLite[] };

/** Pure: whole days a still-open case has been open, and how far past the threshold. */
export function caseAging(
  status: string,
  createdAt: string | null | undefined,
  now: Date,
): { ageDays: number | null; daysOverdue: number } {
  if (!OPEN_STATUSES.has(status) || !createdAt) return { ageDays: null, daysOverdue: 0 };
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return { ageDays: null, daysOverdue: 0 };
  const ageDays = Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
  return { ageDays, daysOverdue: Math.max(0, ageDays - SERVICE_OVERDUE_DAYS) };
}

const dateOf = (v: unknown): string | null => {
  if (!v) return null;
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};

type Row = Record<string, unknown>;
const str = (r: Row, snake: string, camel: string): string | null => {
  const v = r[snake] ?? r[camel];
  return v == null ? null : String(v);
};

// rootcauses (0169) / responsibleunit (0166) are runtime-added: the SELECT below
// would throw on a DB where service-cases.ts never ran, so ensure them the same
// way that route does (idempotent, failure swallowed, once per isolate).
let issueColumns = false;
async function ensureIssueColumns(db: D1Database): Promise<void> {
  if (issueColumns) return;
  for (const col of ["responsibleunit", "rootcauses"]) {
    try {
      await db.prepare(`ALTER TABLE service_cases ADD COLUMN IF NOT EXISTS ${col} TEXT`).run();
    } catch {
      // ignore — column may already exist or DDL transiently rejected
    }
  }
  issueColumns = true;
}

export async function buildServiceSlice(
  db: D1Database,
  now: Date = new Date(),
): Promise<ServiceSlice> {
  await ensureApprovalColumns(db);
  await ensureIssueColumns(db);
  const res = await db
    .prepare(
      `SELECT id, case_no, customer_name, status, created_at, closed_at,
              issue_description, approval_kind, approval_status,
              root_cause_category, rootcauses, responsibleunit,
              prevention_status, affected_product_ids
         FROM service_cases
        ORDER BY created_at DESC
        LIMIT 3000`,
    )
    .all<Row>();
  const cases = (res.results ?? []).flatMap((r): ServiceCaseLite[] => {
    const createdDate = dateOf(r.created_at ?? r.createdAt);
    if (!createdDate) return [];
    const status = String(r.status ?? "");
    const createdRaw = String(r.created_at ?? r.createdAt);
    return [{
      id: String(r.id),
      caseNo: str(r, "case_no", "caseNo"),
      customer: str(r, "customer_name", "customerName"),
      status,
      createdDate,
      closedDate: dateOf(r.closed_at ?? r.closedAt),
      issue: (str(r, "issue_description", "issueDescription") ?? "").slice(0, 160),
      approvalKind: str(r, "approval_kind", "approvalKind"),
      approvalStatus: str(r, "approval_status", "approvalStatus"),
      // rootcauses / responsibleunit are runtime-added lowercase columns: read dual-keyed.
      causes: parseCauses(r.rootcauses ?? r.rootCauses, r.root_cause_category ?? r.rootCauseCategory),
      unit: str(r, "responsibleunit", "responsibleUnit"),
      prevention: str(r, "prevention_status", "preventionStatus"),
      products: parseProductLabels(r.affected_product_ids ?? r.affectedProductIds),
      ...caseAging(status, createdRaw, now),
    }];
  });
  return { overdueAfterDays: SERVICE_OVERDUE_DAYS, cases };
}
