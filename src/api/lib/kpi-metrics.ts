// ---------------------------------------------------------------------------
// kpi-metrics.ts — where each KPI's ACTUAL comes from.
//
// One function per KPI, each returning { actual, sampleSize, detail } so the
// card can say "9 late of 41 shipped" rather than a bare number. A KPI whose
// sample is too small to mean anything reports it rather than hiding it.
//
// Join note, and it matters: `delivery_orders.sales_order_id` is set on only
// 166 of 361 DOs, so joining on it silently drops half the shipments.
// `delivery_order_items.sales_order_no` is a stale denormalised string. The one
// path that resolves is
//   delivery_orders → delivery_order_items.production_order_id
//                   → production_orders.sales_order_id → sales_orders
// (2081/2081 and 2341/2379 respectively, measured 2026-08-06). Every query
// below uses it.
//
// The customer's date is `sales_orders.customer_delivery_date` (99.8% filled).
// `hookka_expected_dd` is OUR internal estimate and must never be scored
// against — see docs/archive/PRODUCTION-PLANNING-LOGIC.md.
// ---------------------------------------------------------------------------
import type { Context } from "hono";
import type { Env } from "../worker";
import { kpiByKey, type KpiDef } from "./kpi-catalog";
import { getOrgId } from "./tenant";
import {
  collectOnTimeOrders,
  judgeOnTimeRow,
  onTimeDates,
  summarizeOnTimeRows,
  type OnTimeRow,
} from "./on-time-delivery";
import {
  buildPerfDays,
  poolEfficiencyPct,
  dailyEfficiencyPct,
  type PerfWheRow,
  type PerfJcRow,
  type PerfPicRow,
} from "./workforce-perf";
import {
  computeMonthlyEfficiencyByWorker,
  type EfficiencyScope,
} from "./efficiency-allowance";

/** Categories a production_efficiency scope may name (DEV-36). */
export const EFFICIENCY_CATEGORIES = ["SOFA", "BEDFRAME"] as const;

/**
 * An assignment's stored scope: "" / null = Overall, otherwise a comma list of
 * "FAB_CUT" (a department) and "FAB_CUT:SOFA" (a department and category),
 * pooled into one figure. Anything else is not a scope and reads as null, so
 * the caller can refuse it. Duplicates are dropped.
 */
export function parseEfficiencyScope(raw: unknown): EfficiencyScope | null {
  const out: EfficiencyScope = [];
  const seen = new Set<string>();
  for (const item of String(raw ?? "").trim().toUpperCase().split(",")) {
    const [dept, category, extra] = item.trim().split(":");
    if (!dept || extra !== undefined || !/^[A-Z0-9_]+$/.test(dept)) return null;
    if (category !== undefined && !(EFFICIENCY_CATEGORIES as readonly string[]).includes(category)) {
      return null;
    }
    const key = category ? `${dept}:${category}` : dept;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(category ? { dept, category } : { dept });
  }
  return out;
}

/** The stored form of a parsed scope: "FAB_CUT,FAB_SEW:SOFA". */
export function formatEfficiencyScope(scope: EfficiencyScope): string {
  return scope.map((p) => (p.category ? `${p.dept}:${p.category}` : p.dept)).join(",");
}

export interface MetricResult {
  actual: number | null;
  /** How many rows the figure was computed from. */
  sampleSize: number;
  /** One line for the card, e.g. "9 late of 41 shipped". */
  detail: string;
  /** customer_delivery_date only — % shipped before the promised date. */
  earlyPct?: number;
  /** department_efficiency only: the same pool per day, for the card's chart. */
  daily?: Array<{ date: string; pct: number }>;
}

const EMPTY: MetricResult = { actual: null, sampleSize: 0, detail: "No data" };

