// ---------------------------------------------------------------------------
// worker-penalties.ts — salary deductions for confirmed worker mistakes (DEV-22).
//
// Ticket DEV-22: a penalty is raised against a production order (or another
// confirmed issue), names one or more responsible workers with an amount each,
// goes through approval, and only then comes off the worker's pay.
//
// Owner's answers (2026-09-30):
//  - Approval is its own right (`worker-penalties:approve`) and the person who
//    raised a penalty may not approve it — except a Super Admin (owner
//    2026-10-01: there is no second approver account, so the owner raises
//    and approves).
//  - The deduction lands in the payroll month of the APPROVAL date. If that
//    month's payroll is already approved, it rolls to the next open month.
//  - Net pay is not clamped at zero — the same rule as salary advances.
//
// Shape of the money, and why:
//  1. Like an advance, a penalty is NOT an earning and NOT a statutory
//     deduction. EPF / SOCSO / EIS / PCB are computed on the same gross as
//     before; the penalty comes off AFTER them, in its own payslip column
//     (`payslips.penalty_deduction_sen`). Folding it into totalDeductionsSen
//     would put a figure in every statutory report that was never remitted.
//  2. The payroll month lives on each LINE, not the header. A penalty naming
//     three workers posts per worker: a worker with no payslip in the month
//     (resigned, not yet joined) cannot be deducted there, so that one line
//     rolls to the next month while the other two post.
//  3. Status: DRAFT -> PENDING_APPROVAL -> APPROVED -> POSTED. POSTED means
//     every line sits on an APPROVED payslip. Approving a payroll month posts
//     its lines; putting the month back to DRAFT un-posts them.
//
// Tables reach prod ONLY through `ensureWorkerPenaltyTables` — migration files
// are inert on deploy in this repo. Columns are snake_case (no
// column-rename-map entry needed); the PG driver hands them back camelCased,
// so every read here is dual-keyed.
// ---------------------------------------------------------------------------

type Stmt = {
  run(): Promise<unknown>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
  first<T = unknown>(): Promise<T | null>;
};

/** The subset of D1Database this module needs (kept narrow so tests can stub). */
interface Runner {
  prepare(sql: string): Stmt & { bind(...args: unknown[]): Stmt };
  batch?(stmts: unknown[]): Promise<Array<{ results?: unknown[] }>>;
}

// ---------------------------------------------------------------------------
// Fresh reads. Hyperdrive caches plain SELECTs at the proxy, so a read right
// after a write can be served the pre-write rows (BUG-HISTORY: the
// /bulk-patch PIC readback). Measured on staging 2026-10-01: after a payroll
// month went back to DRAFT the penalty rows were APPROVED in the database
// while the unchanged list query still returned POSTED. Every read that a
// payroll figure or a status guard depends on goes through here: `batch`
// runs inside a transaction, which Hyperdrive does not cache. Stubs without
// `batch` (tests) fall back to a plain read.
// ---------------------------------------------------------------------------
export async function freshAll<T>(db: Runner, stmt: Stmt): Promise<T[]> {
  if (typeof db.batch === "function") {
    const [res] = await db.batch([stmt]);
    return ((res?.results ?? []) as T[]);
  }
  const res = await stmt.all<T>();
  return res.results ?? [];
}

export async function freshFirst<T>(db: Runner, stmt: Stmt): Promise<T | null> {
  const rows = await freshAll<T>(db, stmt);
  return rows[0] ?? null;
}

export const PENALTY_DRAFT = "DRAFT";
export const PENALTY_PENDING = "PENDING_APPROVAL";
export const PENALTY_APPROVED = "APPROVED";
export const PENALTY_POSTED = "POSTED";
export const PENALTY_STATUSES = [
  PENALTY_DRAFT,
  PENALTY_PENDING,
  PENALTY_APPROVED,
  PENALTY_POSTED,
] as const;
export type PenaltyStatus = (typeof PENALTY_STATUSES)[number];

