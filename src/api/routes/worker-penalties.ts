// ---------------------------------------------------------------------------
// worker_penalties route — DEV-22 Worker Penalty.
//
//   GET    /api/worker-penalties?status=&period=&q=      — list
//   GET    /api/worker-penalties/order-lookup?q=         — search production orders
//   GET    /api/worker-penalties/order-lookup/:id        — one order + its job-card PICs
//   GET    /api/worker-penalties/:id                     — one penalty
//   POST   /api/worker-penalties                         — create (DRAFT, or submit:true)
//   PUT    /api/worker-penalties/:id                     — edit (DRAFT only)
//   DELETE /api/worker-penalties/:id                     — remove (DRAFT only)
//   POST   /api/worker-penalties/:id/submit              — DRAFT -> PENDING_APPROVAL
//   POST   /api/worker-penalties/:id/approve             — PENDING_APPROVAL -> APPROVED
//   POST   /api/worker-penalties/:id/reject              — PENDING_APPROVAL -> DRAFT
//   POST   /api/worker-penalties/:id/revoke              — APPROVED -> DRAFT (nothing posted yet)
//
// Gated on its own resource, `worker-penalties`, with `approve` as a separate
// right; the raiser cannot approve their own unless they are a Super Admin.
// The order lookup lives HERE rather than reusing /api/production-orders
// because HR, who raises penalties, holds no production-orders right — and
// should not be handed the whole production board just to pick an order.
//
// The money maths and the payroll hook are in ../lib/worker-penalties.ts.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { emitAudit } from "../lib/audit";
import {
  ensureWorkerPenaltyTables,
  loadPenaltiesWithLines,
  loadLockedPayrollPeriods,
  payrollPeriodForApproval,
  todayYmdMalaysia,
  selfApprovalBlocked,
  freshAll,
  freshFirst,
  PENALTY_HEADER_COLS,
  PENALTY_DRAFT,
  PENALTY_PENDING,
  PENALTY_APPROVED,
  PENALTY_STATUSES,
  type PenaltyRow,
  type PenaltyRecord,
} from "../lib/worker-penalties";

const app = new Hono<Env>();
const RES = "worker-penalties";

const ctxGet = (c: Context<Env>, k: string): string =>
  (c as unknown as { get: (k: string) => string | undefined }).get(k) ?? "";

function genId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/** YYYY-MM-DD, and a real calendar date (not 2026-02-31). */
function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Integer sen, above zero. A fractional sen is a leaked float — refused, not rounded. */
function parseAmountSen(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

const text = (v: unknown, max = 2000): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

async function userDisplayName(c: Context<Env>, userId: string): Promise<string> {
  if (!userId) return "";
  try {
    const u = await c.var.DB.prepare("SELECT displayName FROM users WHERE id = ? LIMIT 1")
      .bind(userId)
      .first<{ displayName?: string | null }>();
    return (u?.displayName ?? "").toString();
  } catch {
    return "";
  }
}

async function loadOne(c: Context<Env>, id: string): Promise<PenaltyRecord | null> {
  // Fresh: every status guard (submit / approve / revoke / edit) reads through
  // here right after another request may have written the row.
  const row = await freshFirst<PenaltyRow>(
    c.var.DB,
    c.var.DB.prepare(`SELECT ${PENALTY_HEADER_COLS} FROM worker_penalties WHERE id = ?`).bind(id),
  );
  if (!row) return null;
  const [rec] = await loadPenaltiesWithLines(c.var.DB, [row]);
  return rec;
}

/** `WP-YYMM-NNN`, numbered within the month the penalty was created. */
async function nextPenaltyNo(c: Context<Env>): Promise<string> {
  const ymd = todayYmdMalaysia();
  const prefix = `WP-${ymd.slice(2, 4)}${ymd.slice(5, 7)}-`;
  // Fresh: a cached read would hand out the number just taken, and the
  // unique-index retry would read the same stale row again.
  const row = await freshFirst<{ penaltyNo?: string; penalty_no?: string }>(
    c.var.DB,
    c.var.DB.prepare(
      "SELECT penalty_no FROM worker_penalties WHERE penalty_no LIKE ? ORDER BY penalty_no DESC LIMIT 1",
    ).bind(`${prefix}%`),
  );
  const last = (row?.penaltyNo ?? row?.penalty_no ?? "").slice(prefix.length);
  const n = (Number.parseInt(last, 10) || 0) + 1;
  return `${prefix}${String(n).padStart(3, "0")}`;
}

type LineInput = { workerId: string; amountSen: number };
type ParsedBody = {
  penaltyDate: string;
  productionOrderId: string;
  poNo: string;
  customerName: string;
  reason: string;
  remarks: string;
  lines: LineInput[];
};

/** Validate the create / edit body. Returns an error string on failure. */
function parseBody(body: Record<string, unknown>): ParsedBody | string {
  const penaltyDate = text(body.penaltyDate, 10);
  if (!isIsoDate(penaltyDate)) return "Date (YYYY-MM-DD) is required";
  const reason = text(body.reason);
  if (!reason) return "Reason for penalty is required";
  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  if (rawLines.length === 0) return "Select at least one responsible worker";
  const seen = new Set<string>();
  const lines: LineInput[] = [];
  for (const raw of rawLines) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const workerId = text(r.workerId, 100);
    if (!workerId) return "Every line needs a worker";
    if (seen.has(workerId)) return "The same worker is listed twice";
    seen.add(workerId);
    const amountSen = parseAmountSen(r.amountSen);
    if (amountSen === null) return "Every worker needs a penalty amount above zero (whole sen)";
    lines.push({ workerId, amountSen });
  }
  return {
    penaltyDate,
    productionOrderId: text(body.productionOrderId, 100),
    poNo: text(body.poNo, 100),
    customerName: text(body.customerName, 300),
    reason,
    remarks: text(body.remarks),
    lines,
  };
}

