// ---------------------------------------------------------------------------
// customer-credit.ts — the ONE customer credit gate (BUG-34, 2026-09-28).
//
// Two rules block goods leaving for a customer (DO create, DO dispatch,
// consignment note):
//
//   1. PAYMENT_OVERDUE — the customer has an issued, unpaid invoice past the
//      due date of THEIR credit term (src/lib/terms.ts dueDateForTerms: NET30
//      January bill is due end of February, blocked from 1 March). The due
//      date is derived from invoiceDate + the customer's CURRENT term on every
//      check, not read from invoices.dueDate, so old invoices stamped with the
//      former "+30 days" rule are judged by the same calendar-month rule.
//   2. CREDIT_LIMIT_EXCEEDED — outstanding A/R + undelivered DOs + this DO >
//      credit limit. outstandingSen only moves when a DO is DELIVERED (the
//      auto-invoice), so DOs already created but not delivered are added here;
//      without them N DOs created back to back each passed on their own.
//      creditLimitSen <= 0 = no limit configured → rule 2 is skipped.
//
// Admin override (testing phase): body.creditOverride = { reason } lets a user
// with delivery-orders:credit-override (ADMIN / SUPER_ADMIN always) pass a
// block, audited. kv_config "credit-override-enabled" = false turns the
// override off for everyone (strict SOP) without a deploy. Missing key = ON.
// ---------------------------------------------------------------------------
import type { Context } from "hono";
import type { Env } from "../worker";
import { dueDateForTerms } from "../../lib/terms";
import { todayYmdMY } from "../../lib/utils";
import { loadSoLinePriceIndex, priceForItem } from "./do-value";
import { hasPermission } from "./rbac";
import { emitAudit } from "./audit";

export const CREDIT_OVERRIDE_KEY = "credit-override-enabled";

/** DO statuses whose goods are committed but not yet in outstandingSen. */
const PENDING_DO_STATUSES = ["DRAFT", "LOADED", "IN_TRANSIT"];

export type CreditItem = {
  productionOrderId?: string | null;
  productCode?: string | null;
  quantity: number;
  /** Fallback SO for pricing when the item has no production order. */
  salesOrderId?: string | null;
};

export type UnpaidInvoice = {
  invoiceNo: string;
  invoiceDate: string;
  balanceSen: number;
};

export type CreditState = {
  customerId: string;
  name: string;
  creditTerms: string | null;
  limitSen: number;
  outstandingSen: number;
  pendingDoSen: number;
  unpaid: UnpaidInvoice[];
};

export type CreditBlock =
  | {
      code: "PAYMENT_OVERDUE";
      error: string;
      details: {
        customerId: string;
        customerName: string;
        creditTerms: string | null;
        overdueSen: number;
        overdue: Array<UnpaidInvoice & { dueDate: string }>;
      };
    }
  | {
      code: "CREDIT_LIMIT_EXCEEDED";
      error: string;
      details: {
        customerId: string;
        customerName: string;
        limit: number;
        outstanding: number;
        pendingDo: number;
        doTotal: number;
        projected: number;
      };
    };

/** Pure decision — no I/O, so tests pin the rules directly. */
export function decideCredit(
  s: CreditState,
  addSen: number,
  today: string,
): CreditBlock | null {
  const overdue = s.unpaid
    .filter((i) => i.balanceSen > 0)
    .map((i) => ({ ...i, dueDate: dueDateForTerms(i.invoiceDate, s.creditTerms) }))
    .filter((i) => i.invoiceDate && i.dueDate < today)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  if (overdue.length > 0) {
    const overdueSen = overdue.reduce((t, i) => t + i.balanceSen, 0);
    return {
      code: "PAYMENT_OVERDUE",
      error: `${s.name} has ${overdue.length} overdue invoice${overdue.length === 1 ? "" : "s"} (RM ${(overdueSen / 100).toFixed(2)}) past their ${s.creditTerms || "credit"} term. Collect payment before releasing goods.`,
      details: {
        customerId: s.customerId,
        customerName: s.name,
        creditTerms: s.creditTerms,
        overdueSen,
        overdue,
      },
    };
  }
  if (s.limitSen > 0) {
    const projected = s.outstandingSen + s.pendingDoSen + addSen;
    if (projected > s.limitSen) {
      return {
        code: "CREDIT_LIMIT_EXCEEDED",
        error: `Credit limit exceeded for ${s.name}: RM ${(projected / 100).toFixed(2)} would be owed against a limit of RM ${(s.limitSen / 100).toFixed(2)}.`,
        details: {
          customerId: s.customerId,
          customerName: s.name,
          limit: s.limitSen,
          outstanding: s.outstandingSen,
          pendingDo: s.pendingDoSen,
          doTotal: addSen,
          projected,
        },
      };
    }
  }
  return null;
}

type PriceIndex = Awaited<ReturnType<typeof loadSoLinePriceIndex>>;

function priceItems(idx: PriceIndex, items: CreditItem[]): number {
  let sen = 0;
  for (const it of items) {
    sen +=
      priceForItem(idx, it.productionOrderId, it.salesOrderId, it.productCode) *
      (Number(it.quantity) || 0);
  }
  return sen;
}

/**
 * Loads the customer's credit state and prices `items` (the goods about to
 * leave) with the shared DO value resolver (do-value.ts), so "this DO" and
 * "undelivered DOs" are valued exactly like the invoice will be.
 * `excludeDoId` keeps a DO being re-checked (dispatch) out of pendingDoSen
 * when its own items are passed as `items`.
 */