/** Header statuses whose lines count toward payroll. */
export const PENALTY_PAYROLL_STATUSES: readonly string[] = [PENALTY_APPROVED, PENALTY_POSTED];

export type PenaltyLine = {
  id: string;
  penaltyId: string;
  workerId: string;
  empNo: string;
  workerName: string;
  departmentCode: string;
  /** Integer sen. */
  amountSen: number;
  /** YYYY-MM the deduction belongs to; empty until the penalty is approved. */
  payrollPeriod: string;
  /** The payslip that carried the deduction; empty until payroll is generated. */
  payslipId: string;
  postedAt: string;
};

export type PenaltyRecord = {
  id: string;
  penaltyNo: string;
  /** YYYY-MM-DD — when the mistake happened / was confirmed. */
  penaltyDate: string;
  productionOrderId: string;
  poNo: string;
  salesOrderNo: string;
  customerName: string;
  productCode: string;
  productName: string;
  quantity: number | null;
  reason: string;
  remarks: string;
  status: string;
  createdBy: string;
  createdByName: string;
  submittedAt: string;
  approvedBy: string;
  approvedByName: string;
  approvedAt: string;
  rejectedReason: string;
  createdAt: string;
  updatedAt: string;
  lines: PenaltyLine[];
  totalSen: number;
};

type Dual<T extends string, U extends string> = { [K in T]?: unknown } & { [K in U]?: unknown };

export type PenaltyRow = { id: string } & Dual<
  | "penaltyNo" | "penaltyDate" | "productionOrderId" | "poNo" | "salesOrderNo"
  | "customerName" | "productCode" | "productName" | "quantity" | "reason"
  | "remarks" | "status" | "createdBy" | "createdByName" | "submittedAt"
  | "approvedBy" | "approvedByName" | "approvedAt" | "rejectedReason"
  | "createdAt" | "updatedAt",
  | "penalty_no" | "penalty_date" | "production_order_id" | "po_no" | "sales_order_no"
  | "customer_name" | "product_code" | "product_name" | "quantity" | "reason"
  | "remarks" | "status" | "created_by" | "created_by_name" | "submitted_at"
  | "approved_by" | "approved_by_name" | "approved_at" | "rejected_reason"
  | "created_at" | "updated_at"
>;

export type PenaltyLineRow = { id: string } & Dual<
  | "penaltyId" | "workerId" | "empNo" | "workerName" | "departmentCode"
  | "amountSen" | "payrollPeriod" | "payslipId" | "postedAt",
  | "penalty_id" | "worker_id" | "emp_no" | "worker_name" | "department_code"
  | "amount_sen" | "payroll_period" | "payslip_id" | "posted_at"
>;

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function rowToPenaltyLine(r: PenaltyLineRow): PenaltyLine {
  return {
    id: r.id,
    penaltyId: str(r.penaltyId ?? r.penalty_id),
    workerId: str(r.workerId ?? r.worker_id),
    empNo: str(r.empNo ?? r.emp_no),
    workerName: str(r.workerName ?? r.worker_name),
    departmentCode: str(r.departmentCode ?? r.department_code),
    // A SUM or text-typed stub can arrive as a string — coerce so the
    // arithmetic never becomes string concatenation.
    amountSen: num(r.amountSen ?? r.amount_sen),
    payrollPeriod: str(r.payrollPeriod ?? r.payroll_period),
    payslipId: str(r.payslipId ?? r.payslip_id),
    postedAt: str(r.postedAt ?? r.posted_at),
  };
}