type OrderSnapshot = {
  poNo: string;
  salesOrderNo: string;
  customerName: string;
  productCode: string;
  productName: string;
  quantity: number | null;
};

/**
 * The order details are copied from production_orders on the SERVER, so the
 * penalty carries what the order actually said rather than what a client sent.
 * Without an order id (an issue not tied to one production order) the typed
 * order no. / customer are kept as entered.
 */
async function orderSnapshot(c: Context<Env>, p: ParsedBody): Promise<OrderSnapshot | string> {
  if (!p.productionOrderId) {
    return {
      poNo: p.poNo,
      salesOrderNo: "",
      customerName: p.customerName,
      productCode: "",
      productName: "",
      quantity: null,
    };
  }
  const o = await c.var.DB.prepare(
    `SELECT id, po_no, sales_order_no, customer_name, product_code, product_name, quantity
       FROM production_orders WHERE id = ?`,
  )
    .bind(p.productionOrderId)
    .first<Record<string, unknown>>();
  if (!o) return "Production order not found";
  const s = (a: unknown, b: unknown) => String(a ?? b ?? "");
  const q = o.quantity;
  return {
    poNo: s(o.poNo, o.po_no),
    salesOrderNo: s(o.salesOrderNo, o.sales_order_no),
    customerName: s(o.customerName, o.customer_name),
    productCode: s(o.productCode, o.product_code),
    productName: s(o.productName, o.product_name),
    quantity: q === null || q === undefined ? null : Number(q) || 0,
  };
}

type WorkerSnap = { id: string; empNo: string; name: string; departmentCode: string };