/** First and last day of a YYYY-MM period, inclusive. */
export function periodBounds(period: string): { start: string; end: string } {
  const [y, m] = period.split("-").map(Number);
  const start = `${period}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start, end: `${period}-${String(last).padStart(2, "0")}` };
}

// ---------------------------------------------------------------------------
// On-time delivery to the customer's promised date.
//
// Owner's rule (2026-08-14): the date the goods were DELIVERED against
// `sales_orders.customer_delivery_date`, once per sales order, judged on its
// LAST delivery, on the Malaysia date. It lives in on-time-delivery.ts, which
// the Hookka Report already uses. The KPI, its order list and the report all
// read the same rows (`collectOnTimeOrders`) and the same verdict
// (`judgeOnTimeRow`), so the card cannot say 11 while the list shows 14.
//
// Until BUG-2026-10-08-267 this file had its own query: the FIRST DISPATCH,
// on the UTC date. A part-delivered order whose first lorry left on time
// counted as on time however late the last one arrived.
// ---------------------------------------------------------------------------

/** Promised date − order date, in whole days. Null with no order date. */
export function leadDays(r: OnTimeRow): number | null {
  const due = onTimeDates(r).due;
  const ordered = String(r.orderDate ?? r.order_date ?? "").slice(0, 10).trim();
  if (!due || !ordered) return null;
  const d = Math.round((Date.parse(due) - Date.parse(ordered)) / 86_400_000);
  return Number.isFinite(d) ? d : null;
}

/**
 * Late %, with a late URGENT order (promised within the urgent window of its
 * order date) counting as `urgentLatePct`% of a late one. Owner 2026-10-08.
 */
export function weightedLatePct(
  judged: number, late: number, urgentLate: number, urgentLatePct: number,
): number {
  const counted = late - urgentLate * (1 - urgentLatePct / 100);
  return Math.round((counted / judged) * 1000) / 10;
}

/**
 * The KPI figure from the shared rows. Pure, so the tests can hold it and the
 * order list to the same rows.
 */
export function deliveryMetric(
  rows: OnTimeRow[],
  rules: Pick<KpiDef, "urgentDays" | "urgentLatePct">,
): MetricResult {
  const urgentDays = Math.floor(Number(rules.urgentDays ?? 7));
  const urgentLatePct = Number(rules.urgentLatePct ?? 100);
  const s = summarizeOnTimeRows(rows);
  if (s.judged === 0) return EMPTY;
  const urgentLate = rows.filter((r) => {
    if (judgeOnTimeRow(r) !== "LATE") return false;
    const lead = leadDays(r);
    return lead !== null && lead <= urgentDays;
  }).length;
  // Reported as a PERCENTAGE, not a count: 9 late out of 41 and 9 out of 400
  // are different failures, and the scoring curve is per percentage point.
  const pct = weightedLatePct(s.judged, s.late, urgentLate, urgentLatePct);
  const earlyPct = Math.round((s.early / s.judged) * 1000) / 10;
  return {
    actual: pct,
    sampleSize: s.judged,
    detail:
      `${s.late} late` +
      (urgentLate > 0 && urgentLatePct < 100
        ? ` (${urgentLate} urgent at ${urgentLatePct}%, so ${Math.round((s.late - urgentLate * (1 - urgentLatePct / 100)) * 10) / 10} counted)`
        : "") +
      `, ${s.early} early of ${s.judged} delivered (${pct}% late, ${earlyPct}% early)`,
    earlyPct,
  };
}

/**
 * Sales orders fully delivered in the period (last delivery, Malaysia date),
 * later than the customer's date. Counted once per SALES ORDER: a customer
 * promised one date and sent three lorries was let down once, not three times.
 * An order not fully delivered yet is left out until its last delivery lands.
 */
export async function customerDeliveryLate(
  c: Context<Env>,
  period: string,
  rules: Pick<KpiDef, "urgentDays" | "urgentLatePct"> = kpiByKey("customer_delivery_date")!,
): Promise<MetricResult> {
  const { start, end } = periodBounds(period);
  return deliveryMetric(await collectOnTimeOrders(c.var.DB, start, end), rules);
}

export interface LateOrderRow {
  id: string;
  companySOId: string | null;
  customerId: string | null;
  customerName: string | null;
  customerDeliveryDate: string | null;
  /** The last delivery's Malaysia date. */
  deliveredOn: string | null;
  status: "LATE" | "EARLY" | "ON_TIME";
  /** Promised date − order date, in days. The card tags it urgent against the rule. */
  leadDays: number | null;
}

/**
 * The judged orders as list rows: LATE only, or every judged order with `all`.
 * Orders the metric left out (not fully delivered, no customer date) are not
 * listed, so the LATE rows ARE the card's late count.
 */
export function deliveryOrderRows(rows: OnTimeRow[], all: boolean): LateOrderRow[] {
  const out: LateOrderRow[] = [];
  for (const r of rows) {
    const v = judgeOnTimeRow(r);
    if (v !== "LATE" && v !== "EARLY" && v !== "ON_TIME") continue;
    if (!all && v !== "LATE") continue;
    const { due, delivered } = onTimeDates(r);
    out.push({
      id: String(r.soId ?? r.so_id),
      companySOId: r.companySOId ?? r.company_so_id ?? null,
      customerId: r.customerId ?? r.customer_id ?? null,
      customerName: r.customerName ?? r.customer_name ?? null,
      customerDeliveryDate: due,
      deliveredOn: delivered,
      status: v,
      leadDays: leadDays(r),
    });
  }
  return out;
}

/**
 * The ORDERS behind `customerDeliveryLate` — the "See the list →" drill-down.
 *
 * `scope` is the row-level customer filter (src/api/lib/customer-scope.ts). A
 * salesperson may not see another salesperson's orders even when those orders
 * are inside the factory-wide figure they are shown — so for a scoped role the
 * list is legitimately SHORTER than the count. Narrowing here rather than in
 * the browser is the point: a client-side filter over a full payload has
 * already shipped the rows.
 *
 * `all` returns every order the metric judged (late, early and on time). The
 * KPI card lists them inline so a person can see which order fell on which side.
 */
export async function lateToCustomerOrders(
  c: Context<Env>,
  period: string,
  scope: { clause: string; binds: string[] } = { clause: "", binds: [] },
  all = false,
): Promise<LateOrderRow[]> {
  const { start, end } = periodBounds(period);
  return deliveryOrderRows(await collectOnTimeOrders(c.var.DB, start, end, scope), all);
}

/**
 * Active SKUs that are fully set up.
 *
 * "Fully" means all four: a price, a cubic volume, a fabric usage, and a BOM
 * template that actually contains routing.
 *
 * Routing lives in `wip_components`, NOT `l1_processes`. The first version of
 * this asked about l1_processes and reported 113 of 360 — the owner said that
 * could not be right ("BOM 的工序基本上都有的，不是吗？") and was correct: the
 * wip-times route, which is what actually schedules the floor, reads
 * wip_components and resolves 273 of the same 360. l1_processes is a mostly
 * empty legacy column, so the KPI was measuring the wrong field and calling it
 * a data gap. Also UPPER()s the status, exactly as wip-times does.
 */
// ---------------------------------------------------------------------------
// The four "is this SKU set up" tests, written ONCE.
//
// Same reason as the delivery-date fragments above: the card reports "247 no
// BOM" and its drill-down link has to open those 247 rows. One copy of the
// predicate means the list cannot drift from the number. The keys here are
// also the values the `?missing=` query param takes, so the card's per-field
// gap and the URL that opens it are the same vocabulary.
// ---------------------------------------------------------------------------
export const SETUP_FIELD_SQL = {
  price: `COALESCE(p.basePriceSen,0) + COALESCE(p.price1Sen,0) > 0`,
  volume: `COALESCE(p.unitM3,0) > 0`,
  fabric: `COALESCE(p.fabricUsage,0) > 0`,
  bom: `EXISTS (
                                SELECT 1 FROM bom_templates b
                                 WHERE b.productCode = p.code
                                   AND UPPER(b.versionStatus) = 'ACTIVE'
                                   AND COALESCE(b.wipComponents,'') NOT IN ('', '[]')
                              )`,
} as const;

/** The field a `?missing=` drill-down may narrow to. */
export type SetupField = keyof typeof SETUP_FIELD_SQL;

export const SETUP_FIELDS = Object.keys(SETUP_FIELD_SQL) as SetupField[];

export function isSetupField(v: unknown): v is SetupField {
  return typeof v === "string" && (SETUP_FIELDS as string[]).includes(v);
}

/** Only ACTIVE products are measured — a retired SKU is not a data gap. */
const SETUP_SCOPE = `FROM products p
      WHERE p.status = 'ACTIVE'`;

export async function setupCompleteness(
  c: Context<Env>,
): Promise<MetricResult> {
  // Counted PER FIELD as well as overall. "31% complete" tells nobody what to
  // go and do; "247 have no BOM" is a morning's work with a visible end. The
  // four checks each pass on ~75% of SKUs, so the intersection collapses to a
  // third — which reads as a catastrophe until you can see it is really one
  // missing field on most of them.
  const row = await c.var.DB.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN ${SETUP_FIELD_SQL.price}
                     THEN 1 ELSE 0 END), 0) AS "hasPrice",
            COALESCE(SUM(CASE WHEN ${SETUP_FIELD_SQL.volume} THEN 1 ELSE 0 END), 0) AS "hasM3",
            COALESCE(SUM(CASE WHEN ${SETUP_FIELD_SQL.fabric} THEN 1 ELSE 0 END), 0) AS "hasFabric",
            COALESCE(SUM(CASE WHEN ${SETUP_FIELD_SQL.bom} THEN 1 ELSE 0 END), 0) AS "hasBom",
            COALESCE(SUM(CASE WHEN ${SETUP_FIELD_SQL.price}
                          AND ${SETUP_FIELD_SQL.volume}
                          AND ${SETUP_FIELD_SQL.fabric}
                          AND ${SETUP_FIELD_SQL.bom}
                     THEN 1 ELSE 0 END), 0) AS complete
       ${SETUP_SCOPE}`,
  ).first<{
    total: number; complete: number;
    hasPrice: number; hasM3: number; hasFabric: number; hasBom: number;
  }>();

  const total = Number(row?.total) || 0;
  const complete = Number(row?.complete) || 0;
  if (total === 0) return EMPTY;

  // Aliases are QUOTED camelCase. Unquoted `AS has_bom` came back as `hasBom`
  // — the driver's transform.column.from turns snake_case into camelCase on the
  // way out — so every lookup read undefined, `total - 0` was the whole total,
  // and the card claimed all 360 SKUs were missing all four fields while also
  // reporting 269 of them complete. Postgres preserves a quoted identifier, so
  // quoting is what makes the JS side match.
  const gaps: string[] = [];
  const miss = (label: string, have: unknown) => {
    const n = total - (Number(have) || 0);
    if (n > 0) gaps.push(`${n} no ${label}`);
  };
  miss("BOM", row?.hasBom);
  miss("price", row?.hasPrice);
  miss("volume", row?.hasM3);
  miss("fabric usage", row?.hasFabric);

  return {
    actual: Math.round((complete / total) * 1000) / 10,
    sampleSize: total,
    detail:
      `${complete} of ${total} active SKUs fully set up` +
      (gaps.length ? ` — ${gaps.join(", ")}` : ""),
  };
}