export function rowToPenalty(r: PenaltyRow, lines: PenaltyLine[] = []): PenaltyRecord {
  const qty = r.quantity;
  return {
    id: r.id,
    penaltyNo: str(r.penaltyNo ?? r.penalty_no),
    penaltyDate: str(r.penaltyDate ?? r.penalty_date),
    productionOrderId: str(r.productionOrderId ?? r.production_order_id),
    poNo: str(r.poNo ?? r.po_no),
    salesOrderNo: str(r.salesOrderNo ?? r.sales_order_no),
    customerName: str(r.customerName ?? r.customer_name),
    productCode: str(r.productCode ?? r.product_code),
    productName: str(r.productName ?? r.product_name),
    quantity: qty === null || qty === undefined || qty === "" ? null : num(qty),
    reason: str(r.reason),
    remarks: str(r.remarks),
    status: str(r.status) || PENALTY_DRAFT,
    createdBy: str(r.createdBy ?? r.created_by),
    createdByName: str(r.createdByName ?? r.created_by_name),
    submittedAt: str(r.submittedAt ?? r.submitted_at),
    approvedBy: str(r.approvedBy ?? r.approved_by),
    approvedByName: str(r.approvedByName ?? r.approved_by_name),
    approvedAt: str(r.approvedAt ?? r.approved_at),
    rejectedReason: str(r.rejectedReason ?? r.rejected_reason),
    createdAt: str(r.createdAt ?? r.created_at),
    updatedAt: str(r.updatedAt ?? r.updated_at),
    lines,
    totalSen: lines.reduce((s, l) => s + l.amountSen, 0),
  };
}