async function loadWorkers(c: Context<Env>, ids: string[]): Promise<Map<string, WorkerSnap> | string> {
  const placeholders = ids.map(() => "?").join(", ");
  const res = await c.var.DB.prepare(
    `SELECT id, empNo, name, departmentCode FROM workers WHERE id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<{ id: string; empNo?: string; emp_no?: string; name?: string; departmentCode?: string; department_code?: string }>();
  const out = new Map<string, WorkerSnap>();
  for (const w of res.results ?? []) {
    out.set(w.id, {
      id: w.id,
      empNo: String(w.empNo ?? w.emp_no ?? ""),
      name: String(w.name ?? ""),
      departmentCode: String(w.departmentCode ?? w.department_code ?? ""),
    });
  }
  const missing = ids.filter((id) => !out.has(id));
  if (missing.length) return `Worker not found: ${missing.join(", ")}`;
  return out;
}

async function writeLines(
  c: Context<Env>,
  penaltyId: string,
  lines: LineInput[],
  workers: Map<string, WorkerSnap>,
): Promise<void> {
  await c.var.DB.prepare("DELETE FROM worker_penalty_lines WHERE penalty_id = ?").bind(penaltyId).run();
  for (const l of lines) {
    const w = workers.get(l.workerId)!;
    await c.var.DB.prepare(
      `INSERT INTO worker_penalty_lines
         (id, penalty_id, worker_id, emp_no, worker_name, department_code, amount_sen, org_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(genId("wpl"), penaltyId, l.workerId, w.empNo, w.name, w.departmentCode || null, l.amountSen, getOrgId(c))
      .run();
  }
}

function conflict(c: Context<Env>, error: string) {
  return c.json({ success: false, error }, 409);
}

// ---------------------------------------------------------------------------
// GET /  — list. Filters: status, period (payroll month of any line), q, workerId
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const denied = await requirePermission(c, RES, "read");
  if (denied) return denied;
  await ensureWorkerPenaltyTables(c.var.DB);
  const status = (c.req.query("status") ?? "").trim().toUpperCase();
  const period = (c.req.query("period") ?? "").trim();
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const workerId = (c.req.query("workerId") ?? "").trim();

  const clauses: string[] = [];
  const binds: string[] = [];
  if ((PENALTY_STATUSES as readonly string[]).includes(status)) {
    clauses.push("status = ?");
    binds.push(status);
  }
  if (/^\d{4}-\d{2}$/.test(period)) {
    clauses.push("id IN (SELECT penalty_id FROM worker_penalty_lines WHERE payroll_period = ?)");
    binds.push(period);
  }
  if (workerId) {
    clauses.push("id IN (SELECT penalty_id FROM worker_penalty_lines WHERE worker_id = ?)");
    binds.push(workerId);
  }
  if (q) {
    clauses.push(
      `(LOWER(penalty_no) LIKE ? OR LOWER(COALESCE(po_no, '')) LIKE ? OR LOWER(COALESCE(customer_name, '')) LIKE ?
        OR LOWER(reason) LIKE ?
        OR id IN (SELECT penalty_id FROM worker_penalty_lines WHERE LOWER(COALESCE(worker_name, '')) LIKE ? OR LOWER(COALESCE(emp_no, '')) LIKE ?))`,
    );
    const like = `%${q}%`;
    binds.push(like, like, like, like, like, like);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  // Fresh: the list is what the operator re-reads right after an action.
  const headerRows = await freshAll<PenaltyRow>(
    c.var.DB,
    c.var.DB.prepare(
      `SELECT ${PENALTY_HEADER_COLS} FROM worker_penalties${where}
        ORDER BY penalty_date DESC, penalty_no DESC LIMIT 500`,
    ).bind(...binds),
  );
  const data = await loadPenaltiesWithLines(c.var.DB, headerRows);

  // Status counts over the whole table, so the filter chips can show them.
  const countRows = await freshAll<{ status: string; n: number | string }>(
    c.var.DB,
    c.var.DB.prepare("SELECT status, COUNT(*) AS n FROM worker_penalties GROUP BY status"),
  );
  const counts: Record<string, number> = {};
  for (const r of countRows) counts[r.status] = Number(r.n) || 0;

  return c.json({ success: true, data, total: data.length, counts });
});