export interface IncompleteProductRow {
  id: string;
  code: string;
  /** Which of the four are absent — the same keys as SETUP_FIELD_SQL. */
  missing: SetupField[];
}

/**
 * The SKUs behind `setupCompleteness` — the "See the list →" drill-down.
 *
 * `field` narrows to ONE gap, because that is how the work is actually done:
 * the card says "247 no BOM" and somebody spends a morning on BOMs. Passing
 * null returns every SKU missing at least one of the four, which is the
 * complement of the metric's `complete` count.
 *
 * No customer scoping — products belong to the factory, not to a customer, and
 * `/api/products` is deliberately absent from SCOPED_PREFIXES.
 */
export async function incompleteSetupProducts(
  c: Context<Env>,
  field: SetupField | null = null,
): Promise<IncompleteProductRow[]> {
  const missingAny = SETUP_FIELDS.map((f) => `NOT (${SETUP_FIELD_SQL[f]})`).join(
    " OR ",
  );
  const where = field
    ? `NOT (${SETUP_FIELD_SQL[field]})`
    : `(${missingAny})`;
  const res = await c.var.DB.prepare(
    `SELECT p.id AS "id",
            p.code AS "code",
            CASE WHEN ${SETUP_FIELD_SQL.price} THEN 0 ELSE 1 END AS "noPrice",
            CASE WHEN ${SETUP_FIELD_SQL.volume} THEN 0 ELSE 1 END AS "noVolume",
            CASE WHEN ${SETUP_FIELD_SQL.fabric} THEN 0 ELSE 1 END AS "noFabric",
            CASE WHEN ${SETUP_FIELD_SQL.bom} THEN 0 ELSE 1 END AS "noBom"
       ${SETUP_SCOPE}
        AND (${where})
      ORDER BY p.code`,
  ).all<{
    id: string; code: string;
    noPrice: number; noVolume: number; noFabric: number; noBom: number;
  }>();

  return (res.results ?? []).map((r) => {
    const missing: SetupField[] = [];
    if (Number(r.noPrice)) missing.push("price");
    if (Number(r.noVolume)) missing.push("volume");
    if (Number(r.noFabric)) missing.push("fabric");
    if (Number(r.noBom)) missing.push("bom");
    return { id: String(r.id), code: String(r.code), missing };
  });
}