// ---------------------------------------------------------------------------
// Runtime self-apply. Awaited at the top of every handler that reads or writes
// these tables, and by the payroll paths that bind the payslips column.
// ---------------------------------------------------------------------------
const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS worker_penalties (
     id                  TEXT PRIMARY KEY,
     penalty_no          TEXT NOT NULL,
     penalty_date        TEXT NOT NULL,
     production_order_id TEXT,
     po_no               TEXT,
     sales_order_no      TEXT,
     customer_name       TEXT,
     product_code        TEXT,
     product_name        TEXT,
     quantity            INTEGER,
     reason              TEXT NOT NULL,
     remarks             TEXT,
     status              TEXT NOT NULL DEFAULT 'DRAFT',
     created_by          TEXT,
     created_by_name     TEXT,
     submitted_at        TIMESTAMPTZ,
     approved_by         TEXT,
     approved_by_name    TEXT,
     approved_at         TIMESTAMPTZ,
     rejected_reason     TEXT,
     org_id              TEXT NOT NULL DEFAULT 'hookka',
     created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at          TIMESTAMPTZ
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_penalties_no ON worker_penalties (penalty_no)`,
  `CREATE INDEX IF NOT EXISTS idx_worker_penalties_status ON worker_penalties (status)`,
  `CREATE INDEX IF NOT EXISTS idx_worker_penalties_po ON worker_penalties (production_order_id)`,
  `CREATE TABLE IF NOT EXISTS worker_penalty_lines (
     id              TEXT PRIMARY KEY,
     penalty_id      TEXT NOT NULL,
     worker_id       TEXT NOT NULL,
     emp_no          TEXT,
     worker_name     TEXT,
     department_code TEXT,
     amount_sen      INTEGER NOT NULL,
     payroll_period  TEXT,
     payslip_id      TEXT,
     posted_at       TIMESTAMPTZ,
     org_id          TEXT NOT NULL DEFAULT 'hookka',
     created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_worker_penalty_lines_penalty ON worker_penalty_lines (penalty_id)`,
  `CREATE INDEX IF NOT EXISTS idx_worker_penalty_lines_period ON worker_penalty_lines (payroll_period)`,
  `CREATE INDEX IF NOT EXISTS idx_worker_penalty_lines_worker ON worker_penalty_lines (worker_id)`,
  // The generated payslip CARRIES the figure it was computed with, so a later
  // edit to a penalty can never move an approved net pay. Legacy rows read 0.
  `ALTER TABLE payslips ADD COLUMN IF NOT EXISTS penalty_deduction_sen INTEGER NOT NULL DEFAULT 0`,
];

let _applied = false;

/**
 * Memoised as a BOOLEAN, never the in-flight promise: a rejected promise would
 * stay cached and one transient failure would disable this for the isolate.
 */
export async function ensureWorkerPenaltyTables(db: Runner): Promise<void> {
  if (_applied) return;
  for (const sql of DDL) await db.prepare(sql).run();
  _applied = true;
}

/** For tests — reset the module-level memo between cases. */
export function _resetWorkerPenaltyTablesMemoForTests(): void {
  _applied = false;
}

// ---------------------------------------------------------------------------
// Pure helpers — the parts payroll depends on, testable without a database.
// ---------------------------------------------------------------------------

const PERIOD_RE = /^\d{4}-\d{2}$/;

/** "2026-12" -> "2027-01". */
export function nextPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

/** Today's date in Malaysia (GMT+8) as YYYY-MM-DD — payroll months are local. */
export function todayYmdMalaysia(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * The payroll month an approval lands in: the approval date's month, or the
 * first month after it whose payroll is not yet approved. `lockedPeriods` is
 * every YYYY-MM holding a non-DRAFT payslip.
 */
export function payrollPeriodForApproval(
  approvalYmd: string,
  lockedPeriods: ReadonlySet<string>,
): string {
  let p = approvalYmd.slice(0, 7);
  if (!PERIOD_RE.test(p)) throw new Error(`bad approval date: ${approvalYmd}`);
  // Bounded: a run of more than five years of locked months is a data problem,
  // not a reason to spin.
  for (let i = 0; i < 60 && lockedPeriods.has(p); i++) p = nextPeriod(p);
  return p;
}

/**
 * Is this approval refused because the approver raised the penalty? A Super
 * Admin may approve their own; every other role needs a second person.
 */
export function selfApprovalBlocked(
  approverId: string,
  createdBy: string,
  approverRole: string,
): boolean {
  if (!approverId || !createdBy || approverId !== createdBy) return false;
  return (approverRole || "").toUpperCase() !== "SUPER_ADMIN";
}

/** Sum of line amounts per worker. */
export function sumPenaltySenByWorker(lines: Pick<PenaltyLine, "workerId" | "amountSen">[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) {
    if (!l.workerId) continue;
    out.set(l.workerId, (out.get(l.workerId) ?? 0) + (Number(l.amountSen) || 0));
  }
  return out;
}

/**
 * Net pay after advances AND penalties. Neither is statutory; both come off
 * after the statutory block. NOT clamped: a negative figure is money the worker
 * owes, and hiding it is how a debt gets silently written off.
 */
export function netPayAfterAdvanceAndPenaltySen(
  grossPaySen: number,
  statutoryDeductionsSen: number,
  advanceSen: number,
  penaltySen: number,
): number {
  return grossPaySen - statutoryDeductionsSen - (Number(advanceSen) || 0) - (Number(penaltySen) || 0);
}

export type PenaltyDrift = {
  workerId: string;
  employeeName: string;
  expectedSen: number;
  onPayslipSen: number;
};

/**
 * Workers whose stored payslip disagrees with the penalties approved for the
 * month. Only workers WITH a payslip are compared — one without a slip is
 * rolled forward at posting, not a disagreement.
 */
export function computePenaltyDrift(
  expectedByWorker: ReadonlyMap<string, number>,
  payslips: { employeeId: string; employeeName: string; penaltyDeductionSen: number }[],
): PenaltyDrift[] {
  const out: PenaltyDrift[] = [];
  for (const p of payslips) {
    const expected = expectedByWorker.get(p.employeeId) ?? 0;
    const onSlip = Number(p.penaltyDeductionSen) || 0;
    if (expected !== onSlip) {
      out.push({ workerId: p.employeeId, employeeName: p.employeeName, expectedSen: expected, onPayslipSen: onSlip });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// DB reads / writes shared by the penalty route and the payroll route.
// ---------------------------------------------------------------------------

/**
 * Lines of approved / posted penalties whose deduction belongs to `period`.
 *
 * Resilient: a missing table (cold isolate, database predating the feature)
 * returns an empty list so payroll still generates. A missing penalty is a
 * wrong number; a 500 is no payroll at all.
 */
export async function loadPeriodPenaltyLines(db: Runner, period: string): Promise<PenaltyLine[]> {
  if (!PERIOD_RE.test(period)) return [];
  try {
    const rows = await freshAll<PenaltyLineRow>(
      db,
      db
        .prepare(
          `SELECT l.id, l.penalty_id, l.worker_id, l.emp_no, l.worker_name, l.department_code,
                  l.amount_sen, l.payroll_period, l.payslip_id, l.posted_at
             FROM worker_penalty_lines l
             JOIN worker_penalties p ON p.id = l.penalty_id
            WHERE l.payroll_period = ? AND p.status IN ('APPROVED', 'POSTED')
            ORDER BY l.id`,
        )
        .bind(period),
    );
    return rows.map(rowToPenaltyLine);
  } catch (e) {
    console.warn("[worker-penalties] period read skipped:", e);
    return [];
  }
}

/** Per-worker penalty sen for a payroll month — used by generate AND projected. */
export async function loadPeriodPenaltySen(db: Runner, period: string): Promise<Map<string, number>> {
  return sumPenaltySenByWorker(await loadPeriodPenaltyLines(db, period));
}

/** Stamp the generated payslip id on the worker's lines for the month. */
export async function linkPenaltyLinesToPayslip(
  db: Runner,
  period: string,
  workerId: string,
  payslipId: string,
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE worker_penalty_lines SET payslip_id = ?
          WHERE payroll_period = ? AND worker_id = ?
            AND penalty_id IN (SELECT id FROM worker_penalties WHERE status IN ('APPROVED', 'POSTED'))`,
      )
      .bind(payslipId, period, workerId)
      .run();
  } catch (e) {
    console.warn("[worker-penalties] payslip link skipped:", e);
  }
}