// ---------------------------------------------------------------------------
// GET /order-lookup?q=  — production orders to raise a penalty against.
// Registered before "/:id" so "order-lookup" is not read as an id.
// ---------------------------------------------------------------------------
app.get("/order-lookup", async (c) => {
  const denied = await requirePermission(c, RES, "create");
  if (denied) return denied;
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const binds: string[] = [];
  let where = "";
  if (q) {
    const like = `%${q}%`;
    where = `WHERE LOWER(COALESCE(po_no, '')) LIKE ? OR LOWER(COALESCE(sales_order_no, '')) LIKE ?
               OR LOWER(COALESCE(customer_name, '')) LIKE ? OR LOWER(COALESCE(product_code, '')) LIKE ?
               OR LOWER(COALESCE(product_name, '')) LIKE ?`;
    binds.push(like, like, like, like, like);
  }
  const res = await c.var.DB.prepare(
    `SELECT id, po_no, sales_order_no, customer_name, product_code, product_name, quantity,
            item_category, size_label, fabric_code, status, current_department, completed_date, created_at
       FROM production_orders ${where}
      ORDER BY created_at DESC NULLS LAST, po_no DESC
      LIMIT 30`,
  )
    .bind(...binds)
    .all<Record<string, unknown>>();
  const s = (a: unknown, b: unknown) => (a ?? b ?? "") as string;
  const data = (res.results ?? []).map((o) => ({
    id: String(o.id),
    poNo: s(o.poNo, o.po_no),
    salesOrderNo: s(o.salesOrderNo, o.sales_order_no),
    customerName: s(o.customerName, o.customer_name),
    productCode: s(o.productCode, o.product_code),
    productName: s(o.productName, o.product_name),
    quantity: Number(o.quantity) || 0,
    itemCategory: s(o.itemCategory, o.item_category),
    sizeLabel: s(o.sizeLabel, o.size_label),
    fabricCode: s(o.fabricCode, o.fabric_code),
    status: s(o.status, o.status),
    currentDepartment: s(o.currentDepartment, o.current_department),
    completedDate: s(o.completedDate, o.completed_date),
  }));
  return c.json({ success: true, data });
});

// ---------------------------------------------------------------------------
// GET /order-lookup/:id  — the order plus each department's job card and who
// worked it (pic1 / pic2). Those PICs are offered as the suggested responsible
// workers — the person who scanned the stage complete is usually who to ask.
// ---------------------------------------------------------------------------
app.get("/order-lookup/:id", async (c) => {
  const denied = await requirePermission(c, RES, "create");
  if (denied) return denied;
  const id = c.req.param("id");
  const o = await c.var.DB.prepare(
    `SELECT id, po_no, sales_order_no, customer_name, product_code, product_name, quantity,
            item_category, size_label, fabric_code, special_order, notes, status, current_department,
            start_date, completed_date
       FROM production_orders WHERE id = ?`,
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!o) return c.json({ success: false, error: "Production order not found" }, 404);
  const jc = await c.var.DB.prepare(
    `SELECT id, department_code, department_name, sequence, wip_label, status,
            pic1_id, pic1_name, pic2_id, pic2_name, completed_date
       FROM job_cards WHERE production_order_id = ?
      ORDER BY sequence`,
  )
    .bind(id)
    .all<Record<string, unknown>>();
  const s = (a: unknown, b: unknown) => (a ?? b ?? "") as string;
  const jobCards = (jc.results ?? []).map((j) => ({
    id: String(j.id),
    departmentCode: s(j.departmentCode, j.department_code),
    departmentName: s(j.departmentName, j.department_name),
    wipLabel: s(j.wipLabel, j.wip_label),
    status: s(j.status, j.status),
    pic1Id: s(j.pic1Id, j.pic1_id),
    pic1Name: s(j.pic1Name, j.pic1_name),
    pic2Id: s(j.pic2Id, j.pic2_id),
    pic2Name: s(j.pic2Name, j.pic2_name),
    completedDate: s(j.completedDate, j.completed_date),
  }));
  // One suggestion per worker, carrying every department they touched.
  const suggested = new Map<string, { workerId: string; name: string; departments: string[] }>();
  for (const j of jobCards) {
    for (const [pid, pname] of [[j.pic1Id, j.pic1Name], [j.pic2Id, j.pic2Name]] as const) {
      if (!pid) continue;
      const cur = suggested.get(pid) ?? { workerId: pid, name: pname, departments: [] };
      if (j.departmentCode && !cur.departments.includes(j.departmentCode)) cur.departments.push(j.departmentCode);
      suggested.set(pid, cur);
    }
  }
  return c.json({
    success: true,
    data: {
      order: {
        id: String(o.id),
        poNo: s(o.poNo, o.po_no),
        salesOrderNo: s(o.salesOrderNo, o.sales_order_no),
        customerName: s(o.customerName, o.customer_name),
        productCode: s(o.productCode, o.product_code),
        productName: s(o.productName, o.product_name),
        quantity: Number(o.quantity) || 0,
        itemCategory: s(o.itemCategory, o.item_category),
        sizeLabel: s(o.sizeLabel, o.size_label),
        fabricCode: s(o.fabricCode, o.fabric_code),
        specialOrder: s(o.specialOrder, o.special_order),
        notes: s(o.notes, o.notes),
        status: s(o.status, o.status),
        currentDepartment: s(o.currentDepartment, o.current_department),
        startDate: s(o.startDate, o.start_date),
        completedDate: s(o.completedDate, o.completed_date),
      },
      jobCards,
      suggestedWorkers: [...suggested.values()],
    },
  });
});