/**
 * The merged daily-report KPI: invoicing lag AND the exception burn-down.
 *
 * Owner 2026-08-07 merged two KPIs into one ("这两个要结合"), because the
 * uninvoiced buckets were BOTH scored here and counted again inside the daily
 * exception total — the same late invoice charged twice. The exception half
 * now runs with those buckets removed.
 *
 * Half one, invoicing:
 *
 * Owner 2026-08-07: "dispatch 了之后三天内要看到 invoice，迟一天扣 10 分 … 5 张
 * 单 1 天就 50 分 … 就是一个 DO or SI，不是跟着一个 order，multiple order become
 * 1 DO SI 的我们."
 *
 * Three things in that sentence decide the shape of this query:
 *
 *  1. The clock starts at DISPATCH, not at order date, and runs to the invoice
 *     — so this is a LAG, not a snapshot of what is currently outstanding. The
 *     old version read the Daily Report's "not invoiced" count, which answers a
 *     different question: it says how many are stuck right now and says nothing
 *     about a document invoiced on day 30 last week. Under the new rule that
 *     one cost 270 points and the snapshot would have shown it as clean.
 *
 *  2. The unit is the DELIVERY ORDER. Several sales orders routinely ship on
 *     one delivery order, and that is one document to raise, so counting sales
 *     orders would charge the same lateness three times.
 *
 *  3. Days accumulate across documents. Five documents one day late is 5, the
 *     same as one document five days late — the owner's own example. So this
 *     sums days rather than counting offending documents.
 *
 * A delivery order with no invoice yet accrues up to TODAY (or the period end,
 * whichever is earlier), otherwise a document nobody ever billed would score
 * better than one billed a day late.
 */