/** Every YYYY-MM holding a payslip that is no longer DRAFT. */
export async function loadLockedPayrollPeriods(db: Runner): Promise<Set<string>> {
  const rows = await freshAll<{ period: string }>(
    db,
    db.prepare("SELECT DISTINCT period FROM payslips WHERE status <> 'DRAFT'"),
  );
  return new Set(rows.map((r) => str(r.period)).filter((p) => PERIOD_RE.test(p)));
}

/** Stored payslips for the month disagreeing with its approved penalties. */
export async function findPenaltyDrift(db: Runner, period: string): Promise<PenaltyDrift[]> {
  const expected = await loadPeriodPenaltySen(db, period);
  const rows = await freshAll<{ employeeId?: string; employee_id?: string; employeeName?: string; employee_name?: string; penaltyDeductionSen?: number; penalty_deduction_sen?: number }>(
    db,
    // SELECT *: penalty_deduction_sen is runtime-added, so the CI schema
    // snapshot cannot list it.
    db.prepare("SELECT * FROM payslips WHERE period = ?").bind(period),
  );
  const slips = rows.map((r) => ({
    employeeId: str(r.employeeId ?? r.employee_id),
    employeeName: str(r.employeeName ?? r.employee_name),
    penaltyDeductionSen: num(r.penaltyDeductionSen ?? r.penalty_deduction_sen),
  }));
  return computePenaltyDrift(expected, slips);
}

/**
 * Re-derive header status from its lines after a posting change: POSTED when
 * every line is posted, else APPROVED. Only touches APPROVED / POSTED headers.
 */
async function refreshPostedHeaders(db: Runner, penaltyIds: string[]): Promise<void> {
  for (const id of penaltyIds) {
    const row = await freshFirst<{ total: number | string; posted: number | string }>(
      db,
      db
        .prepare(
          `SELECT COUNT(*) AS total, COUNT(posted_at) AS posted
             FROM worker_penalty_lines WHERE penalty_id = ?`,
        )
        .bind(id),
    );
    const total = num(row?.total);
    const posted = num(row?.posted);
    const status = total > 0 && posted === total ? PENALTY_POSTED : PENALTY_APPROVED;
    await db
      .prepare(
        `UPDATE worker_penalties SET status = ?, updated_at = now()
          WHERE id = ? AND status IN ('APPROVED', 'POSTED') AND status <> ?`,
      )
      .bind(status, id, status)
      .run();
  }
}

