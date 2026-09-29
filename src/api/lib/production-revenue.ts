// ---------------------------------------------------------------------------
// Production revenue per day — ONE query, shared by the dashboard's Daily
// (Lim) tab (routes/dashboard-prototype.ts) and the evening efficiency email
// (routes/reports.ts, BUG-36), so the two can never disagree.
//
// Definition (same as the main dashboard's Production line and the Employee
// page's /production-revenue): a PO books on the day its LAST upholstery job
// card completes, priced SO line → CO line → product master × qty,
// SOFA/BEDFRAME/ACCESSORY only. It is the value of what production finished,
// NOT invoiced or delivered revenue. Orders whose price resolves to 0 are
// counted in `unpricedOrders`, not hidden.
//
// Owner-confirmed 2026-09-29: 28 Sep 2026 = RM 12,002.50 (24 orders, 1
// unpriced) on the dashboard, which is this query.
// ---------------------------------------------------------------------------

export type ProductionRevenueDay = {
  date: string;
  orders: number | string;
  unpricedOrders: number | string;
  revenueSen: number | string;
};

type Db = {
  prepare(sql: string): {
    bind(...v: unknown[]): { all<T>(): Promise<{ results?: T[] }> };
  };
};

/** Every day with production revenue for the org, or just `day` when given. */
export async function productionRevenueByDay(
  db: Db,
  orgId: string,
  day?: string,
): Promise<ProductionRevenueDay[]> {
  const r = await db
    .prepare(
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
    .all<ProductionRevenueDay>();
  // Day filter in JS so the SQL stays exactly what the dashboard has run in
  // production. It scans every day for a one-day email; push the filter
  // into SQL if this ever gets slow (the dashboard pays the same scan).
  const rows = r.results ?? [];
  return day ? rows.filter((x) => x.date === day) : rows;
}