export async function documentsStuck(
  c: Context<Env>,
  period: string,
): Promise<MetricResult> {
  const lag = await invoiceLag(c, period);
  const burn = await exceptionsCleared(c, period, /* excludeInvoiceBuckets */ true);

  const def = kpiByKey("documents_not_stuck");
  const per = Number(def?.penaltyPerUnit ?? 10);

  const halves: Array<{ score: number; detail: string }> = [];
  if (lag.actual !== null) {
    halves.push({
      score: Math.max(0, Math.min(100, 100 - lag.actual * per)),
      detail: lag.detail,
    });
  }
  if (burn.actual !== null) {
    halves.push({ score: Math.max(0, Math.min(100, burn.actual)), detail: burn.detail });
  }
  if (halves.length === 0) {
    return { actual: null, sampleSize: 0, detail: "No invoicing or exception data yet" };
  }

  // Averaged over the halves that HAVE data. A half with nothing to measure is
  // dropped, not scored zero — the snapshot table only keeps ~23 days, so an
  // older month legitimately has no burn-down and the invoicing half should
  // still stand on its own rather than being halved by an absence.
  const score = halves.reduce((s, h) => s + h.score, 0) / halves.length;
  return {
    actual: Math.round(score * 10) / 10,
    sampleSize: lag.sampleSize + burn.sampleSize,
    detail: halves.map((h) => h.detail).join(" · "),
  };
}

/**
 * Half one: document-days of invoicing lag.
 *
 * Cancelled delivery orders are excluded — there is nothing to bill, so
 * counting them would charge Office for a shipment that never happened.
 */
async function invoiceLag(
  c: Context<Env>,
  period: string,
): Promise<MetricResult> {
  const { start, end } = periodBounds(period);
  const def = kpiByKey("documents_not_stuck");
  const grace = Number(def?.graceDays ?? 3);
  const today = new Date().toISOString().slice(0, 10);
  const asAt = today < end ? today : end;

  // DISPATCH, in the owner's word — the day the goods left. (The on-time
  // delivery KPI scores the delivered date instead, BUG-2026-10-08-267.)
  // `deliveredAt` is the fallback for older rows that only carry the arrival
  // date. Still the UTC date: not part of that fix.
  const res = await c.var.DB.prepare(
    `SELECT d.id AS "id",
            substr(COALESCE(NULLIF(d.dispatchedAt::text, ''), d.deliveredAt::text), 1, 10) AS "dispatched",
            substr(MIN(i.invoiceDate)::text, 1, 10) AS "invoiced"
       FROM delivery_orders d
       LEFT JOIN invoices i ON i.deliveryOrderId = d.id
      WHERE d.status <> 'CANCELLED'
        AND COALESCE(NULLIF(d.dispatchedAt::text, ''), d.deliveredAt::text) IS NOT NULL
        AND substr(COALESCE(NULLIF(d.dispatchedAt::text, ''), d.deliveredAt::text), 1, 10) >= ?
        AND substr(COALESCE(NULLIF(d.dispatchedAt::text, ''), d.deliveredAt::text), 1, 10) <= ?
      GROUP BY d.id, d.dispatchedAt, d.deliveredAt`,
  )
    .bind(start, end)
    .all<{ id: string; dispatched: string | null; invoiced: string | null }>();

  const rows = res.results ?? [];
  if (rows.length === 0) return EMPTY;

  let lateDays = 0;
  let lateDocs = 0;
  let uninvoiced = 0;
  for (const r of rows) {
    const from = String(r.dispatched ?? "").slice(0, 10);
    if (!from) continue;
    const to = r.invoiced ? String(r.invoiced).slice(0, 10) : asAt;
    if (!r.invoiced) uninvoiced += 1;
    const late = Math.max(0, daysBetweenYmd(from, to) - grace);
    if (late > 0) {
      lateDays += late;
      lateDocs += 1;
    }
  }

  return {
    actual: lateDays,
    sampleSize: rows.length,
    detail:
      `${lateDays} days late across ${lateDocs} of ${rows.length} delivery orders` +
      (uninvoiced > 0 ? ` (${uninvoiced} still not invoiced, counted to ${asAt})` : ""),
  };
}