/**
 * Payroll month approved (posted = true) or put back to DRAFT (false).
 *
 * Approve: every line of the month whose worker HAS a payslip is posted
 * against it; a line whose worker has none is rolled to the next month (it
 * cannot be deducted from a slip that does not exist). Back to DRAFT: the
 * month's posted lines are un-posted. Rolled lines stay rolled — the next
 * month is where they will be deducted either way.
 */
export async function postPenaltiesForPeriod(
  db: Runner,
  period: string,
  posted: boolean,
): Promise<{ posted: number; rolled: number }> {
  if (!PERIOD_RE.test(period)) return { posted: 0, rolled: 0 };
  const lines = await loadPeriodPenaltyLines(db, period);
  if (lines.length === 0) return { posted: 0, rolled: 0 };
  const touched = new Set<string>();
  let postedCount = 0;
  let rolled = 0;
  if (posted) {
    const slipRows = await freshAll<{ id: string; employeeId?: string; employee_id?: string }>(
      db,
      db.prepare("SELECT id, employeeId FROM payslips WHERE period = ?").bind(period),
    );
    const slipByWorker = new Map(
      slipRows.map((s) => [str(s.employeeId ?? s.employee_id), s.id] as const),
    );
    for (const l of lines) {
      const slipId = slipByWorker.get(l.workerId);
      if (slipId) {
        if (l.postedAt) continue;
        await db
          .prepare(
            `UPDATE worker_penalty_lines SET payslip_id = ?, posted_at = now() WHERE id = ?`,
          )
          .bind(slipId, l.id)
          .run();
        postedCount++;
      } else {
        await db
          .prepare(
            `UPDATE worker_penalty_lines SET payroll_period = ?, payslip_id = NULL, posted_at = NULL WHERE id = ?`,
          )
          .bind(nextPeriod(period), l.id)
          .run();
        rolled++;
      }
      touched.add(l.penaltyId);
    }
  } else {
    for (const l of lines) {
      if (!l.postedAt) continue;
      await db
        .prepare(`UPDATE worker_penalty_lines SET posted_at = NULL WHERE id = ?`)
        .bind(l.id)
        .run();
      touched.add(l.penaltyId);
    }
  }
  await refreshPostedHeaders(db, [...touched]);
  return { posted: postedCount, rolled };
}

/** Lines + headers for a set of penalty ids, joined in memory. */
export async function loadPenaltiesWithLines(db: Runner, headers: PenaltyRow[]): Promise<PenaltyRecord[]> {
  if (headers.length === 0) return [];
  const ids = headers.map((h) => h.id);
  const placeholders = ids.map(() => "?").join(", ");
  const lineRows = await freshAll<PenaltyLineRow>(
    db,
    db
      .prepare(
        `SELECT id, penalty_id, worker_id, emp_no, worker_name, department_code,
                amount_sen, payroll_period, payslip_id, posted_at
           FROM worker_penalty_lines
          WHERE penalty_id IN (${placeholders})
          ORDER BY emp_no, id`,
      )
      .bind(...ids),
  );
  const byPenalty = new Map<string, PenaltyLine[]>();
  for (const raw of lineRows) {
    const l = rowToPenaltyLine(raw);
    const arr = byPenalty.get(l.penaltyId) ?? [];
    arr.push(l);
    byPenalty.set(l.penaltyId, arr);
  }
  return headers.map((h) => rowToPenalty(h, byPenalty.get(h.id) ?? []));
}

export const PENALTY_HEADER_COLS =
  "id, penalty_no, penalty_date, production_order_id, po_no, sales_order_no, customer_name, " +
  "product_code, product_name, quantity, reason, remarks, status, created_by, created_by_name, " +
  "submitted_at, approved_by, approved_by_name, approved_at, rejected_reason, created_at, updated_at";