// ---------------------------------------------------------------------------
// GET /:id
// ---------------------------------------------------------------------------
app.get("/:id", async (c) => {
  const denied = await requirePermission(c, RES, "read");
  if (denied) return denied;
  await ensureWorkerPenaltyTables(c.var.DB);
  const rec = await loadOne(c, c.req.param("id"));
  if (!rec) return c.json({ success: false, error: "Not found" }, 404);
  return c.json({ success: true, data: rec });
});

// ---------------------------------------------------------------------------
// POST /  — create. Body: { penaltyDate, productionOrderId?, poNo?, customerName?,
// reason, remarks?, lines: [{ workerId, amountSen }], submit? }
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  const denied = await requirePermission(c, RES, "create");
  if (denied) return denied;
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
  const parsed = parseBody(body);
  if (typeof parsed === "string") return c.json({ success: false, error: parsed }, 400);
  const snap = await orderSnapshot(c, parsed);
  if (typeof snap === "string") return c.json({ success: false, error: snap }, 400);
  const workers = await loadWorkers(c, parsed.lines.map((l) => l.workerId));
  if (typeof workers === "string") return c.json({ success: false, error: workers }, 400);

  // Before the first write — the tables exist on prod only because of this.
  await ensureWorkerPenaltyTables(c.var.DB);

  const userId = ctxGet(c, "userId");
  const userName = await userDisplayName(c, userId);
  const submit = body.submit === true;
  const id = genId("wpn");
  let penaltyNo = await nextPenaltyNo(c);
  const insert = (no: string) =>
    c.var.DB.prepare(
      `INSERT INTO worker_penalties
         (id, penalty_no, penalty_date, production_order_id, po_no, sales_order_no, customer_name,
          product_code, product_name, quantity, reason, remarks, status, created_by, created_by_name,
          submitted_at, org_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${submit ? "now()" : "NULL"}, ?)`,
    )
      .bind(
        id, no, parsed.penaltyDate, parsed.productionOrderId || null, snap.poNo || null,
        snap.salesOrderNo || null, snap.customerName || null, snap.productCode || null,
        snap.productName || null, snap.quantity, parsed.reason, parsed.remarks || null,
        submit ? PENALTY_PENDING : PENALTY_DRAFT, userId || null, userName || null, getOrgId(c),
      )
      .run();
  try {
    await insert(penaltyNo);
  } catch {
    // Two penalties created in the same instant can draw the same number; the
    // unique index refuses the second, which simply takes the next one.
    penaltyNo = await nextPenaltyNo(c);
    await insert(penaltyNo);
  }
  await writeLines(c, id, parsed.lines, workers);
  const rec = await loadOne(c, id);
  await emitAudit(c, { resource: RES, resourceId: id, action: submit ? "submit" : "create", after: rec });
  return c.json({ success: true, data: rec }, 201);
});

