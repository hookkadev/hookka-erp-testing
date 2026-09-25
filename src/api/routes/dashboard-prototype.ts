// ---------------------------------------------------------------------------
// Dashboard prototype feed — real figures for the /dashboard-experimental
// page, which until now rendered a seeded sample generator.
//
// Mounted at /api/dashboard/prototype. Read-only: every statement here is a
// SELECT, and the route registers no mutating handler.
//
// SHAPE
// -----
// The prototype aggregates its own months/days out of a flat per-day series,
// so this endpoint hands back the same shape rather than finished KPIs. That
// keeps the reconciliation the prototype already enforces (every chart sums
// to its headline) working against real rows instead of generated ones — the
// arithmetic is unchanged, only the input is.
//
// WHAT IS AND IS NOT COVERED
// --------------------------
// Sales and Employee are backed by real tables. Delivery, Inventory and
// Purchase are NOT, and this endpoint says so explicitly in `availability`
// instead of quietly returning zeroes — a zero is indistinguishable from
// "no data" on a chart, and the whole point of the switch to live data was
// that the numbers can be trusted.
//
// MEASURED 2026-08-26 against the live DB (org 'hookka'), so the caller knows
// what to expect rather than guessing:
//
//   sales_orders        1,532 rows, 2026-04-22 → 2026-08-26, ~300/month.
//                       Seven live statuses; READY_TO_SHIP is over half.
//   attendance_records  3,153 rows, 2025-08-20 → 2026-08-26. EVERY row is
//                       status PRESENT — absence and leave are not in this
//                       table, they live in leave_records.
//   workers                42 (37 ACTIVE, 4 RESIGNED, 1 INACTIVE)
//
// Three measurements that contradict what the prototype assumed, and that the
// payload therefore carries explicitly rather than leaving to a hardcoded
// constant on the page:
//
//   • The efficiency target is 100%, not 85% — workers.efficiencyThresholdPct
//     is 100 for 39 of 42 (the other three are 0, i.e. unset).
//   • A working day is 9 hours, not 8 — working_hours_per_day is 9 for 38 of
//     42 (one is 7.5, three are 0).
//   • efficiency_pct is recorded on only 1,468 of 3,153 rows (46.6%), and the
//     coverage is wildly uneven by month: 1/679 in May, 226/791 in June,
//     884/890 in July, 357/729 in August (August is mid-month). Where it IS
//     recorded the spread is tight — p25 94, median 96, p75 97, mean 94.2 —
//     nothing like the 48-129 spread the generator produced.
//
// PER-WORKER OUTPUT IS NOT AVAILABLE and is not faked here. attendance_records
// has no unit count, and job_cards cannot stand in for one: it holds zero
// completions before 2026-08-14, so any "units produced" series built from it
// would read as a factory that made nothing for three months.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { getOrgId } from "../lib/tenant";
import { requirePermission, hasPermission, dashboardReadsFor } from "../lib/rbac";
import { buildServiceSlice } from "../lib/dashboard-service-slice";
import { isCustomerScoped } from "../lib/customer-scope";
import { collectOnTimeDelivery, EMPTY_ON_TIME } from "../lib/on-time-delivery";
import { poInPlanning, poReadyForDelivery, type PipelinePO } from "../../lib/delivery-pipeline";
import { loadPoValueMap, loadDoValueMap } from "../lib/do-value";
import { buildDailySlice } from "../lib/dashboard-daily-slice";
import { countsToHeadcount } from "../lib/headcount-rule";

const app = new Hono<Env>();

// Sales-order statuses, in pipeline order. Taken from the live table rather
// than invented: a status the data does not use would render an empty rail,
// and one the data DOES use but this list omits would silently vanish from a
// chart that claims to total the whole book. Anything unrecognised is still
// returned (see buildPipeline) so the second failure cannot happen.
const SO_PIPELINE_ORDER = [
  "IN_PRODUCTION",
  "READY_TO_SHIP",
  "SHIPPED",
  "DELIVERED",
  "INVOICED",
  "CLOSED",
  "CANCELLED",
];

type SoRow = {
  id: string;
  // The OFFICIAL SO date. The house Command Center buckets its monthly revenue
  // on this, while created_at is when the row was entered — the two disagree
  // whenever an order is back-dated, which is why the two surfaces can report
  // different months for the same order. Carried so the difference can be
  // measured rather than argued about.
  companySODate: string | null;
  companySO: string | null;
  // See the DoRow comment above — same drift, same table family. Read this,
  // not company_so, for anything shown as "the SO number."
  companySOId: string | null;
  customerName: string | null;
  status: string | null;
  totalSen: number | string | null;
  createdAt: string | null;
  customerDeliveryDate: string | null;
  hookkaExpectedDD: string | null;
  isServiceOrder: boolean | number | null;
  customerState: string | null;
};

type SoItemCatRow = {
  salesOrderId: string;
  itemCategory: string | null;
  productCode: string | null;
  productName: string | null;
  quantity: number | string | null;
  lineTotalSen: number | string | null;
};

type AttRow = {
  employeeId: string | null;
  employeeName: string | null;
  departmentCode: string | null;
  date: string | null;
  clockIn: string | null;
  clockOut: string | null;
  status: string | null;
  workingMinutes: number | string | null;
  productionTimeMinutes: number | string | null;
  overtimeMinutes: number | string | null;
  efficiencyPct: number | string | null;
};

type WorkerRow = {
  id: string;
  empNo: string | null;
  name: string | null;
  departmentCode: string | null;
  position: string | null;
  status: string | null;
  efficiencyThresholdPct: number | string | null;
  workingHoursPerDay: number | string | null;
};