export async function loadCreditCheck(
  db: D1Database,
  customerId: string,
  items: CreditItem[],
  excludeDoId?: string,
): Promise<{ state: CreditState; addSen: number } | null> {
  const cust = await db
    .prepare(
      `SELECT id, name, orgId, creditTerms, creditLimitSen, outstandingSen
         FROM customers WHERE id = ?`,
    )
    .bind(customerId)
    .first<Record<string, unknown>>();
  if (!cust) return null;

  const invRes = await db
    .prepare(
      `SELECT invoiceNo, invoiceDate, totalSen, paidAmount
         FROM invoices
        WHERE customerId = ?
          AND UPPER(status) NOT IN ('DRAFT', 'PAID', 'CANCELLED')`,
    )
    .bind(customerId)
    .all<Record<string, unknown>>();
  const unpaid: UnpaidInvoice[] = (invRes.results ?? []).map((r) => ({
    invoiceNo: String(r.invoiceNo ?? r.invoice_no ?? ""),
    invoiceDate: String(r.invoiceDate ?? r.invoice_date ?? "").slice(0, 10),
    balanceSen:
      (Number(r.totalSen ?? r.total_sen) || 0) -
      (Number(r.paidAmount ?? r.paid_amount) || 0),
  }));

  const limitSen = Number(cust.creditLimitSen ?? cust.credit_limit_sen) || 0;
  let pendingDoSen = 0;
  let addSen = 0;
  // Pricing is only needed for the quota rule; skip the whole-org price index
  // when the customer has no limit.
  if (limitSen > 0) {
    const ph = PENDING_DO_STATUSES.map(() => "?").join(",");
    const pendRes = await db
      .prepare(
        `SELECT di.productionOrderId, di.productCode, di.quantity, d.salesOrderId
           FROM delivery_order_items di
           JOIN delivery_orders d ON d.id = di.deliveryOrderId
          WHERE d.customerId = ? AND d.status IN (${ph}) AND d.id <> ?`,
      )
      .bind(customerId, ...PENDING_DO_STATUSES, excludeDoId ?? "")
      .all<Record<string, unknown>>();
    const pending: CreditItem[] = (pendRes.results ?? []).map((r) => ({
      productionOrderId: (r.productionOrderId ?? r.production_order_id ?? null) as string | null,
      productCode: (r.productCode ?? r.product_code ?? null) as string | null,
      quantity: Number(r.quantity) || 0,
      salesOrderId: (r.salesOrderId ?? r.sales_order_id ?? null) as string | null,
    }));
    // ponytail: whole-org price index per check (same cost the DELIVERED
    // auto-invoice already pays); narrow it to this customer's SOs if slow.
    const idx = await loadSoLinePriceIndex(db, String(cust.orgId ?? cust.org_id ?? "hookka"));
    pendingDoSen = priceItems(idx, pending);
    addSen = priceItems(idx, items);
  }

  return {
    state: {
      customerId,
      name: String(cust.name ?? customerId),
      creditTerms: (cust.creditTerms ?? cust.credit_terms ?? null) as string | null,
      limitSen,
      outstandingSen: Number(cust.outstandingSen ?? cust.outstanding_sen) || 0,
      pendingDoSen,
      unpaid,
    },
    addSen,
  };
}

export async function checkCustomerCredit(
  db: D1Database,
  customerId: string,
  items: CreditItem[],
  excludeDoId?: string,
): Promise<CreditBlock | null> {
  const r = await loadCreditCheck(db, customerId, items, excludeDoId);
  return r ? decideCredit(r.state, r.addSen, todayYmdMY()) : null;
}

/** Override switch (kv_config) + the caller's permission. */
export async function creditOverrideAllowed(c: Context<Env>): Promise<boolean> {
  try {
    const row = await c.var.DB.prepare("SELECT value FROM kv_config WHERE key = ?")
      .bind(CREDIT_OVERRIDE_KEY)
      .first<{ value: string }>();
    if (row && JSON.parse(row.value) === false) return false;
    return await hasPermission(c, "delivery-orders", "credit-override");
  } catch {
    // System callers (delivery agent shim) have no user → never override.
    return false;
  }
}

export type CreditGateOutcome =
  | { ok: true }
  | { ok: false; status: 403 | 409; body: Record<string, unknown> };

/**
 * Apply a block (or none) to a request: pass, pass on an allowed override
 * (audited against `resource`/`resourceId`), or return the error body. The
 * body carries `overrideAllowed` so the UI shows the Override button only
 * when the server would accept it.
 */
export async function gateCredit(
  c: Context<Env>,
  block: CreditBlock | null,
  override: unknown,
  audit: { resource: string; resourceId: string },
): Promise<CreditGateOutcome> {
  if (!block) return { ok: true };
  const reason =
    override && typeof override === "object"
      ? String((override as { reason?: unknown }).reason ?? "").trim()
      : "";
  const allowed = await creditOverrideAllowed(c);
  if (reason && allowed) {
    await emitAudit(c, {
      resource: audit.resource,
      resourceId: audit.resourceId,
      action: "credit-override",
      after: { code: block.code, reason, details: block.details },
    });
    return { ok: true };
  }
  return {
    ok: false,
    status: reason ? 403 : 409,
    body: {
      success: false,
      error: reason
        ? `Credit override is not allowed. ${block.error}`
        : block.error,
      code: block.code,
      details: block.details,
      overrideAllowed: allowed,
    },
  };
}