// ---------------------------------------------------------------------------
// PUT /:id  — edit while DRAFT (a rejected penalty comes back as DRAFT too).
// ---------------------------------------------------------------------------
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, RES, "update");
  if (denied) return denied;
  await ensureWorkerPenaltyTables(c.var.DB);
  const id = c.req.param("id");
  const before = await loadOne(c, id);
  if (!before) return c.json({ success: false, error: "Not found" }, 404);
  if (before.status !== PENALTY_DRAFT) {
    return conflict(c, `Only a draft can be edited — this penalty is ${before.status.replace(/_/g, " ").toLowerCase()}.`);
  }
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
  const parsed = parseBody(body);
  if (typeof parsed === "string") return c.json({ success: false, error: parsed }, 400);
  const snap = await orderSnapshot(c, parsed);
  if (typeof snap === "string") return c.json({ success: false, error: snap }, 400);
  const workers = await loadWorkers(c, parsed.lines.map((l) => l.workerId));
  if (typeof workers === "string") return c.json({ success: false, error: workers }, 400);

  await c.var.DB.prepare(
    `UPDATE worker_penalties
        SET penalty_date = ?, production_order_id = ?, po_no = ?, sales_order_no = ?, customer_name = ?,
            product_code = ?, product_name = ?, quantity = ?, reason = ?, remarks = ?, updated_at = now()
      WHERE id = ? AND status = 'DRAFT'`,
  )
    .bind(
      parsed.penaltyDate, parsed.productionOrderId || null, snap.poNo || null, snap.salesOrderNo || null,
      snap.customerName || null, snap.productCode || null, snap.productName || null, snap.quantity,
      parsed.reason, parsed.remarks || null, id,
    )
    .run();
  await writeLines(c, id, parsed.lines, workers);
  const after = await loadOne(c, id);
  await emitAudit(c, { resource: RES, resourceId: id, action: "update", before, after });
  return c.json({ success: true, data: after });
});

// ---------------------------------------------------------------------------
// DELETE /:id  — drafts only. Anything that has been submitted is evidence.
// ---------------------------------------------------------------------------
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, RES, "delete");
  if (denied) return denied;
  await ensureWorkerPenaltyTables(c.var.DB);
  const id = c.req.param("id");
  const before = await loadOne(c, id);
  if (!before) return c.json({ success: false, error: "Not found" }, 404);
  if (before.status !== PENALTY_DRAFT) return conflict(c, "Only a draft can be deleted.");
  await c.var.DB.prepare("DELETE FROM worker_penalty_lines WHERE penalty_id = ?").bind(id).run();
  await c.var.DB.prepare("DELETE FROM worker_penalties WHERE id = ? AND status = 'DRAFT'").bind(id).run();
  await emitAudit(c, { resource: RES, resourceId: id, action: "delete", before });
  return c.json({ success: true, data: { id } });
});

// ---------------------------------------------------------------------------
// POST /:id/submit  — DRAFT -> PENDING_APPROVAL
// ---------------------------------------------------------------------------
app.post("/:id/submit", async (c) => {
  const denied = await requirePermission(c, RES, "update");
  if (denied) return denied;
  await ensureWorkerPenaltyTables(c.var.DB);
  const id = c.req.param("id");
  const before = await loadOne(c, id);
  if (!before) return c.json({ success: false, error: "Not found" }, 404);
  if (before.status !== PENALTY_DRAFT) return conflict(c, "Only a draft can be submitted.");
  if (before.lines.length === 0) return c.json({ success: false, error: "Select at least one responsible worker" }, 400);
  await c.var.DB.prepare(
    `UPDATE worker_penalties SET status = 'PENDING_APPROVAL', submitted_at = now(), rejected_reason = NULL, updated_at = now()
      WHERE id = ? AND status = 'DRAFT'`,
  )
    .bind(id)
    .run();
  const after = await loadOne(c, id);
  await emitAudit(c, { resource: RES, resourceId: id, action: "submit", before, after });
  return c.json({ success: true, data: after });
});