// The commonest non-zero value across the workforce. A zero in either column
// means "not configured for this worker", not "this worker's target is nil",
// so zeroes are excluded before taking the mode — otherwise three unset rows
// would drag a factory-wide constant to 0 and every derived percentage with it.
function modeOf(values: number[], fallback: number): number {
  const counts = new Map<number, number>();
  for (const v of values) {
    if (!Number.isFinite(v) || v <= 0) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best = fallback;
  let bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return best;
}

type DoRow = {
  id: string;
  doNo: string | null;
  status: string | null;
  createdAt: string | null;
  deliveryDate: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  driverName: string | null;
  vehicleNo: string | null;
  totalItems: number | string | null;
  companySO: string | null;
  // company_so drifted (owner-visible, MEASURED 2026-08-27): recent rows carry
  // a human label there ("Sales Order 303") while company_so_id keeps the
  // strict "SO-2608-303" reference — the real Sales/Delivery pages already
  // read companySOId exclusively for exactly this reason. Prefer it here too.
  companySOId: string | null;
  customerName: string | null;
};

type PoRow = {
  id: string;
  poNo: string | null;
  supplierName: string | null;
  status: string | null;
  orderDate: string | null;
  expectedDate: string | null;
  receivedDate: string | null;
  totalSen: number | string | null;
  subtotalSen: number | string | null;
  notes: string | null;
};

type PoItemRow = {
  purchaseOrderId: string;
  materialCode: string | null;
  supplierSKU: string | null;
  materialName: string | null;
  unit: string | null;
  quantity: number | string | null;
  receivedQty: number | string | null;
  unitPriceSen: number | string | null;
  totalSen: number | string | null;
  lineNo: number | string | null;
};

type ProdOrdRow = {
  id: string;
  poNo: string | null;
  salesOrderId: string | null;
  customerName: string | null;
  productCode: string | null;
  productName: string | null;
  itemCategory: string | null;
  sizeLabel: string | null;
  quantity: number | string | null;
  status: string | null;
  currentDepartment: string | null;
  progress: number | string | null;
  targetEndDate: string | null;
  completedDate: string | null;
  // Free text ("HB Fully Cover, Divan Bottom Fully Cover") or "" — NOT a
  // boolean column. `specialOrder: !!r.specialOrder` below only cares
  // whether it's non-empty; the pipeline predicates below need the actual
  // text (isHbOnlySpecial checks its wording), so keep the raw string.
  specialOrder: string | null;
  consignmentOrderId: string | null;
  repairscope: string | null;
};

type RmRow = {
  id: string;
  itemCode: string | null;
  description: string | null;
  itemGroup: string | null;
  baseUom: string | null;
  balanceQty: number | string | null;
  minStock: number | string | null;
  isActive: boolean | number | null;
};

// Overdue tiers for the PO register, in the order the risk bar draws them.
// `days` is how far PAST its expected date an unreceived PO is.
const PO_TIERS: Array<{ key: string; label: string; test: (d: number) => boolean }> = [
  { key: "ontrack", label: "On track", test: (d) => d <= 0 },
  { key: "minor", label: "1-7 days late", test: (d) => d >= 1 && d <= 7 },
  { key: "moderate", label: "8-14 days late", test: (d) => d >= 8 && d <= 14 },
  { key: "critical", label: "15+ days late", test: (d) => d >= 15 },
];

// What the house Command Center counts as revenue-bearing: every SO except
// DRAFT / CANCELLED / ON_HOLD (dashboard-overview.ts:516 —
// `status NOT IN ('DRAFT','CANCELLED','ON_HOLD')`). Kept as one predicate so
// the count and the money can never drift apart, and so the next person can
// see WHY these three are out rather than inferring it from a filter.
const NON_REVENUE_STATUSES = new Set(["DRAFT", "CANCELLED", "ON_HOLD"]);
const isConfirmed = (status: string | null | undefined): boolean =>
  !NON_REVENUE_STATUSES.has((status ?? "").toUpperCase());

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Run one section's query, and turn a failure into an EMPTY result plus a
 * reason rather than a 500.
 *
 * This route's SQL cannot be executed anywhere but production — there is no
 * database password available to this project, only a service_role SELECT key
 * through PostgREST — so the first real run of any statement here is a user
 * loading the page. If one of five sections has a bad query, the honest
 * outcome is four working views and one that says why it is empty, not a blank
 * page. The caller marks the section `live: false` with this reason attached,
 * which is the same path an un-wired view already takes.
 */
async function section<T>(
  label: string,
  run: () => Promise<T[]>,
): Promise<{ rows: T[]; error: string | null }> {
  try {
    return { rows: (await run()) ?? [], error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[dashboard-prototype] ${label} failed:`, msg);
    return { rows: [], error: `${label} query failed: ${msg}` };
  }
}

// Postgres hands back `date` as a Date or an ISO string depending on driver
// and column type; both collapse to YYYY-MM-DD here so the day key is one
// thing everywhere downstream.
const dayKey = (v: unknown): string | null => {
  if (!v) return null;
  const s = typeof v === "string" ? v : new Date(v as string).toISOString();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
};

app.get("/", async (c) => {
  // sales-orders:read remains the front-door gate — Sales Orders is the tab
  // that opens by default and every viewer of this dashboard needs it. Now
  // that the other five tabs are wired up in the frontend (2026-09-10), a
  // caller who lacks a SECTION's own permission (delivery-orders / purchase-
  // orders / inventory / workers / production-orders) must not receive that
  // section's data just because they can see Sales — see the redaction pass
  // right before the response is built, same "drop it, don't refuse the
  // whole page" doctrine hasPermission's own doc describes.
  //
  // A TAB-RESTRICTED role (DASHBOARD_TABS_BY_ROLE in role-policy.ts, e.g.
  // PRODUCTION) is decided by its tab map instead: it receives exactly the
  // sections its tabs draw on, whatever its module grants say, and nothing
  // else. Its front door opens only if one of its tabs reads Sales.
  const tabReads = dashboardReadsFor(c);
  const canRead = (resource: string) =>
    tabReads ? Promise.resolve(tabReads.has(resource)) : hasPermission(c, resource, "read");

  if (!tabReads?.has("sales-orders")) {
    const denied = await requirePermission(c, "sales-orders", "read");
    if (denied) return denied;
  }

  const [canDelivery, canPurchase, canInventory, canWorkers, canProduction] = await Promise.all([
    canRead("delivery-orders"),
    canRead("purchase-orders"),
    canRead("inventory"),
    canRead("workers"),
    canRead("production-orders"),
  ]);

  // Customer-scoped roles (SALES) must not see the whole case book through a
  // shared, org-wide cached feed, so the slice is dropped for them.
  const canService = (await canRead("service-cases")) && !isCustomerScoped(c);

  const orgId = getOrgId(c);
  const { cached } = await import("../lib/kv-cache");

  // Whole route is read-only (no mutating handler in this file), so a plain
  // 60s SWR cache is safe: no write path needs to invalidate it, and it's
  // the same TTL/mechanism dashboard-overview.ts already uses for the same
  // "many sequential queries on every page load" problem.
  // v2 (2026-09-17): payload gained production.productionCost. A pre-bump
  // body has no such key — exactly what crashed SitiOpsView.tsx on a stale
  // cache hit — bumping makes that window zero instead of waiting out the
  // 60s TTL.
  const rawPayload = await cached(c, `dashboard:prototype:${orgId}:v3`, 60, async () => {
  // ---- Sales ------------------------------------------------------------
  // Whole book, not a window: the prototype owns the month picker, so it
  // needs every month that exists. ~1,500 rows of seven columns is small
  // enough to send whole and keeps this endpoint free of paging state.
  //
  // Fetched UNFILTERED (Service Orders included) on purpose: `soRows` below
  // also feeds the OTIF join further down, and the house on-time-delivery
  // module (on-time-delivery.ts) does NOT filter Service Orders out of its
  // own population. Filtering here would make an SO invisible to that join —
  // it would fall into "no customer date" instead of just being an SO that
  // was never in scope — and would quietly make this page's on-time figure
  // disagree with the one true source. The Sales TAB's own counts (order
  // count, revenue, pipeline) are what actually need the filter; that
  // happens below, on `salesTabRows`, a derived subset.
  const salesSec = await section("sales", () =>
    c.var.DB.prepare(
      `SELECT id, company_so, company_so_id, customer_name, status, total_sen,
              created_at, company_so_date, customer_delivery_date,
              hookka_expected_dd, is_service_order, customer_state
         FROM sales_orders
        WHERE org_id = ?
        ORDER BY created_at ASC`,
    )
      .bind(orgId)
      .all<SoRow>()
      .then((r) => r.results ?? []),
  );
  const soRows = salesSec.rows;
  // MEASURED: 75 of 1,544 rows are Service Orders, 0 NULLs on the column. The
  // Sales tab's own figures (count, revenue, pipeline) use ONLY this subset —
  // `soRows` above stays whole-book because the OTIF join further down needs
  // every order, service or not.
  // Service orders are INCLUDED (owner 2026-09-15). They were excluded here
  // while the house Command Center's monthly revenue has never filtered them,
  // which put this page RM 5,900 below it for Sep 2026 across 11 SV- orders.
  // `isServiceOrder` still rides on every row, so a consumer that wants them
  // split can still split them.
  const salesTabRows = soRows;

  // What the line above THROWS AWAY, published so the exclusion is auditable.
  // The house Command Center's monthly revenue does NOT filter service orders,
  // so a figure here will sit below its figure by exactly this much for the
  // same month — and without this, that difference can only be guessed at.
  const excludedServiceOrders = soRows
    .filter((r) => r.isServiceOrder)
    .map((r) => ({
      no: r.companySOId ?? r.companySO,
      customer: r.customerName,
      status: r.status,
      totalSen: num(r.totalSen),
      createdAt: dayKey(r.createdAt),
      soDate: dayKey(r.companySODate),
    }));

  // Sales Orders view: State x Category x SKU breakdown (Sales Attribution's
  // neighbour, owner 2026-08-28). item_category/product_code/line_total_sen
  // live on sales_order_items, one row per line, NOT on sales_orders itself —
  // this route keeps every query single-table (schema-check only parses
  // single-table SELECTs), so the state/status join happens here in JS
  // against soRows, already loaded above, rather than in SQL.
  // MEASURED 2026-08-28: 2,593 line items, exactly 3 categories in this book
  // (SOFA, BEDFRAME, ACCESSORY) — small enough to aggregate to every
  // (state, category, sku) combo without a payload concern.
  const soItemCatSec = await section("sales order items (category)", () =>
    c.var.DB.prepare(
      `SELECT sales_order_id, item_category, product_code, product_name,
              quantity, line_total_sen
         FROM sales_order_items
        WHERE org_id = ?`,
    )
      .bind(orgId)
      .all<SoItemCatRow>()
      .then((r) => r.results ?? []),
  );
  // Whole-book `soRows`, not `salesTabRows` — a service order's DELIVERY
  // isn't excluded from this data, only Sales Orders view's revenue figures
  // are (they read `salesTabRows`). Excluding them here too, not just
  // CANCELLED, is what keeps this chart reconciling with Revenue trend /
  // Sales Attribution / Sales Forecast on the same view — MEASURED: without
  // it, this aggregate ran 1.44% ahead of the order-level total those three
  // already agree on, entirely from the 75 service-order rows.
  const soStateStatusById = new Map(
    soRows.map((r) => [r.id, { state: r.customerState, status: r.status, isService: !!r.isServiceOrder, date: dayKey(r.createdAt) }]),
  );
  const stateCategorySkuMap = new Map<
    string,
    { date: string | null; state: string; category: string; sku: string; name: string; qty: number; revenueSen: number }
  >();
  // Keyed by the ORDER's createdAt day too, so the Sales view can scope the
  // donut / Top SKUs to the period picker like every other Sales card.
  for (const it of soItemCatSec.rows) {
    const so = soStateStatusById.get(it.salesOrderId);
    if (!so || so.status === "CANCELLED" || so.isService) continue;
    const state = (so.state ?? "").trim() || "(no state)";
    const category = it.itemCategory ?? "(no category)";
    const sku = it.productCode ?? "(no SKU)";
    const key = `${so.date}|${state}|${category}|${sku}`;
    let e = stateCategorySkuMap.get(key);
    if (!e) {
      e = { date: so.date, state, category, sku, name: it.productName ?? sku, qty: 0, revenueSen: 0 };
      stateCategorySkuMap.set(key, e);
    }
    e.qty += num(it.quantity);
    e.revenueSen += num(it.lineTotalSen);
  }

  // Day series. CANCELLED orders are counted but their value is NOT added to
  // revenue — a cancelled order is not money earned, and folding it in would
  // put the trend line above what was actually billed.
  const salesByDay = new Map<
    string,
    { date: string; orders: number; revenueSen: number; cancelled: number }
  >();
  for (const r of salesTabRows) {
    const k = dayKey(r.createdAt);
    if (!k) continue;
    let e = salesByDay.get(k);
    if (!e) salesByDay.set(k, (e = { date: k, orders: 0, revenueSen: 0, cancelled: 0 }));
    // Only confirmed orders reach the count OR the money — a DRAFT is not a
    // sale yet, and counting it in one place but not the other is how the two
    // figures on a card start disagreeing.
    if (isConfirmed(r.status)) {
      e.orders++;
      e.revenueSen += num(r.totalSen);
    } else if ((r.status ?? "").toUpperCase() === "CANCELLED") {
      e.cancelled++;
    }
  }

  // Pipeline. Known statuses keep their pipeline order; anything the data
  // carries that this file has not been told about is appended rather than
  // dropped, so the segments always total the order count above them.
  const byStatus = new Map<string, { status: string; count: number; valueSen: number }>();
  for (const r of salesTabRows) {
    const s = (r.status ?? "UNKNOWN").toUpperCase();
    let e = byStatus.get(s);
    if (!e) byStatus.set(s, (e = { status: s, count: 0, valueSen: 0 }));
    e.count++;
    e.valueSen += num(r.totalSen);
  }
  const pipeline = [
    ...SO_PIPELINE_ORDER.filter((s) => byStatus.has(s)).map((s) => byStatus.get(s)!),
    ...[...byStatus.values()].filter((e) => !SO_PIPELINE_ORDER.includes(e.status)),
  ];

  // ---- Employee ---------------------------------------------------------
  const workersSec = await section("workers", () =>
    c.var.DB.prepare(
      `SELECT id, emp_no, name, department_code, position, status,
              efficiency_threshold_pct, working_hours_per_day
         FROM workers
        ORDER BY name ASC`,
    ).all<WorkerRow>().then((r) => r.results ?? []),
  );

  // Service (Zamri) tab — own file, see dashboard-service-slice.ts.
  const serviceSec = await section("service", async () => [await buildServiceSlice(c.var.DB)]);

  const attSec = await section("attendance", () =>
    c.var.DB.prepare(
      `SELECT employee_id, employee_name, department_code, date,
              clock_in, clock_out, status, working_minutes,
              production_time_minutes, overtime_minutes, efficiency_pct
         FROM attendance_records
        WHERE org_id = ?
        ORDER BY date ASC`,
    )
      .bind(orgId)
      .all<AttRow>()
      .then((r) => r.results ?? []),
  );

  const attendance = attSec.rows
    .map((r) => ({
      employeeId: r.employeeId,
      employeeName: r.employeeName,
      dept: r.departmentCode,
      date: dayKey(r.date),
      clockIn: r.clockIn,
      clockOut: r.clockOut,
      status: r.status,
      workingMinutes: num(r.workingMinutes),
      productionMinutes: num(r.productionTimeMinutes),
      overtimeMinutes: num(r.overtimeMinutes),
      // Deliberately nullable, not coerced to 0: 12% of live rows have no
      // efficiency recorded, and averaging a missing reading as a zero would
      // drag every mean it touches downward. The prototype already knows how
      // to skip a null efficiency day.
      efficiencyPct: r.efficiencyPct == null ? null : num(r.efficiencyPct),
    }))
    .filter((r) => r.date);

  // ---- Workforce performance (the HOUSE metric) -------------------------
  // The Employees page's summary cards do NOT come from attendance_records.
  // They come from /api/department-performance, which is
  // `working_hour_entries` (clocked) + completed `job_cards` (earned), and it
  // is the number the office actually reads. attendance_records.efficiencyPct
  // is a DIFFERENT metric that happens to share the name — averaging it gave
  // 94.1% where the office reads 84%, and no amount of re-averaging converges.
  //
  // VERIFIED against the live Employees page for Aug 2026: this reproduces
  // 5310.3 working hours and 35 workers EXACTLY. Efficiency computes to 83.4%
  // against a screenshot reading 84% — that figure drifts by ±1pp within a
  // single day (124 job cards completed on 2026-08-26 alone) and the source
  // endpoint serves a snapshot, so an exact tie to a screenshot is not
  // expected; the formula is the same one.
  const deptSec = await section("departments", () =>
    c.var.DB.prepare(
      // `sequence` is REQUIRED here, not decorative: it is the canonical floor
      // order the production-tracking stages are sorted by. Omitting it made
      // every stage sort as 0, which silently put Foam Cutting and Foam
      // Bonding at the END of the line instead of positions 4 and 5.
      `SELECT code, is_production, sequence
         FROM departments`,
    )
      .all<{ code: string; isProduction: number | boolean | null; sequence: number | string | null }>()
      .then((r) => r.results ?? []),
  );
  // CANONICAL denominator: isProduction departments only. Warehousing, Repair,
  // Maintenance, Shortfall and R&D clocked hours are real work but are NOT in
  // the efficiency denominator — including them inflates it and pulls the
  // percentage below what the office sees (MEASURED: 6,179.2h all-departments
  // vs 5,310.3h production-only for Aug 2026, an 869h difference).
  const productionDepts = new Set(
    deptSec.rows.filter((d) => d.isProduction).map((d) => d.code),
  );

  const wheSec = await section("working hours", () =>
    c.var.DB.prepare(
      `SELECT worker_id, date, department_code, hours
         FROM working_hour_entries
        WHERE org_id = ?`,
    )
      .bind(orgId)
      .all<{ workerId: string | null; date: string | null; departmentCode: string | null; hours: number | string | null }>()
      .then((r) => r.results ?? []),
  );

  const jcSec = await section("job cards", () =>
    c.var.DB.prepare(
      `SELECT id, department_code, pic1_id, pic2_id, completed_date,
              est_minutes, actual_minutes, wip_qty
         FROM job_cards
        WHERE org_id = ?
          AND status IN ('COMPLETED','TRANSFERRED')
          AND completed_date IS NOT NULL`,
    )
      .bind(orgId)
      .all<{
        id: string; departmentCode: string | null;
        pic1Id: string | null; pic2Id: string | null;
        completedDate: string | null;
        estMinutes: number | string | null; actualMinutes: number | string | null;
        wipQty: number | string | null;
      }>()
      .then((r) => r.results ?? []),
  );

  // Separate from `jcSec` on purpose: that one is filtered to
  // COMPLETED/TRANSFERRED (it feeds the efficiency numerator) and therefore
  // contains no backlog at all. Production tracking needs the unfinished
  // cards, which is the opposite half of the table.
  const jcAllSec = await section("job cards (all)", () =>
    c.var.DB.prepare(
      `SELECT production_order_id, department_code, status, sequence, due_date,
              wip_type, completed_date
         FROM job_cards
        WHERE org_id = ?`,
    )
      .bind(orgId)
      .all<{
        productionOrderId: string | null;
        departmentCode: string | null;
        status: string | null;
        sequence: number | string | null;
        dueDate: string | null;
        wipType: string | null;
        completedDate: string | null;
      }>()
      .then((r) => r.results ?? []),
  );

  const picsSec = await section("piece pics", () =>
    c.var.DB.prepare(
      `SELECT job_card_id, pic1_id, pic2_id FROM piece_pics WHERE org_id = ?`,
    )
      .bind(orgId)
      .all<{ jobCardId: string; pic1Id: string | null; pic2Id: string | null }>()
      .then((r) => r.results ?? []),
  );

  // FAB_CUT stores the per-SET total on the card (wipQty = piece count), every
  // other department stores per-PIECE minutes. Multiplying FAB_CUT by wipQty
  // triple-counts it. Same rule as src/lib/job-card-minutes.ts.
  const jcMinutesTotal = (perUnit: number, dept: string | null, wipQty: number): number =>
    (dept ?? "") === "FAB_CUT" ? perUnit : perUnit * Math.max(1, wipQty || 1);

  const picsByJc = new Map<string, Array<{ pic1: string | null; pic2: string | null }>>();
  for (const p of picsSec.rows) {
    const arr = picsByJc.get(p.jobCardId) ?? [];
    arr.push({ pic1: p.pic1Id, pic2: p.pic2Id });
    picsByJc.set(p.jobCardId, arr);
  }

  // date -> { working, production, allDept } and date -> worker -> { same }.
  // `workingMinutes` stays PRODUCTION-DEPARTMENT-ONLY clocked time (unchanged
  // meaning — it is "Prod Hours" downstream). `allDeptMinutes` is new: EVERY
  // clocked hour that day regardless of department. The difference between
  // the two is time clocked OUTSIDE a production department — MEASURED
  // 2026-08-27 (WANNA HLAING, 2026-08-17): 9.0h all-dept (8.9h under R_AND_D
  // + 0.1h under FOAM) vs 0.1h production-dept-only. Without allDeptMinutes
  // there was no way to show that 8.9h anywhere; "Non-Prod Hours" was instead
  // computed as clocked-minus-earned, which is a DIFFERENT quantity (a
  // shortfall against standard time, not "time spent elsewhere that day") and
  // read as 0h for her precisely because her earned credit (3.33h) exceeded
  // her tiny production-dept clock time.
  const perfByDay = new Map<string, { date: string; workingMinutes: number; productionMinutes: number; allDeptMinutes: number }>();
  const perfByDayWorker = new Map<string, Map<string, { workingMinutes: number; productionMinutes: number; allDeptMinutes: number }>>();
  const perfWorkerIds = new Set<string>();
  const perfDay = (d: string) => {
    let e = perfByDay.get(d);
    if (!e) perfByDay.set(d, (e = { date: d, workingMinutes: 0, productionMinutes: 0, allDeptMinutes: 0 }));
    if (!perfByDayWorker.has(d)) perfByDayWorker.set(d, new Map());
    return e;
  };
  const perfWorker = (d: string, w: string) => {
    const m = perfByDayWorker.get(d)!;
    let e = m.get(w);
    if (!e) m.set(w, (e = { workingMinutes: 0, productionMinutes: 0, allDeptMinutes: 0 }));
    return e;
  };

  for (const r of wheSec.rows) {
    const d = dayKey(r.date);
    if (!d) continue;
    const mins = Math.round(num(r.hours) * 60);
    const dayEntry = perfDay(d);
    dayEntry.allDeptMinutes += mins;
    if (r.workerId) perfWorker(d, r.workerId).allDeptMinutes += mins;
    if (!productionDepts.has(r.departmentCode ?? "")) continue;
    dayEntry.workingMinutes += mins;
    if (r.workerId) {
      perfWorkerIds.add(r.workerId);
      perfWorker(d, r.workerId).workingMinutes += mins;
    }
  }

  let perfCards = 0;
  let perfMeasuredCards = 0;
  for (const jc of jcSec.rows) {
    const d = dayKey(jc.completedDate);
    if (!d) continue;
    perfCards++;
    const actual = jc.actualMinutes == null ? null : num(jc.actualMinutes);
    // A populated actual that EQUALS the standard is a copied estimate, not a
    // measurement — the repo's established provenance test.
    if (actual !== null && actual > 0 && actual !== num(jc.estMinutes)) perfMeasuredCards++;

    const wipQty = num(jc.wipQty);
    // Day total credits the card ONCE, regardless of how many workers are on it.
    perfDay(d).productionMinutes += jcMinutesTotal(
      actual ?? num(jc.estMinutes), jc.departmentCode, wipQty,
    );

    // Per-worker share is keyed on est ?? actual (note the order — it differs
    // from the day total on purpose; mirrors department-performance.ts).
    const jcMins = num(jc.estMinutes) || (actual ?? 0);
    const pieces = picsByJc.get(jc.id) ?? [];
    const perWorker = new Map<string, number>();
    if (pieces.length > 0) {
      const perPiece = (jc.departmentCode ?? "") === "FAB_CUT"
        ? jcMinutesTotal(jcMins, jc.departmentCode, wipQty) / Math.max(1, pieces.length)
        : jcMins;
      for (const s of pieces) {
        const picCount = (s.pic1 ? 1 : 0) + (s.pic2 ? 1 : 0);
        const share = perPiece / Math.max(1, picCount);
        if (s.pic1) perWorker.set(s.pic1, (perWorker.get(s.pic1) ?? 0) + share);
        if (s.pic2) perWorker.set(s.pic2, (perWorker.get(s.pic2) ?? 0) + share);
      }
    } else {
      const picCount = (jc.pic1Id ? 1 : 0) + (jc.pic2Id ? 1 : 0);
      const share = jcMinutesTotal(jcMins, jc.departmentCode, wipQty) / Math.max(1, picCount);
      if (jc.pic1Id) perWorker.set(jc.pic1Id, share);
      if (jc.pic2Id) perWorker.set(jc.pic2Id, share);
    }
    for (const [wid, raw] of perWorker) {
      perfWorkerIds.add(wid);
      perfWorker(d, wid).productionMinutes += Math.round(raw);
    }
  }

  const perfDays = [...perfByDay.values()]
    .map((e) => ({
      ...e,
      workers: [...(perfByDayWorker.get(e.date) ?? new Map()).entries()]
        .map(([workerId, v]) => ({ workerId, ...v })),
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  // ---- Delivery ---------------------------------------------------------
  const deliverySec = await section("delivery", () =>
    c.var.DB.prepare(
      `SELECT id, do_no, status, created_at, delivery_date, dispatched_at,
              delivered_at, driver_name, vehicle_no, total_items,
              company_so, company_so_id, customer_name
         FROM delivery_orders
        WHERE org_id = ?
        ORDER BY created_at ASC`,
    )
      .bind(orgId)
      .all<DoRow>()
      .then((r) => r.results ?? []),
  );
  const doRows = deliverySec.rows;

  // Packing lists group DOs into one trip. Read ONLY to infer a driver for a
  // DO that was dispatched as part of a trip but never got its own
  // driver_name written — MEASURED 2026-08-28: PL-2606-010 has 4 DOs, 2 driven
  // by JIVA and 2 with driver_name/driver_id/vehicle_id/vehicle_no/lorry_id
  // ALL empty, found by cross-referencing packing_lists.doIds against the
  // "Unassigned" bucket below. Conservative on purpose: a list is only used
  // to infer when every driver actually named among its OTHER DOs agrees —
  // a list with two different drivers named, or none at all, is left alone
  // rather than guessed at.
  const packingListSec = await section("packing lists", () =>
    c.var.DB.prepare(`SELECT id, do_ids FROM packing_lists WHERE org_id = ?`)
      .bind(orgId)
      .all<{ id: string; doIds: string | null }>()
      .then((r) => r.results ?? []),
  );
  const inferredDriverByDoId = new Map<string, string>();
  {
    const driverByDoId = new Map(doRows.map((r) => [r.id, r.driverName || null]));
    for (const pl of packingListSec.rows) {
      let ids: string[];
      try {
        ids = JSON.parse(pl.doIds ?? "[]");
      } catch {
        continue;
      }
      const namedDrivers = new Set(
        ids.map((id) => driverByDoId.get(id)).filter((n): n is string => !!n),
      );
      if (namedDrivers.size !== 1) continue; // none named, or they disagree — don't guess
      const driver = [...namedDrivers][0];
      for (const id of ids) {
        if (!driverByDoId.get(id)) inferredDriverByDoId.set(id, driver);
      }
    }
  }

  // On-time delivery is NOT recomputed here. It comes from the house module,
  // which encodes the owner's 2026-08-14 ruling: delivered_at against the
  // SALES ORDER's customer_delivery_date, one verdict per order judged on its
  // last delivery, with every exclusion published. Scoring the DO's own
  // hookka_expected_dd instead — which is what a naive reading of this table
  // invites — is marking our own homework, and that module says so outright.
  // Two surfaces disagreeing about on-time delivery is exactly what reusing it
  // prevents.
  let otif = EMPTY_ON_TIME;
  try {
    const first = doRows.find((r) => r.createdAt)?.createdAt;
    otif = await collectOnTimeDelivery(
      c.var.DB,
      dayKey(first) ?? "1970-01-01",
      dayKey(new Date().toISOString())!,
    );
  } catch {
    // Leave it EMPTY_ON_TIME: onTimePct null, which every renderer must show
    // as "cannot say" rather than as 0%.
  }

  const doByDay = new Map<
    string,
    { date: string; created: number; dispatched: number; delivered: number }
  >();
  const touchDay = (k: string | null) => {
    if (!k) return null;
    let e = doByDay.get(k);
    if (!e) doByDay.set(k, (e = { date: k, created: 0, dispatched: 0, delivered: 0 }));
    return e;
  };
  const lagDays: number[] = [];
  const fleet = new Map<
    string,
    { name: string; dos: number; items: number; delivered: number; firstTimeOk: number; attemptsJudged: number }
  >();
  const bySo = new Map<string, number>();

  for (const r of doRows) {
    const created = touchDay(dayKey(r.createdAt));
    if (created) created.created++;
    const disp = touchDay(dayKey(r.dispatchedAt));
    if (disp) disp.dispatched++;
    const del = touchDay(dayKey(r.deliveredAt));
    if (del) del.delivered++;
    if (r.dispatchedAt && r.deliveredAt) {
      const d = (new Date(r.deliveredAt).getTime() - new Date(r.dispatchedAt).getTime()) / 86400000;
      if (Number.isFinite(d) && d >= 0) lagDays.push(d);
    }
    // A DO with no driver of its own, and no trip-mate to infer one from, is
    // a real state (3PL, customer collect), so it gets its own bucket rather
    // than being dropped out of the workload total.
    const who = r.driverName || inferredDriverByDoId.get(r.id) || "Unassigned";
    let f = fleet.get(who);
    if (!f) fleet.set(who, (f = { name: who, dos: 0, items: 0, delivered: 0, firstTimeOk: 0, attemptsJudged: 0 }));
    f.dos++;
    f.items += num(r.totalItems);
    if (r.deliveredAt) f.delivered++;
    const soKey = r.companySOId ?? r.companySO;
    if (soKey && r.status !== "CANCELLED") {
      bySo.set(soKey, (bySo.get(soKey) ?? 0) + 1);
    }
  }
  lagDays.sort((a, b) => a - b);
  const splitCounts = [...bySo.values()];
  const splitOrders = splitCounts.filter((n) => n > 1).length;

  // Per-driver "first-time success" — same measure as the whole-book split
  // rate above (a sales order that needed only ONE delivery order to
  // fulfill), attributed to the driver instead of the company. There is no
  // delivery-attempt or return table to read this from directly (delivery_
  // returns is empty, measured), so this is the one real, already-computed
  // signal in this data that distinguishes "delivered and done" from
  // "delivered, but the order needed another trip." Needs bySo fully built
  // first, hence a second pass rather than folding into the loop above.
  for (const r of doRows) {
    const who = r.driverName || inferredDriverByDoId.get(r.id) || "Unassigned";
    const f = fleet.get(who);
    if (!f) continue;
    const soKey = r.companySOId ?? r.companySO;
    if (!soKey || r.status === "CANCELLED") continue;
    f.attemptsJudged++;
    if ((bySo.get(soKey) ?? 0) === 1) f.firstTimeOk++;
  }

  // ---- Purchase ---------------------------------------------------------
  const purchaseSec = await section("purchase", () =>
    c.var.DB.prepare(
      `SELECT id, po_no, supplier_name, status, order_date,
              expected_date, received_date, total_sen, subtotal_sen, notes
         FROM purchase_orders
        WHERE org_id = ?
        ORDER BY order_date ASC`,
    )
      .bind(orgId)
      .all<PoRow>()
      .then((r) => r.results ?? []),
  );
  const poRows = purchaseSec.rows;

  // Header rows carry no quantity, so units come from the lines. MEASURED:
  // 407 lines across 174 POs, 151,099 units ordered and 2,896 received — so
  // "units received" is a real and very small number, not a missing one.
  // Full line detail (not just quantity/received_qty) so the register's
  // "click a PO to see its items" card can show the real lines — same shape
  // as the real Purchase Order detail page's items table (Internal Code /
  // Supplier SKU / Description / Unit / Qty / Received / Unit Price / Total).
  const poItemSec = await section("purchase items", () =>
    c.var.DB.prepare(
      `SELECT purchase_order_id, material_code, supplier_sku, material_name,
              unit, quantity, received_qty, unit_price_sen, total_sen, line_no
         FROM purchase_order_items
        WHERE org_id = ?
        ORDER BY purchase_order_id ASC, line_no ASC`,
    )
      .bind(orgId)
      .all<PoItemRow>()
      .then((r) => r.results ?? []),
  );
  const poItemsByPo = new Map<string, PoItemRow[]>();
  for (const it of poItemSec.rows) {
    const arr = poItemsByPo.get(it.purchaseOrderId) ?? [];
    arr.push(it);
    poItemsByPo.set(it.purchaseOrderId, arr);
  }
  const poUnits = new Map<string, { ordered: number; received: number }>();
  for (const it of poItemSec.rows) {
    let e = poUnits.get(it.purchaseOrderId);
    if (!e) poUnits.set(it.purchaseOrderId, (e = { ordered: 0, received: 0 }));
    e.ordered += num(it.quantity);
    e.received += num(it.receivedQty);
  }

  const todayKey = dayKey(new Date().toISOString())!;
  const daysLate = (expected: string | null): number | null => {
    const e = dayKey(expected);
    if (!e) return null;
    return Math.round(
      (Date.parse(todayKey + "T00:00:00Z") - Date.parse(e + "T00:00:00Z")) / 86400000,
    );
  };

  const tierCounts = new Map(PO_TIERS.map((t) => [t.key, { ...t, test: undefined, count: 0, valueSen: 0 }]));
  const poRegister: Array<Record<string, unknown>> = [];
  const supplierAgg = new Map<
    string,
    { name: string; pos: number; valueSen: number; judged: number; onTime: number }
  >();
  const inboundByDay = new Map<string, { date: string; pos: number; valueSen: number; units: number }>();

  const mapPoItems = (poId: string) =>
    (poItemsByPo.get(poId) ?? []).map((it) => ({
      code: it.materialCode, supplierSku: it.supplierSKU, name: it.materialName,
      unit: it.unit, qty: num(it.quantity), received: num(it.receivedQty),
      unitPriceSen: num(it.unitPriceSen), totalSen: num(it.totalSen),
    }));

  for (const r of poRows) {
    const received = dayKey(r.receivedDate);
    const expected = dayKey(r.expectedDate);
    // CANCELLED POs are REGISTERED but not AGGREGATED. They belong in the
    // register (a "Total POs" headline that says 180 has to be backed by 180
    // listable rows — MEASURED: 180 total, 23 cancelled, 157 active), but a
    // cancelled order is not open, not overdue, not inbound, and its value is
    // not supplier spend, so it is excluded from every one of those below.
    if (r.status === "CANCELLED") {
      const uc = poUnits.get(r.id) ?? { ordered: 0, received: 0 };
      poRegister.push({
        id: r.id, no: r.poNo, supplier: r.supplierName || "Unnamed supplier",
        status: r.status, orderDate: dayKey(r.orderDate), expectedDate: expected,
        receivedDate: received, totalSen: num(r.totalSen), daysLate: null,
        tier: "cancelled", cancelled: true,
        unitsOrdered: uc.ordered, unitsReceived: uc.received,
        subtotalSen: num(r.subtotalSen), notes: r.notes,
        items: mapPoItems(r.id),
      });
      continue;
    }
    const late = received ? null : daysLate(r.expectedDate);
    // A PO with no expected date cannot be aged. It is NOT quietly filed as
    // on-track — that would turn a blind spot into a clean bill of health.
    const tierKey = received ? "received" : late == null ? "undated"
      : (PO_TIERS.find((t) => t.test(late))?.key ?? "ontrack");
    const bucket = tierCounts.get(tierKey);
    if (bucket) { bucket.count++; bucket.valueSen += num(r.totalSen); }

    if (expected && !received) {
      let e = inboundByDay.get(expected);
      if (!e) inboundByDay.set(expected, (e = { date: expected, pos: 0, valueSen: 0, units: 0 }));
      e.pos++;
      e.valueSen += num(r.totalSen);
      e.units += (poUnits.get(r.id)?.ordered ?? 0) - (poUnits.get(r.id)?.received ?? 0);
    }

    const sup = r.supplierName || "Unnamed supplier";
    let sa = supplierAgg.get(sup);
    if (!sa) supplierAgg.set(sup, (sa = { name: sup, pos: 0, valueSen: 0, judged: 0, onTime: 0 }));
    sa.pos++;
    sa.valueSen += num(r.totalSen);
    // Only a PO that has actually arrived can be scored for punctuality.
    if (received && expected) { sa.judged++; if (received <= expected) sa.onTime++; }

    const u = poUnits.get(r.id) ?? { ordered: 0, received: 0 };
    poRegister.push({
      id: r.id, no: r.poNo, supplier: sup, status: r.status,
      orderDate: dayKey(r.orderDate), expectedDate: expected, receivedDate: received,
      totalSen: num(r.totalSen), daysLate: late, tier: tierKey, cancelled: false,
      unitsOrdered: u.ordered, unitsReceived: u.received,
      subtotalSen: num(r.subtotalSen), notes: r.notes,
      items: mapPoItems(r.id),
    });
  }

  // ---- Production tracking ----------------------------------------------
  // Order-fulfilment view over the 9 sequential production stages. Everything
  // here is real: production_orders (3,049) -> job_cards (41,732) -> the
  // sales order that carries the CUSTOMER's promised date.
  //
  // Stage order comes from departments.sequence, NOT a list hardcoded here —
  // MEASURED: FAB_CUT(1) FAB_SEW(2) WOOD_CUT(3) FOAM_CUTTING(4) FOAM(5)
  // FRAMING(6) WEBBING(7) UPHOLSTERY(8) PACKING(9). Hardcoding it would go
  // stale the first time the floor is re-sequenced.
  const stageRows = deptSec.rows
    .filter((d) => d.isProduction)
    .map((d) => ({ code: d.code, seq: num(d.sequence) }))
    .sort((a, b) => a.seq - b.seq);

  const prodOrdSec = await section("production orders", () =>
    c.var.DB.prepare(
      `SELECT id, po_no, sales_order_id, customer_name, product_code,
              product_name, item_category, size_label, quantity, status,
              current_department, progress, target_end_date, completed_date,
              special_order, consignment_order_id, repairscope
         FROM production_orders
        WHERE org_id = ?`,
    )
      .bind(orgId)
      .all<ProdOrdRow>()
      .then((r) => r.results ?? []),
  );

  // OPEN = still on the floor. CANCELLED is not work, COMPLETED is done.
  // MEASURED: 476 of 3,049 are open (470 PENDING + 6 IN_PROGRESS).
  const OPEN_PO_STATUSES = (st: string | null) =>
    !!st && !["COMPLETED", "CANCELLED", "CLOSED"].includes(st.toUpperCase());
  const openProdOrders = prodOrdSec.rows.filter((r) => OPEN_PO_STATUSES(r.status));
  const openProdIds = new Set(openProdOrders.map((r) => r.id));

  // Job cards belonging to those open orders. A card is BACKLOG when it has
  // not been completed, transferred or cancelled — i.e. work still to do.
  const stageIdx = new Map(stageRows.map((s, i) => [s.code, i]));
  const backlogByDept = new Map<string, { dept: string; seq: number; cards: number; orders: Set<string> }>();
  for (const st of stageRows) {
    backlogByDept.set(st.code, { dept: st.code, seq: st.seq, cards: 0, orders: new Set() });
  }
  // Per production order: how many of its stages are done, and where it sits.
  const stageProgress = new Map<string, { done: number; total: number; nextDept: string | null; nextSeq: number }>();
  // Per production order, PER DEPARTMENT — the stage-grid card (click a row
  // in "Open production orders"). Mirrors the real production board's own
  // cellFor() (src/pages/production/utils.ts): done/total job cards in that
  // dept, the EARLIEST due date among the unfinished ones (shown on a
  // pending/overdue cell), the LATEST completed date among the finished
  // ones (shown on a done cell) — same fields, same aggregation, so this
  // card can't disagree with what the real board would show for this order.
  type StageCell = { done: number; total: number; earliestDue: string | null; latestCompleted: string | null };
  const stageCells = new Map<string, Map<string, StageCell>>();
  const stageCell = (poId: string, dept: string): StageCell => {
    let m = stageCells.get(poId);
    if (!m) stageCells.set(poId, (m = new Map()));
    let c = m.get(dept);
    if (!c) m.set(dept, (c = { done: 0, total: 0, earliestDue: null, latestCompleted: null }));
    return c;
  };
  for (const jc of jcAllSec.rows) {
    if (!jc.productionOrderId || !openProdIds.has(jc.productionOrderId)) continue;
    const st = (jc.status ?? "").toUpperCase();
    if (st === "CANCELLED") continue;
    let sp = stageProgress.get(jc.productionOrderId);
    if (!sp) stageProgress.set(jc.productionOrderId, (sp = { done: 0, total: 0, nextDept: null, nextSeq: 1e9 }));
    sp.total++;
    const dept = jc.departmentCode ?? "";
    const cell = stageCell(jc.productionOrderId, dept);
    cell.total++;
    if (st === "COMPLETED" || st === "TRANSFERRED") {
      sp.done++;
      const cd = dayKey(jc.completedDate);
      cell.done++;
      if (cd && (!cell.latestCompleted || cd > cell.latestCompleted)) cell.latestCompleted = cd;
    } else {
      const b = backlogByDept.get(dept);
      if (b) { b.cards++; b.orders.add(jc.productionOrderId); }
      // "Current stage" = the EARLIEST unfinished stage in floor sequence,
      // not whichever row happened to come back first.
      const si = stageIdx.get(dept);
      if (si != null && si < sp.nextSeq) { sp.nextSeq = si; sp.nextDept = dept || null; }
      const dd = dayKey(jc.dueDate);
      if (dd && (!cell.earliestDue || dd < cell.earliestDue)) cell.earliestDue = dd;
    }
  }

  const soById = new Map(soRows.map((r) => [r.id, r]));
  const prodOrders = openProdOrders.map((r) => {
    const so = r.salesOrderId ? soById.get(r.salesOrderId) : undefined;
    const customerDD = dayKey(so?.customerDeliveryDate ?? null);
    // Buffer = days from today to the date the CUSTOMER was promised.
    // Negative means already past it while still unfinished.
    const daysToDD = customerDD
      ? Math.round((Date.parse(customerDD + "T00:00:00Z") - Date.parse(todayKey + "T00:00:00Z")) / 86400000)
      : null;
    const sp = stageProgress.get(r.id);
    const stagesDone = sp?.done ?? 0;
    const stagesTotal = sp?.total ?? 0;
    // Prefer the ACTUAL stage completion over production_orders.progress:
    // progress is a stored field that can lag, stage counts are derived from
    // the cards themselves and cannot.
    const pctDone = stagesTotal > 0 ? (stagesDone / stagesTotal) * 100 : num(r.progress);
    const cellsForOrder = stageCells.get(r.id);
    const stages = stageRows.map((s) => {
      const c = cellsForOrder?.get(s.code);
      if (!c || c.total === 0) {
        return { code: s.code, state: "empty" as const, done: 0, total: 0, date: null };
      }
      if (c.done === c.total) {
        return {
          code: s.code, state: "done" as const, done: c.done, total: c.total,
          date: c.latestCompleted ?? c.earliestDue,
        };
      }
      const overdue = !!c.earliestDue && c.earliestDue < todayKey;
      return {
        code: s.code, state: overdue ? ("overdue" as const) : ("pending" as const),
        done: c.done, total: c.total, date: c.earliestDue,
      };
    });
    return {
      id: r.id,
      poNo: r.poNo,
      stages,
      soNo: so?.companySOId ?? so?.companySO ?? r.salesOrderId ?? null,
      customer: r.customerName ?? so?.customerName ?? null,
      productCode: r.productCode,
      productName: r.productName,
      sizeLabel: r.sizeLabel,
      category: r.itemCategory,
      qty: num(r.quantity),
      specialOrder: !!r.specialOrder,
      customerDD,
      expectedDD: dayKey(so?.hookkaExpectedDD ?? null),
      targetEndDate: dayKey(r.targetEndDate),
      daysToDD,
      pctDone,
      stagesDone,
      stagesTotal,
      currentDept: sp?.nextDept ?? r.currentDepartment ?? null,
      status: r.status,
    };
  });

  // Risk banding. Deliberately simple and stated, not a black box: an order
  // already past the customer's date is CRITICAL; one due inside a week with
  // most of its stages still open is AT RISK; everything else is on track.
  const riskOf = (o: { daysToDD: number | null; pctDone: number }) => {
    if (o.daysToDD == null) return "unknown";
    if (o.daysToDD < 0) return "critical";
    if (o.daysToDD <= 7 && o.pctDone < 60) return "atrisk";
    return "ontrack";
  };
  const prodOrdersRisked = prodOrders.map((o) => ({ ...o, risk: riskOf(o) }));
  const bottleneck = [...backlogByDept.values()].reduce(
    (m, x) => (x.cards > (m?.cards ?? -1) ? x : m),
    null as { dept: string; seq: number; cards: number; orders: Set<string> } | null,
  );

  // ---- Siti's list (draft, 2026-09-17) -----------------------------------
  // Owner's next-up report checklist, handed over on paper. Derived entirely
  // from data already loaded above — no new queries except the one extra
  // column (completed_date) added to prodOrdSec's SELECT. Draft-quality by
  // request: covers what's cheaply and honestly derivable now; Production
  // Cost needs cost_ledger, which nothing in this route touches yet, so it's
  // left as an explicit gap below rather than a guessed number.

  // "全部 department 的 overdue" — every OPEN order already past the
  // customer's promised date (risk === critical, same predicate the
  // Production tab's risk banding uses), grouped by its current department.
  const overdueByDept = (() => {
    const m = new Map<string, number>();
    for (const o of prodOrdersRisked) {
      if (o.risk !== "critical") continue;
      const k = o.currentDept || "(no dept)";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()]
      .map(([department, count]) => ({ department, count }))
      .sort((a, b) => b.count - a.count);
  })();

  // "要 overdue 的 - 3 天前" — early warning: not yet overdue, but the
  // customer date is within the next 3 days and most stages are still open
  // (same "at risk" shape riskOf() already uses, narrowed to a 3-day window
  // instead of 7).
  const dueSoon3Days = prodOrdersRisked
    .filter((o) => o.daysToDD != null && o.daysToDD >= 0 && o.daysToDD <= 3)
    .sort((a, b) => (a.daysToDD ?? 0) - (b.daysToDD ?? 0));

  // "Daily Production Output" — units and orders that finished each day.
  // Reads the WHOLE prodOrdSec.rows (not openProdOrders, which excludes
  // anything COMPLETED by definition), so this is the one place in the file
  // that looks at completed orders' own rows rather than their job cards.
  const dailyOutput = (() => {
    const m = new Map<string, { date: string; orders: number; units: number }>();
    for (const r of prodOrdSec.rows) {
      if ((r.status ?? "").toUpperCase() !== "COMPLETED") continue;
      const d = dayKey(r.completedDate);
      if (!d) continue;
      let e = m.get(d);
      if (!e) m.set(d, (e = { date: d, orders: 0, units: 0 }));
      e.orders++;
      e.units += num(r.quantity);
    }
    return [...m.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  })();

  // "Production Plan vs Actual" — for completed orders that carry both
  // dates: targetEndDate (plan) vs completedDate (actual). Positive
  // varianceDays = finished late. Orders missing either date are excluded
  // rather than silently counted as on-time.
  const planVsActual = (() => {
    const rows = prodOrdSec.rows
      .filter((r) => (r.status ?? "").toUpperCase() === "COMPLETED")
      .map((r) => {
        const plan = dayKey(r.targetEndDate);
        const actual = dayKey(r.completedDate);
        if (!plan || !actual) return null;
        const varianceDays = Math.round(
          (Date.parse(actual + "T00:00:00Z") - Date.parse(plan + "T00:00:00Z")) / 86400000,
        );
        return {
          poNo: r.poNo,
          productName: r.productName,
          plan,
          actual,
          varianceDays,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return {
      rows,
      onTime: rows.filter((r) => r.varianceDays <= 0).length,
      late: rows.filter((r) => r.varianceDays > 0).length,
      withBothDates: rows.length,
      // So the caller can render "N of M completed orders carry both dates"
      // instead of implying every completed order was judged.
      completedTotal: prodOrdSec.rows.filter((r) => (r.status ?? "").toUpperCase() === "COMPLETED").length,
    };
  })();

  // "Production Cost" — the one genuinely new query for Siti's list. Reads
  // fg_batches, which carries the real cost basis of what was produced
  // (materialCostSen/laborCostSen/overheadCostSen, filled in by
  // po-cost-cascade.ts once the material side settles — see that file's own
  // "UPDATE fg_batches SET ... costSen" writes). No org_id filter: fg_batches
  // and cost_ledger carry none anywhere else in this codebase either (see
  // src/api/routes/cost-ledger.ts), so this follows the same convention
  // rather than inventing a column that doesn't exist.
  const fgBatchSec = await section("fg batch cost", () =>
    c.var.DB.prepare(
      `SELECT productionOrderId, completedDate, originalQty,
              unitCostSen, materialCostSen, laborCostSen, overheadCostSen
         FROM fg_batches
        WHERE completedDate IS NOT NULL AND completedDate <> ''`,
    )
      .all<{
        productionOrderId: string | null;
        completedDate: string | null;
        originalQty: number | string | null;
        unitCostSen: number | string | null;
        materialCostSen: number | string | null;
        laborCostSen: number | string | null;
        overheadCostSen: number | string | null;
      }>()
      .then((r) => r.results ?? []),
  );
  const productionCost = (() => {
    const m = new Map<
      string,
      { date: string; materialSen: number; laborSen: number; overheadSen: number; totalSen: number; batches: number }
    >();
    let batchesWithCost = 0;
    for (const b of fgBatchSec.rows) {
      const d = dayKey(b.completedDate);
      if (!d) continue;
      const material = num(b.materialCostSen);
      const labor = num(b.laborCostSen);
      const overhead = num(b.overheadCostSen);
      const total = material + labor + overhead;
      if (total > 0) batchesWithCost++;
      let e = m.get(d);
      if (!e) m.set(d, (e = { date: d, materialSen: 0, laborSen: 0, overheadSen: 0, totalSen: 0, batches: 0 }));
      e.materialSen += material;
      e.laborSen += labor;
      e.overheadSen += overhead;
      e.totalSen += total;
      e.batches++;
    }
    return {
      byDay: [...m.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
      totalBatches: fgBatchSec.rows.length,
      // fg_batches are created with every cost column at 0 (fg-completion.ts)
      // and only gain a real figure once po-cost-cascade.ts settles the
      // material side. This is published so the UI can say "N of M batches
      // costed" instead of implying every batch has a real number.
      batchesWithCost,
    };
  })();

  // ---- Delivery: "Where DOs are sitting" status strip --------------------
  // The real Delivery page's SIX buckets (src/pages/delivery/index.tsx
  // ALL_TABS): Planning + Pending Delivery are PRODUCTION-ORDER-based (no DO
  // exists yet), Pending Dispatch/Dispatched/Delivered/Cancelled are
  // DELIVERY-ORDER-based. This mirrors that exactly — same predicates
  // (poInPlanning/poReadyForDelivery from src/lib/delivery-pipeline.ts, the
  // house's own single source of truth for those two tabs) and the same
  // value resolver (do-value.ts) the Delivery/Sales pages already use, so
  // this card reconciles to the cent with the real page instead of running
  // its own second, possibly-disagreeing count. Whole-book, like the funnel
  // above: "where is everything sitting right now," not "in this month."
  // No JOIN — every other query in this file is single-table (and the
  // schema checker that guards this file's SQL against __schema__ doesn't
  // parse aliased joins), so the CANCELLED exclusion is done in JS against
  // doRows, already fetched above, instead of in SQL.
  const doItemsSec = await section("delivery order items", () =>
    c.var.DB.prepare(
      `SELECT delivery_order_id, production_order_id
         FROM delivery_order_items
        WHERE org_id = ?
          AND production_order_id IS NOT NULL AND production_order_id <> ''`,
    )
      .bind(orgId)
      .all<{ deliveryOrderId: string; productionOrderId: string }>()
      .then((r) => r.results ?? []),
  );
  const doStatusById = new Map(doRows.map((r) => [r.id, r.status]));
  const linkedPOIds = new Set(
    doItemsSec.rows
      .filter((r) => doStatusById.get(r.deliveryOrderId) !== "CANCELLED")
      .map((r) => r.productionOrderId),
  );

  const jcByPoAll = new Map<string, PipelinePO["jobCards"]>();
  for (const jc of jcAllSec.rows) {
    if (!jc.productionOrderId) continue;
    const arr = jcByPoAll.get(jc.productionOrderId) ?? [];
    arr.push({
      departmentCode: jc.departmentCode ?? "",
      status: jc.status ?? "",
      completedDate: jc.completedDate,
      wipType: jc.wipType ?? undefined,
    });
    jcByPoAll.set(jc.productionOrderId, arr);
  }

  let doValMap = new Map<string, number>();
  let poValMap = new Map<string, number>();
  let doValueError: string | undefined;
  try {
    [doValMap, poValMap] = await Promise.all([
      loadDoValueMap(c.var.DB, orgId),
      loadPoValueMap(c.var.DB, orgId),
    ]);
  } catch (e) {
    doValueError = e instanceof Error ? e.message : String(e);
  }

  // Production revenue per day for the Daily (Lim) tab — the SAME definition
  // and SQL as the main dashboard's Production line (dashboard-overview.ts
  // prodWeekRes) and the Employee page's /production-revenue: a PO books on
  // the day its LAST upholstery job card completes, priced SO line → CO line
  // → product master × qty, SOFA/BEDFRAME/ACCESSORY only. It used to use PO
  // status COMPLETED + PO completed_date, which lands days later (after
  // packing) and drifted ~RM 6k/day from the main dashboard.
  const prodRevSec = await section("production revenue", () =>
    c.var.DB.prepare(
      `WITH per_po AS (
         SELECT production_order_id,
                MAX(CASE WHEN status IN ('COMPLETED','TRANSFERRED')
                              AND completed_date IS NOT NULL
                         THEN completed_date END) AS unit_completed_at
           FROM job_cards
          WHERE department_code = 'UPHOLSTERY'
          GROUP BY production_order_id
         HAVING COUNT(*) > 0
            AND SUM(CASE WHEN status IN ('COMPLETED','TRANSFERRED')
                              AND completed_date IS NOT NULL
                         THEN 1 ELSE 0 END) = COUNT(*)
       ), priced AS (
         SELECT to_char(per_po.unit_completed_at::date, 'YYYY-MM-DD') AS day,
                COALESCE(
                  soi.unit_price_sen,
                  coi.unit_price_sen,
                  (SELECT COALESCE(p.base_price_sen, p.price1_sen)
                     FROM products p
                    WHERE p.code = po.product_code
                    ORDER BY p.base_price_sen DESC NULLS LAST, p.id
                    LIMIT 1),
                  0
                ) * po.quantity AS sen
           FROM per_po
           JOIN production_orders po ON po.id = per_po.production_order_id
           LEFT JOIN sales_order_items soi
                  ON soi.sales_order_id = po.sales_order_id AND soi.line_no = po.line_no
           LEFT JOIN consignment_order_items coi
                  ON coi.consignment_order_id = po.consignment_order_id AND coi.line_no = po.line_no
          WHERE po.org_id = ?
            AND po.item_category IN ('SOFA','BEDFRAME','ACCESSORY')
            AND per_po.unit_completed_at IS NOT NULL
       )
       SELECT day AS "date",
              COUNT(*) AS "orders",
              SUM(CASE WHEN sen > 0 THEN 0 ELSE 1 END) AS "unpricedOrders",
              COALESCE(SUM(sen), 0) AS "revenueSen"
         FROM priced
        GROUP BY day`,
    )
      .bind(orgId)
      .all<{ date: string; orders: number | string; unpricedOrders: number | string; revenueSen: number | string }>()
      .then((r) => r.results ?? []),
  );

  // Bucketed by day so the frontend can slice "Aug 2026 only" the SAME way
  // it already does for every Sales metric (sum matching day rows; sum ALL
  // days for "Total Overview") — owner 2026-08-27: this panel had been
  // whole-book-always, which no longer matches how the rest of the page
  // behaves. Planning/Pending Delivery have no DO yet, so they're bucketed
  // by their LINKED SALES ORDER's created_at (the same cohort date the rest
  // of the Sales view already uses); Pending Dispatch/Dispatched/Delivered/
  // Cancelled are bucketed by the DELIVERY ORDER's own created_at.
  type DoStatusDay = {
    date: string;
    planningCount: number; planningSen: number;
    pendingDeliveryCount: number; pendingDeliverySen: number;
    pendingDispatchCount: number; pendingDispatchSen: number;
    dispatchedCount: number; dispatchedSen: number;
    deliveredCount: number; deliveredSen: number;
    cancelledCount: number; cancelledSen: number;
  };
  const doStatusDay = new Map<string, DoStatusDay>();
  const dsDay = (d: string): DoStatusDay => {
    let e = doStatusDay.get(d);
    if (!e) {
      doStatusDay.set(d, (e = {
        date: d,
        planningCount: 0, planningSen: 0,
        pendingDeliveryCount: 0, pendingDeliverySen: 0,
        pendingDispatchCount: 0, pendingDispatchSen: 0,
        dispatchedCount: 0, dispatchedSen: 0,
        deliveredCount: 0, deliveredSen: 0,
        cancelledCount: 0, cancelledSen: 0,
      }));
    }
    return e;
  };

  let planningCount = 0, planningSen = 0;
  let pendingDeliveryCount = 0, pendingDeliverySen = 0;
  for (const r of prodOrdSec.rows) {
    const pipe: PipelinePO = {
      id: r.id,
      status: r.status ?? "",
      consignmentOrderId: r.consignmentOrderId ?? undefined,
      itemCategory: r.itemCategory ?? undefined,
      specialOrder: r.specialOrder ?? undefined,
      repairScope: r.repairscope ?? null,
      jobCards: jcByPoAll.get(r.id) ?? [],
    };
    const soCreated = r.salesOrderId
      ? dayKey(soById.get(r.salesOrderId)?.createdAt ?? null)
      : null;
    if (poInPlanning(pipe)) {
      const val = poValMap.get(r.id) ?? 0;
      planningCount++;
      planningSen += val;
      if (soCreated) {
        const e = dsDay(soCreated);
        e.planningCount++;
        e.planningSen += val;
      }
    } else if (poReadyForDelivery(pipe, linkedPOIds)) {
      const val = poValMap.get(r.id) ?? 0;
      pendingDeliveryCount++;
      pendingDeliverySen += val;
      if (soCreated) {
        const e = dsDay(soCreated);
        e.pendingDeliveryCount++;
        e.pendingDeliverySen += val;
      }
    }
  }

  let pendingDispatchCount = 0, pendingDispatchSen = 0;
  let dispatchedCount = 0, dispatchedSen = 0;
  let deliveredCount = 0, deliveredSen = 0;
  let cancelledCount = 0, cancelledSen = 0;
  for (const r of doRows) {
    const val = doValMap.get(r.id) ?? 0;
    const created = dayKey(r.createdAt);
    if (r.status === "DRAFT") {
      pendingDispatchCount++; pendingDispatchSen += val;
      if (created) { const e = dsDay(created); e.pendingDispatchCount++; e.pendingDispatchSen += val; }
    } else if (r.status === "LOADED" || r.status === "IN_TRANSIT") {
      dispatchedCount++; dispatchedSen += val;
      if (created) { const e = dsDay(created); e.dispatchedCount++; e.dispatchedSen += val; }
    } else if (r.status === "DELIVERED" || r.status === "INVOICED") {
      deliveredCount++; deliveredSen += val;
      if (created) { const e = dsDay(created); e.deliveredCount++; e.deliveredSen += val; }
    } else if (r.status === "CANCELLED") {
      cancelledCount++; cancelledSen += val;
      if (created) { const e = dsDay(created); e.cancelledCount++; e.cancelledSen += val; }
    }
  }

  const doStatusBreakdown = [
    { key: "planning", label: "Planning", count: planningCount, valueSen: Math.round(planningSen) },
    { key: "pendingDelivery", label: "Pending Delivery", count: pendingDeliveryCount, valueSen: Math.round(pendingDeliverySen) },
    { key: "pendingDispatch", label: "Pending Dispatch", count: pendingDispatchCount, valueSen: Math.round(pendingDispatchSen) },
    { key: "dispatched", label: "Dispatched", count: dispatchedCount, valueSen: Math.round(dispatchedSen) },
    { key: "delivered", label: "Delivered", count: deliveredCount, valueSen: Math.round(deliveredSen) },
    { key: "cancelled", label: "Cancelled", count: cancelledCount, valueSen: Math.round(cancelledSen) },
  ];
  const doStatusByDay = [...doStatusDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

  // ---- Finished goods: Available / Reserved per product ------------------
  // Extracted-verbatim rule from src/lib/fg-stock.ts (deriveFGStock), the
  // house's own single source of truth for this — a production order is
  // finished stock once ALL of its UPHOLSTERY job cards are COMPLETED or
  // TRANSFERRED; DISPATCHED (linked to a non-DRAFT DO) drops it entirely,
  // DRAFT-linked is "reserved," unlinked is "available." Reuses job_cards
  // (jcByPoAll) and the DO-linkage (doItemsSec/doStatusById) already fetched
  // for the delivery-status and production-tracking sections above — no new
  // query. Consignment-note reservations are NOT included (this dashboard
  // doesn't fetch consignment_notes at all); a PO reserved only via a CN
  // will read as "available" here where the real page would show "reserved."
  const doStateByPo = new Map<string, "DRAFT" | "DISPATCHED">();
  for (const item of doItemsSec.rows) {
    const st = doStatusById.get(item.deliveryOrderId);
    const state: "DRAFT" | "DISPATCHED" = st === "DRAFT" ? "DRAFT" : "DISPATCHED";
    if (doStateByPo.get(item.productionOrderId) === "DISPATCHED") continue;
    doStateByPo.set(item.productionOrderId, state);
  }
  const fgByCode = new Map<string, { code: string; name: string; category: string | null; available: number; reserved: number }>();
  for (const po of prodOrdSec.rows) {
    const cards = jcByPoAll.get(po.id) ?? [];
    const uphCards = cards.filter((c) => c.departmentCode === "UPHOLSTERY");
    if (uphCards.length === 0) continue;
    if (!uphCards.every((c) => c.status === "COMPLETED" || c.status === "TRANSFERRED")) continue;
    if (doStateByPo.get(po.id) === "DISPATCHED") continue;
    const code = po.productCode ?? "";
    if (!code) continue;
    let fg = fgByCode.get(code);
    if (!fg) fgByCode.set(code, (fg = { code, name: po.productName ?? code, category: po.itemCategory, available: 0, reserved: 0 }));
    const qty = num(po.quantity);
    if (doStateByPo.get(po.id) === "DRAFT") fg.reserved += qty;
    else fg.available += qty;
  }
  const finishedGoods = [...fgByCode.values()].filter((f) => f.available > 0 || f.reserved > 0);

  // ---- Inventory --------------------------------------------------------
  const inventorySec = await section("inventory", () =>
    c.var.DB.prepare(
      `SELECT id, item_code, description, item_group, base_uom,
              balance_qty, min_stock, is_active
         FROM raw_materials
        WHERE org_id = ?`,
    )
      .bind(orgId)
      .all<RmRow>()
      .then((r) => r.results ?? []),
  );
  const rmRows = inventorySec.rows;
  const groups = new Map<
    string,
    { group: string; items: number; withStock: number; qty: number }
  >();
  for (const r of rmRows) {
    const g = r.itemGroup || "UNGROUPED";
    let e = groups.get(g);
    if (!e) groups.set(g, (e = { group: g, items: 0, withStock: 0, qty: 0 }));
    e.items++;
    const q = num(r.balanceQty);
    if (q > 0) { e.withStock++; e.qty += q; }
  }
  // MEASURED: min_stock is 0 on all 473 rows, so there is no reorder point to
  // compare anything against. Counted rather than assumed, so the day someone
  // populates it the view starts working without a code change.
  const withMinStock = rmRows.filter((r) => num(r.minStock) > 0).length;

  // Stock VALUE and stock AGE both come from the batch layers — raw_materials
  // carries neither a cost nor a receipt date, so without this join the
  // inventory view could only ever count units.
  const batchSec = await section("stock batches", () =>
    c.var.DB.prepare(
      `SELECT rm_id, remaining_qty, received_date, unit_cost_sen
         FROM rm_batches
        WHERE org_id = ?`,
    )
      .bind(orgId)
      .all<{
        rmId: string | null;
        remainingQty: number | string | null;
        receivedDate: string | null;
        unitCostSen: number | string | null;
      }>()
      .then((r) => r.results ?? []),
  );
  const AGE_BANDS = [
    { key: "0-30", label: "0-30 days", lo: 0, hi: 30 },
    { key: "31-60", label: "31-60 days", lo: 31, hi: 60 },
    { key: "61-90", label: "61-90 days", lo: 61, hi: 90 },
    { key: "90+", label: "Over 90 days", lo: 91, hi: Number.MAX_SAFE_INTEGER },
  ];
  const ageing = AGE_BANDS.map((b) => ({ ...b, batches: 0, qty: 0, valueSen: 0 }));
  const nowMs = Date.parse(todayKey + "T00:00:00Z");
  let stockValueSen = 0;
  let batchesWithStock = 0;
  const byMaterial = new Map<string, { qty: number; valueSen: number; oldestDays: number }>();
  for (const b of batchSec.rows) {
    const q = num(b.remainingQty);
    if (q <= 0) continue;
    batchesWithStock++;
    const v = q * num(b.unitCostSen);
    stockValueSen += v;
    const rd = dayKey(b.receivedDate);
    const ageDays = rd ? Math.floor((nowMs - Date.parse(rd + "T00:00:00Z")) / 86400000) : null;
    if (ageDays != null) {
      const band = ageing.find((x) => ageDays >= x.lo && ageDays <= x.hi);
      if (band) { band.batches++; band.qty += q; band.valueSen += v; }
    }
    if (b.rmId) {
      let m = byMaterial.get(b.rmId);
      if (!m) byMaterial.set(b.rmId, (m = { qty: 0, valueSen: 0, oldestDays: 0 }));
      m.qty += q;
      m.valueSen += v;
      if (ageDays != null && ageDays > m.oldestDays) m.oldestDays = ageDays;
    }
  }

  // ---- Coverage ---------------------------------------------------------
  // Published, not implied. A caller that renders a view listed as
  // unavailable is rendering nothing, and should say so on the page.
  const monthsWithSales = new Set([...salesByDay.keys()].map((d) => d.slice(0, 7)));
  const monthsWithAttendance = new Set(attendance.map((r) => r.date!.slice(0, 7)));

  // Per-month efficiency coverage. Published because it is NOT uniform: July
  // 2026 has it on 99% of rows and May 2026 on 0.1%, so an efficiency average
  // means something very different in one month than the other. A page that
  // draws both as equally solid lines is lying by omission.
  const coverageByMonth = new Map<string, { month: string; rows: number; withEfficiency: number }>();
  for (const r of attendance) {
    const k = r.date!.slice(0, 7);
    let e = coverageByMonth.get(k);
    if (!e) coverageByMonth.set(k, (e = { month: k, rows: 0, withEfficiency: 0 }));
    e.rows++;
    if (r.efficiencyPct != null && r.efficiencyPct > 0) e.withEfficiency++;
  }

  const workerRows = workersSec.rows;
  const config = {
    // Read from the workforce, not hardcoded. The prototype shipped with 85%
    // and an 8-hour day; both are wrong for this factory.
    efficiencyTargetPct: modeOf(workerRows.map((w) => num(w.efficiencyThresholdPct)), 100),
    workingHoursPerDay: modeOf(workerRows.map((w) => num(w.workingHoursPerDay)), 9),
  };

  return {
    success: true,
    meta: {
      orgId,
      generatedAt: new Date().toISOString(),
      // The UNION — every month the book holds anything at all. Kept as the
      // broad answer, but it is the wrong list to build a month picker from:
      // this org has three months (2025-08, 2025-12, 2026-02) carrying a single
      // attendance row and zero sales, so a picker driven by the union offers
      // months whose sales views are necessarily empty. A caller that scopes
      // one section should read that section's own list below.
      months: [...new Set([...monthsWithSales, ...monthsWithAttendance])].sort(),
      monthsWithSales: [...monthsWithSales].sort(),
      monthsWithAttendance: [...monthsWithAttendance].sort(),
      config,
      efficiencyCoverage: [...coverageByMonth.values()].sort((a, b) =>
        a.month < b.month ? -1 : 1,
      ),
    },
    availability: {
      // `live` is not a constant — it is whether this section's query actually
      // came back. The route's SQL first executes in production (there is no
      // database password available for a local run), so a section that fails
      // must say so and let the other four render, rather than 500 the page or
      // present an empty chart as a real zero.
      sales: {
        live: !salesSec.error && !soItemCatSec.error,
        rows: salesTabRows.length,
        reason: salesSec.error ?? soItemCatSec.error ?? undefined,
      },
      service: { live: !serviceSec.error, reason: serviceSec.error ?? undefined },
      employee: {
        live: !attSec.error && !workersSec.error && !wheSec.error && !jcSec.error,
        reason: attSec.error ?? workersSec.error ?? wheSec.error ?? jcSec.error
          ?? picsSec.error ?? deptSec.error ?? undefined,
        workers: workerRows.length,
        attendanceRows: attendance.length,
        // Named so the page can render a dash instead of a fabricated figure.
        missing: ["output", "unitsPerHour", "absence", "leave"],
      },
      delivery: {
        live: !deliverySec.error,
        reason: deliverySec.error ?? undefined,
        rows: doRows.length,
        // delivery_returns and delivery_return_items are both EMPTY (0 rows,
        // measured). The return-reason breakdown therefore has nothing to draw
        // and must say so instead of rendering an encouraging blank chart.
        missing: ["returns"],
      },
      // Separate from `delivery` above: the status-strip's Planning/Pending
      // Delivery counts read production_orders + job_cards (the SAME tables
      // the Production section depends on) and its RM values read do-value.ts
      // (its own price-index queries), so a failure here is independent of
      // whether delivery_orders itself loaded fine.
      deliveryStatus: {
        live: !doItemsSec.error && !doValueError,
        reason: doItemsSec.error ?? doValueError ?? undefined,
      },
      purchase: {
        live: !purchaseSec.error,
        reason: purchaseSec.error ?? poItemSec.error ?? undefined,
        rows: poRows.length,
        missing: ["supplierScorecards"],
      },
      production: {
        live: !prodOrdSec.error && !jcAllSec.error,
        reason: prodOrdSec.error ?? jcAllSec.error ?? undefined,
        rows: openProdOrders.length,
        // Separate from `live` above on purpose: a failed fg_batches query
        // should not mark the whole Production tab dead, only Production
        // Cost within it (which degrades to empty, not fabricated, on error —
        // see the `section()` helper).
        costError: fgBatchSec.error ?? undefined,
      },
      lim: {
        live: !prodOrdSec.error && !jcAllSec.error,
        reason: prodOrdSec.error ?? jcAllSec.error ?? undefined,
      },
      inventory: {
        live: !inventorySec.error,
        reason: inventorySec.error ?? batchSec.error ?? undefined,
        rows: rmRows.length,
        // No reorder point exists anywhere in the table, so shortage/reorder
        // analytics are impossible rather than merely empty.
        missing: withMinStock === 0 ? ["minStock", "reorderPoint"] : [],
      },
    },
    sales: {
      byDay: [...salesByDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
      pipeline,
      orders: salesTabRows.map((r) => ({
        id: r.id,
        no: r.companySOId ?? r.companySO,
        customer: r.customerName,
        status: r.status,
        totalSen: num(r.totalSen),
        createdAt: dayKey(r.createdAt),
        soDate: dayKey(r.companySODate),
        deliveryDate: dayKey(r.customerDeliveryDate),
        isServiceOrder: !!r.isServiceOrder,
      })),
      byStateCategory: [...stateCategorySkuMap.values()],
      excludedServiceOrders,
    },
    delivery: {
      otif,
      funnel: (() => {
        const f = new Map<string, number>();
        for (const r of doRows) {
          const k = (r.status ?? "UNKNOWN").toUpperCase();
          f.set(k, (f.get(k) ?? 0) + 1);
        }
        return [...f.entries()].map(([status, count]) => ({ status, count }));
      })(),
      byDay: [...doByDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
      velocity: {
        n: lagDays.length,
        medianDays: lagDays.length ? lagDays[Math.floor(lagDays.length / 2)] : null,
        p90Days: lagDays.length ? lagDays[Math.floor(lagDays.length * 0.9)] : null,
        maxDays: lagDays.length ? lagDays[lagDays.length - 1] : null,
      },
      split: {
        orders: splitCounts.length,
        splitOrders,
        singleOrders: splitCounts.length - splitOrders,
        ratePct: splitCounts.length ? (splitOrders / splitCounts.length) * 100 : null,
      },
      fleet: [...fleet.values()].sort((a, b) => b.dos - a.dos),
      returns: { rows: 0, reason: "delivery_returns and delivery_return_items are both empty" },
      statusBreakdown: doStatusBreakdown,
      // Day-bucketed version of the same six counts, for the "Aug 2026 only
      // vs Total Overview" toggle — sum the days in view for a period slice,
      // sum ALL of them to reproduce statusBreakdown exactly (same source
      // counts, just re-aggregated, so the two can never disagree).
      statusByDay: doStatusByDay,
    },
    purchase: {
      // MEASURED live: 180 rows = 23 CANCELLED + 37 received/CLOSED + 120 open.
      // Published so the "Total POs" headline has one authoritative source
      // rather than each caller re-deriving it from a filtered register.
      totals: {
        all: poRows.length,
        cancelled: poRows.filter((r) => r.status === "CANCELLED").length,
        active: poRows.filter((r) => r.status !== "CANCELLED").length,
      },
      tiers: [...tierCounts.values()],
      inbound: [...inboundByDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
      suppliers: [...supplierAgg.values()]
        .map((sv) => ({
          ...sv,
          // null, not 100, when nothing of theirs has arrived yet — a supplier
          // you have never received from has no punctuality record, and showing
          // them at the top of an on-time leaderboard would be a lie.
          otrPct: sv.judged ? (sv.onTime / sv.judged) * 100 : null,
        }))
        .sort((a, b) => b.valueSen - a.valueSen),
      register: poRegister,
    },
    production: {
      // Stage order is read from departments.sequence, not hardcoded.
      stages: stageRows.map((x) => x.code),
      backlog: [...backlogByDept.values()]
        .sort((a, b) => a.seq - b.seq)
        .map((b) => ({ dept: b.dept, seq: b.seq, cards: b.cards, orders: b.orders.size })),
      bottleneck: bottleneck
        ? { dept: bottleneck.dept, cards: bottleneck.cards, orders: bottleneck.orders.size }
        : null,
      orders: prodOrdersRisked,
      totals: {
        active: prodOrdersRisked.length,
        critical: prodOrdersRisked.filter((o) => o.risk === "critical").length,
        atRisk: prodOrdersRisked.filter((o) => o.risk === "atrisk").length,
        onTrack: prodOrdersRisked.filter((o) => o.risk === "ontrack").length,
        // An order whose SO carries no customer date cannot be risked at all.
        // Counted, not hidden — the same coverage discipline OTIF uses.
        unknownDue: prodOrdersRisked.filter((o) => o.risk === "unknown").length,
        backlogCards: [...backlogByDept.values()].reduce((a, x) => a + x.cards, 0),
      },
      // On-time delivery for the header KPI reuses the SAME house figure the
      // Delivery view shows — one number, one definition, two screens.
      onTime: otif,
      // Siti's list (draft) — see the comment above prodOrdersRisked/bottleneck.
      overdueByDept,
      dueSoon3Days,
      dailyOutput,
      planVsActual,
      productionCost,
    },
    // "Daily (Lim)" tab — see ../lib/dashboard-daily-slice.ts for definitions.
    lim: buildDailySlice(prodOrdSec.rows, jcAllSec.rows, prodRevSec.error ? null : prodRevSec.rows, prodRevSec.error ?? undefined),
    inventory: {
      groups: [...groups.values()].sort((a, b) => b.items - a.items),
      totals: {
        items: rmRows.length,
        active: rmRows.filter((r) => !!r.isActive).length,
        withStock: rmRows.filter((r) => num(r.balanceQty) > 0).length,
        withMinStock,
        stockValueSen: Math.round(stockValueSen),
        batchesWithStock,
      },
      // Siti's list (draft): "Material Shortage". `min_stock` is 0 on every
      // row (MEASURED, see the file header), so there is no real reorder
      // point to compare against — this is a cheaper proxy, active raw
      // materials sitting at zero or negative balance right now. Once a
      // genuine reorder point exists somewhere, replace this with that.
      materialShortage: rmRows
        .filter((r) => !!r.isActive && num(r.balanceQty) <= 0)
        .map((r) => ({ code: r.itemCode, description: r.description, group: r.itemGroup, balanceQty: num(r.balanceQty) })),
      ageing,
      // The WHOLE book, ordered by the value actually sitting on the floor.
      // It was capped at 50, which made the item list disagree with the
      // stockValueSen total beside it — the total counted every batch, the
      // list counted fifty. 473 rows of seven fields is small enough to send
      // whole, and agreeing with itself matters more than the bytes.
      items: rmRows
        .map((r) => {
          // rm_batches.rmId references raw_materials.id, NOT item_code —
          // VERIFIED: 1,344 of 1,344 batches match on id and 0 match on
          // item_code, so keying this on the code would value every item at 0.
          const m = byMaterial.get(r.id);
          return {
            code: r.itemCode, description: r.description, group: r.itemGroup,
            uom: r.baseUom, balanceQty: num(r.balanceQty),
            valueSen: Math.round(m?.valueSen ?? 0), oldestDays: m?.oldestDays ?? null,
          };
        })
        .sort((a, b) => b.valueSen - a.valueSen),
      finishedGoods: finishedGoods.sort((a, b) => (b.available + b.reserved) - (a.available + a.reserved)),
    },
    service: serviceSec.rows[0] ?? null,
    employee: {
      workers: workerRows.map((w) => ({
        id: w.id,
        empNo: w.empNo,
        name: w.name,
        dept: w.departmentCode,
        role: w.position,
        status: w.status,
        targetPct: num(w.efficiencyThresholdPct) || null,
        hoursPerDay: num(w.workingHoursPerDay) || null,
        // Headcount rule copied from the real Employees page: ACTIVE only,
        // and TEST* accounts excluded (owner 2026-07-11, same rule Payroll
        // uses so headcount tallies system-wide).
        countsToHeadcount: countsToHeadcount(w.status, w.empNo),
      })),
      attendance,
      // The house workforce metric. `attendance` above is kept for clock-in /
      // clock-out and the attendance table — those ARE attendance facts — but
      // hours and efficiency must come from here.
      performance: {
        byDay: perfDays,
        productionDepts: [...productionDepts],
        // Provenance for the efficiency numerator. MEASURED: 0 of 7,354 cards
        // in Aug 2026 carry a real measured duration, so the numerator is
        // EARNED STANDARD time, not observed time. The page must say so
        // rather than present it as measured productivity.
        cards: perfCards,
        measuredCards: perfMeasuredCards,
      },
    },
  };
  });

  // Redact at the response boundary, not by skipping the queries above — the
  // sections cross-reference each other too much to gate mid-computation
  // (e.g. the delivery status strip reads production_orders), and this is
  // the same "drop it, don't refuse the whole page" doctrine hasPermission's
  // own doc describes for a column a caller may not see. A denied section
  // reports `live: false` with a reason, same shape a genuine query failure
  // already uses, so the frontend needs no special case for "no permission"
  // vs "query broke."
  const payload = {
    ...rawPayload,
    delivery: canDelivery ? rawPayload.delivery : null,
    purchase: canPurchase ? rawPayload.purchase : null,
    inventory: canInventory ? rawPayload.inventory : null,
    employee: canWorkers ? rawPayload.employee : null,
    service: canService ? rawPayload.service : null,
    production: canProduction ? rawPayload.production : null,
    lim: canProduction ? rawPayload.lim : null,
    availability: {
      ...rawPayload.availability,
      delivery: canDelivery
        ? rawPayload.availability.delivery
        : { live: false, rows: 0, reason: "insufficient permission: delivery-orders:read" },
      deliveryStatus: canDelivery
        ? rawPayload.availability.deliveryStatus
        : { live: false, reason: "insufficient permission: delivery-orders:read" },
      purchase: canPurchase
        ? rawPayload.availability.purchase
        : { live: false, rows: 0, reason: "insufficient permission: purchase-orders:read" },
      inventory: canInventory
        ? rawPayload.availability.inventory
        : { live: false, rows: 0, reason: "insufficient permission: inventory:read" },
      service: canService
        ? rawPayload.availability.service
        : { live: false, reason: "insufficient permission: service-cases:read" },
      employee: canWorkers
        ? rawPayload.availability.employee
        : { live: false, workers: 0, attendanceRows: 0, reason: "insufficient permission: workers:read" },
      lim: canProduction
        ? rawPayload.availability.lim
        : { live: false, reason: "insufficient permission: production-orders:read" },
      production: canProduction
        ? rawPayload.availability.production
        : { live: false, rows: 0, reason: "insufficient permission: production-orders:read" },
    },
  };

  return c.json(payload);
});

export default app;