/** Whole days from one YYYY-MM-DD to another; negative clamps to 0. */
function daysBetweenYmd(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

/**
 * A supervisor's score for the month, or null if they have not rated it yet.
 *
 * Deliberately returns "not yet rated" rather than 0. An unrated month is the
 * supervisor's outstanding task, not the employee's failure, and scoring it as
 * a zero would quietly punish the employee for their manager's inaction.
 */
export async function manualRating(
  c: Context<Env>,
  period: string,
  userId: string,
  kpiKey: string,
): Promise<MetricResult> {
  const row = await c.var.DB.prepare(
    `SELECT score AS "score", note AS "note"
       FROM kpi_manual_ratings
      WHERE period = ? AND userId = ? AND kpiKey = ?
      LIMIT 1`,
  )
    .bind(period, userId, kpiKey)
    .first<{ score: number | null; note: string | null }>();

  if (!row || row.score === null || row.score === undefined) {
    return { actual: null, sampleSize: 0, detail: "Not yet rated by the supervisor" };
  }
  const score = Number(row.score) || 0;
  return {
    actual: score,
    sampleSize: 1,
    detail: row.note ? `${score}/100 — ${row.note}` : `${score}/100`,
  };
}

/**
 * How much of the daily exception list gets cleared.
 *
 * Compares the period's FIRST stored compliance snapshot with its LAST. The
 * snapshot table is a cache rebuilt many times a day, so a row is that day's
 * last build — good enough for a trend, and the only history that exists.
 * Only ~23 days are retained, so an older period legitimately has no answer;
 * it says so rather than inventing one.
 */
export async function exceptionsCleared(
  c: Context<Env>,
  period: string,
  excludeInvoiceBuckets = false,
): Promise<MetricResult> {
  const { start, end } = periodBounds(period);
  const res = await c.var.DB.prepare(
    `SELECT cache_key AS "day", data AS "payload"
       FROM reports_compliance_snapshot
      WHERE cache_key >= ? AND cache_key <= ?
      ORDER BY cache_key`,
  )
    .bind(start, end)
    .all<{ day: string; payload: unknown }>();

  const rows = res.results ?? [];
  if (rows.length < 2) {
    return {
      actual: null,
      sampleSize: rows.length,
      detail:
        rows.length === 0
          ? "No exception history for this period"
          : "Only one day recorded — needs at least two to show a trend",
    };
  }
  const totalOf = (p: unknown): number => {
    const d = typeof p === "string" ? safeParse(p) : p;
    const counts = (d as { counts?: Record<string, number> })?.counts ?? {};
    const total = Number(counts.total) || 0;
    if (!excludeInvoiceBuckets) return total;
    // The uninvoiced buckets are scored by the invoicing half of the same KPI.
    // Leaving them in here charged one late invoice twice — which is exactly
    // why the owner merged the two KPIs on 2026-08-07.
    const billed =
      (Number(counts.soNoInvoice) || 0) + (Number(counts.doNotInvoiced) || 0);
    return Math.max(0, total - billed);
  };
  const first = totalOf(rows[0].payload);
  const last = totalOf(rows[rows.length - 1].payload);
  if (first <= 0) return EMPTY;
  // Cleared share of what was open at the start. A month that ENDS with more
  // than it started scores 0 rather than a negative.
  const cleared = Math.max(0, first - last);
  const label = excludeInvoiceBuckets ? " non-invoice exceptions" : "";
  return {
    actual: Math.round((cleared / first) * 1000) / 10,
    sampleSize: rows.length,
    detail: `${first}${label} open at the start, ${last} at the end (${rows.length} days recorded)`,
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/**
 * CHECKLIST — items ticked ÷ items defined.
 *
 * The denominator comes from the CODE catalogue, not the database, so nobody
 * can raise their own score by shortening the list. The ticks are facts about
 * what was done; the list is the standard, and the standard lives in one place.
 */
export async function checklistProgress(
  c: Context<Env>,
  userId: string,
  kpiKey: string,
  period: string,
  totalItems: number,
): Promise<MetricResult> {
  if (totalItems <= 0) return EMPTY;
  const row = await c.var.DB.prepare(
    `SELECT COUNT(*) AS n FROM kpi_checklist_ticks
      WHERE userId = ? AND period = ? AND kpiKey = ? AND done = TRUE
        AND itemIndex >= 0 AND itemIndex < ?`,
  )
    .bind(userId, period, kpiKey, totalItems)
    .first<{ n: number }>();
  const done = Math.min(totalItems, Number(row?.n) || 0);
  return {
    actual: Math.round((done / totalItems) * 1000) / 10,
    sampleSize: totalItems,
    detail: `${done} of ${totalItems} items done`,
  };
}

/**
 * SURVEY — the average of the replies received this month.
 *
 * One reply scores (sum of its five 1–5 answers ÷ 25) × 100, so five 5s is 100
 * and four 5s with one 4 is 96. The month's figure is the mean across replies;
 * a month with none has no figure rather than a zero, because nobody asking is
 * a different failure from customers answering badly, and scoring it as 0
 * would hide which one happened.
 */
export async function surveyMean(
  c: Context<Env>,
  userId: string,
  kpiKey: string,
  period: string,
): Promise<MetricResult> {
  const res = await c.var.DB.prepare(
    `SELECT q1, q2, q3, q4, q5 FROM kpi_survey_responses
      WHERE userId = ? AND kpiKey = ? AND period = ?`,
  )
    .bind(userId, kpiKey, period)
    .all<{ q1: number; q2: number; q3: number; q4: number; q5: number }>();
  const rows = res.results ?? [];
  if (rows.length === 0) {
    return { actual: null, sampleSize: 0, detail: "No replies received yet" };
  }
  let total = 0;
  for (const r of rows) {
    const sum = [r.q1, r.q2, r.q3, r.q4, r.q5].reduce(
      (a, v) => a + (Number(v) || 0),
      0,
    );
    total += (sum / 25) * 100;
  }
  const mean = Math.round((total / rows.length) * 10) / 10;
  return {
    actual: mean,
    sampleSize: rows.length,
    detail: `${mean} average across ${rows.length} repl${rows.length === 1 ? "y" : "ies"}`,
  };
}

/** Dispatch table — one entry per computable KPI. */
/**
 * Factory production efficiency for the month.
 *
 * Reuses computeMonthlyEfficiencyByWorker — the SAME function behind the
 * efficiency allowance and the daily report's low-efficiency list. Writing a
 * second query here would eventually disagree with the payslip, and an
 * employee who can point at two different efficiency numbers has stopped
 * believing both.
 *
 * Aggregated across workers rather than averaged: a worker with 4 hours and
 * one with 180 must not weigh the same. Total earned minutes over total
 * production hours is the factory's real figure.
 *
 * NOTE: this is the FLOOR's efficiency, not the assignee's own. App users
 * carry no employee link (`users` has no employee_id), so a personal figure
 * cannot be resolved yet. Assign this to whoever owns the floor's output.
 *
 * DEV-36: an assignment can carry a scope (one or more departments, each
 * optionally one category, pooled). Everyone assigned that scope shares its
 * figure, a team score.
 */
export async function productionEfficiency(
  c: Context<Env>,
  period: string,
  scope?: EfficiencyScope | null,
): Promise<MetricResult> {
  const { start, end } = periodBounds(period);
  const byWorker = await computeMonthlyEfficiencyByWorker(c.var.DB, start, end, scope ?? undefined);
  const where = scope?.length
    ? ` in ${scope.map((p) => (p.category ? `${p.dept} ${p.category}` : p.dept)).join(" + ")}`
    : "";

  let minutes = 0;
  let hours = 0;
  let counted = 0;
  for (const w of byWorker.values()) {
    if (!(w.prodHours > 0)) continue;
    minutes += w.prodMinutes;
    hours += w.prodHours;
    counted += 1;
  }
  if (hours <= 0) {
    return { actual: null, sampleSize: 0, detail: `No production hours logged${where} this month` };
  }
  const pct = Math.round((minutes / (hours * 60)) * 1000) / 10;
  return {
    actual: pct,
    sampleSize: counted,
    detail: `${Math.round(minutes).toLocaleString()} standard minutes earned on ${Math.round(hours).toLocaleString()} production hours, across ${counted} workers${where}`,
  };
}

/**
 * Department efficiency: the Dashboard Experimental > People > Efficiency
 * figure for the month, for the workers whose home department is one of the
 * assignment's departments (DEV-36). No departments = everyone, the page with
 * no department picked.
 *
 * Built by lib/workforce-perf.ts, the same code the dashboard route runs, from
 * the same tables, so this card and the page cannot disagree. The month's rows
 * only: every per-day figure depends on that day's rows alone.
 */
export async function departmentEfficiency(
  c: Context<Env>,
  period: string,
  scope?: EfficiencyScope | null,
): Promise<MetricResult> {
  const { start } = periodBounds(period);
  const [y, m] = period.split("-").map(Number);
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const orgId = getOrgId(c);
  const db = c.var.DB;

  const depts = await db.prepare(`SELECT code, is_production FROM departments`)
    .all<{ code: string; isProduction: number | boolean | null }>();
  const productionDepts = new Set(
    (depts.results ?? []).filter((d) => d.isProduction).map((d) => String(d.code)),
  );
  const whe = await db.prepare(
    `SELECT worker_id, date, department_code, hours
       FROM working_hour_entries
      WHERE org_id = ? AND date >= ? AND date < ?`,
  )
    .bind(orgId, start, next)
    .all<PerfWheRow>();
  const doneInMonth = `org_id = ?
          AND status IN ('COMPLETED','TRANSFERRED')
          AND completed_date IS NOT NULL
          AND completed_date >= ? AND completed_date < ?`;
  const jobCards = await db.prepare(
    `SELECT id, department_code, pic1_id, pic2_id, completed_date,
            est_minutes, actual_minutes, wip_qty
       FROM job_cards
      WHERE ${doneInMonth}`,
  )
    .bind(orgId, start, next)
    .all<PerfJcRow>();
  const pics = await db.prepare(
    `SELECT job_card_id, pic1_id, pic2_id FROM piece_pics
      WHERE org_id = ? AND job_card_id IN (SELECT id FROM job_cards WHERE ${doneInMonth})`,
  )
    .bind(orgId, orgId, start, next)
    .all<PerfPicRow>();

  let workerIds: Set<string> | null = null;
  if (scope?.length) {
    const want = new Set(scope.map((s) => s.dept));
    const ws = await db.prepare(`SELECT id, department_code FROM workers`)
      .all<{ id: string; departmentCode: string | null }>();
    workerIds = new Set(
      (ws.results ?? []).filter((w) => want.has(String(w.departmentCode ?? ""))).map((w) => String(w.id)),
    );
  }

  const { perfDays } = buildPerfDays({
    whe: whe.results ?? [],
    jobCards: jobCards.results ?? [],
    pics: pics.results ?? [],
    productionDepts,
  });
  const r = poolEfficiencyPct(perfDays, workerIds, (d) => d.startsWith(period));
  const where = scope?.length ? ` in ${scope.map((s) => s.dept).join(" + ")}` : "";
  if (r.pct === null) {
    return { actual: null, sampleSize: 0, detail: `No production hours clocked${where} this month` };
  }
  const h = (min: number) => Math.round(min / 60).toLocaleString();
  const daily = dailyEfficiencyPct(perfDays, workerIds, (d) => d.startsWith(period));
  return {
    actual: Math.round(r.pct * 10) / 10,
    sampleSize: r.days,
    daily,
    detail: `${h(r.productionMinutes)} production hours on ${h(r.workingMinutes)} clocked hours over ${r.days} days${where}`,
  };
}

/**
 * Average days a service case stays open.
 *
 * Owner 2026-08-07: "平均解决天数在 7 天之内可以拿到最高分。超出 7 天后，每增加
 * 1 天就扣 12.5 分，最多可以扣 8 天（即到第 15 天时全部分数扣完）."
 *
 * Counts cases CLOSED in the month AND cases still open at the end of it, the
 * open ones measured up to today. Scoring only the closed ones would make
 * "never close it" the highest-scoring strategy available, and the two cases
 * sitting OPEN right now would be invisible in every month forever.
 *
 * A month with no cases reports "no cases" rather than 0 — the KPI is about
 * how fast complaints get closed, and no complaints is not a failure to close
 * them quickly.
 */
export async function serviceCaseResolution(
  c: Context<Env>,
  period: string,
): Promise<MetricResult> {
  const { start, end } = periodBounds(period);
  const today = new Date().toISOString().slice(0, 10);
  const asAt = today < end ? today : end;

  const res = await c.var.DB.prepare(
    `SELECT id AS "id",
            substr(createdAt::text, 1, 10) AS "raised",
            substr(NULLIF(closedAt::text, '')::text, 1, 10) AS "closed",
            status AS "status"
       FROM service_cases
      WHERE createdAt IS NOT NULL
        AND (
              (closedAt IS NOT NULL AND closedAt <> ''
               AND substr(closedAt::text, 1, 10) >= ?
               AND substr(closedAt::text, 1, 10) <= ?)
           OR ((closedAt IS NULL OR closedAt = '')
               AND substr(createdAt::text, 1, 10) <= ?)
        )`,
  )
    .bind(start, end, end)
    .all<{ id: string; raised: string | null; closed: string | null; status: string | null }>();

  const rows = (res.results ?? []).filter((r) => r.raised);
  if (rows.length === 0) {
    return { actual: null, sampleSize: 0, detail: "No service cases this month" };
  }

  let totalDays = 0;
  let stillOpen = 0;
  let overSeven = 0;
  for (const r of rows) {
    const to = r.closed || asAt;
    if (!r.closed) stillOpen += 1;
    const d = daysBetweenYmd(String(r.raised), to);
    totalDays += d;
    if (d > 7) overSeven += 1;
  }
  const avg = Math.round((totalDays / rows.length) * 10) / 10;

  return {
    actual: avg,
    sampleSize: rows.length,
    detail:
      `${avg} days average across ${rows.length} cases` +
      (overSeven > 0 ? `, ${overSeven} past 7 days` : "") +
      (stillOpen > 0 ? ` (${stillOpen} still open, counted to ${asAt})` : ""),
  };
}

export async function computeMetric(
  c: Context<Env>,
  key: string,
  period: string,
  scope?: string | null,
  /** The KPI with the company's saved rules applied (`withRules`). */
  def?: KpiDef,
): Promise<MetricResult> {
  switch (key) {
    case "customer_delivery_date":
      return customerDeliveryLate(c, period, def);
    case "setup_completeness":
      return setupCompleteness(c);
    case "documents_not_stuck":
      return documentsStuck(c, period);
    case "production_efficiency":
      return productionEfficiency(c, period, parseEfficiencyScope(scope));
    case "department_efficiency":
      return departmentEfficiency(c, period, parseEfficiencyScope(scope));
    case "service_case_resolution":
      return serviceCaseResolution(c, period);
    default:
      return EMPTY;
  }
}