// ---------------------------------------------------------------------------
// POST /:id/approve  — PENDING_APPROVAL -> APPROVED, and the payroll month is
// fixed: the approval date's month, or the next one whose payroll is still open.
// ---------------------------------------------------------------------------
app.post("/:id/approve", async (c) => {
  const denied = await requirePermission(c, RES, "approve");
  if (denied) return denied;
  await ensureWorkerPenaltyTables(c.var.DB);
  const id = c.req.param("id");
  const before = await loadOne(c, id);
  if (!before) return c.json({ success: false, error: "Not found" }, 404);
  if (before.status !== PENALTY_PENDING) return conflict(c, "Only a penalty pending approval can be approved.");
  const userId = ctxGet(c, "userId");
  if (selfApprovalBlocked(userId, before.createdBy, ctxGet(c, "userRole"))) {
    return c.json(
      { success: false, error: "You raised this penalty, so someone else (or a Super Admin) has to approve it." },
      403,
    );
  }
  const period = payrollPeriodForApproval(todayYmdMalaysia(), await loadLockedPayrollPeriods(c.var.DB));
  const userName = await userDisplayName(c, userId);
  await c.var.DB.prepare(
    `UPDATE worker_penalties
        SET status = 'APPROVED', approved_by = ?, approved_by_name = ?, approved_at = now(), updated_at = now()
      WHERE id = ? AND status = 'PENDING_APPROVAL'`,
  )
    .bind(userId || null, userName || null, id)
    .run();
  await c.var.DB.prepare(
    "UPDATE worker_penalty_lines SET payroll_period = ?, payslip_id = NULL, posted_at = NULL WHERE penalty_id = ?",
  )
    .bind(period, id)
    .run();
  const after = await loadOne(c, id);
  await emitAudit(c, { resource: RES, resourceId: id, action: "approve", before, after });
  return c.json({ success: true, data: after, payrollPeriod: period });
});

// ---------------------------------------------------------------------------
// POST /:id/reject  — PENDING_APPROVAL -> DRAFT, with the reason kept on it.
// ---------------------------------------------------------------------------
app.post("/:id/reject", async (c) => {
  const denied = await requirePermission(c, RES, "approve");
  if (denied) return denied;
  await ensureWorkerPenaltyTables(c.var.DB);
  const id = c.req.param("id");
  const before = await loadOne(c, id);
  if (!before) return c.json({ success: false, error: "Not found" }, 404);
  if (before.status !== PENALTY_PENDING) return conflict(c, "Only a penalty pending approval can be rejected.");
  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json();
  } catch {
    /* reason is optional */
  }
  const reason = text(body.reason, 1000);
  await c.var.DB.prepare(
    `UPDATE worker_penalties SET status = 'DRAFT', rejected_reason = ?, submitted_at = NULL, updated_at = now()
      WHERE id = ? AND status = 'PENDING_APPROVAL'`,
  )
    .bind(reason || "Rejected", id)
    .run();
  const after = await loadOne(c, id);
  await emitAudit(c, { resource: RES, resourceId: id, action: "reject", before, after });
  return c.json({ success: true, data: after });
});

// ---------------------------------------------------------------------------
// POST /:id/revoke  — APPROVED -> DRAFT, only while no line has been posted to
// an approved payroll. Once posted it is a signed-off deduction: un-approve the
// payroll month first.
// ---------------------------------------------------------------------------
app.post("/:id/revoke", async (c) => {
  const denied = await requirePermission(c, RES, "approve");
  if (denied) return denied;
  await ensureWorkerPenaltyTables(c.var.DB);
  const id = c.req.param("id");
  const before = await loadOne(c, id);
  if (!before) return c.json({ success: false, error: "Not found" }, 404);
  if (before.status !== PENALTY_APPROVED || before.lines.some((l) => l.postedAt)) {
    return conflict(
      c,
      "Only an approved penalty that is not yet posted can be revoked. If its payroll month is approved, put that month back to Draft first.",
    );
  }
  await c.var.DB.prepare(
    `UPDATE worker_penalties
        SET status = 'DRAFT', approved_by = NULL, approved_by_name = NULL, approved_at = NULL,
            submitted_at = NULL, updated_at = now()
      WHERE id = ? AND status = 'APPROVED'`,
  )
    .bind(id)
    .run();
  await c.var.DB.prepare(
    "UPDATE worker_penalty_lines SET payroll_period = NULL, payslip_id = NULL, posted_at = NULL WHERE penalty_id = ?",
  )
    .bind(id)
    .run();
  const after = await loadOne(c, id);
  await emitAudit(c, { resource: RES, resourceId: id, action: "revoke", before, after });
  return c.json({ success: true, data: after });
});

export default app;
