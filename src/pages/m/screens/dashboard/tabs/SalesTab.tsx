// Sales tab — phone port of the desktop SalesOrdersView essentials: KPI tiles
// with deltas, revenue trend (bars, tap-to-focus a day / open a month in YTD),
// top customers, recent orders. The numbers come from the SAME pure functions
// the desktop view uses (dashboards/dashboard-sales-lib.ts).
//
// Dropped vs desktop (desktop-only, heavy): sales attribution (customer x time
// lines), rolling revenue forecast, state donut / SKU table (byStateCategory
// panels), fulfilment pipeline breakdown, and the orders line on the trend
// chart (phone chart is revenue bars only; order count shows in the caption).
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { formatCurrency } from "@/lib/utils";
import {
  fmtN, fmtRMAxis, dayLabel, inFocus, inPeriod, isConfirmedOrder, periodLabel, ymd,
} from "../../../../dashboards/dashboard-shared-lib";
import {
  buildSalesTrend, computeSalesKpis, customerRevenue, pctDelta, previousSalesKpis,
} from "../../../../dashboards/dashboard-sales-lib";
import { ListRow, MobileCard, StatusPill } from "../../../components";
import { resolveStatus, STATUS_MAPS } from "../../../config/helpers";
import { M } from "../../../theme";
import { compactSen, tapBucket } from "../dashboard-m-lib";
import { useDashboardFeed } from "../hooks";
import { MChartCard, MFocusChip, MKpi, MKpiGrid, MRankList, MSection, MState } from "../primitives";
import type { DashboardTabProps } from "../types";

const TOP_CUSTOMERS = 5;
const RECENT_ORDERS = 15;

export function SalesTab({ period, setPeriod, months }: DashboardTabProps) {
  const navigate = useNavigate();
  const { feed, loading, error } = useDashboardFeed();

  // Days after "today" are unknown, not zero — the trend zero-fill stops here.
  const today = useMemo(() => ymd(new Date()), []);

  const allOrders = useMemo(() => feed?.sales?.orders ?? [], [feed]);
  const allByDay = useMemo(() => feed?.sales?.byDay ?? [], [feed]);
  const orders = useMemo(() => allOrders.filter((o) => inPeriod(period, o.createdAt)), [allOrders, period]);
  const byDay = useMemo(() => allByDay.filter((d) => inPeriod(period, d.date)), [allByDay, period]);

  const chartData = useMemo(
    () => buildSalesTrend(byDay, period, today),
    // buildSalesTrend reads only these fields of `period`; `day` must not rebuild it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byDay, period.mode, period.month, period.from, period.to, today],
  );
  const selected = useMemo(() => chartData.find((d) => d.iso === period.day) ?? null, [chartData, period.day]);

  // A focused day narrows every order-scoped panel to it (chart keeps the month).
  const scoped = useMemo(
    () => (selected ? orders.filter((o) => inFocus(period, o.createdAt)) : orders),
    [orders, period, selected],
  );
  const kpis = useMemo(() => computeSalesKpis(scoped), [scoped]);
  const prev = useMemo(
    () => previousSalesKpis(allOrders, period, months, !!selected),
    [allOrders, period, months, selected],
  );
  const top = useMemo(
    () => customerRevenue(scoped.filter((o) => isConfirmedOrder(o.status))).slice(0, TOP_CUSTOMERS),
    [scoped],
  );
  const recent = useMemo(
    () => [...scoped].sort((a, b) => ((a.createdAt ?? "") < (b.createdAt ?? "") ? 1 : -1)).slice(0, RECENT_ORDERS),
    [scoped],
  );

  if (loading) return <MState kind="loading" />;
  if (error || !feed?.success) return <MState kind="error" text={`Couldn't load Sales: ${error ?? "unknown error"}`} />;

  const clearDay = () => setPeriod({ ...period, day: undefined });
  const money = (sen: number) => compactSen(sen, formatCurrency);
  const orderSub = (now: number, before: number | undefined) =>
    prev && before && before > 0 ? `${pctDelta(now, before)} vs ${prev.label}` : undefined;
  const scopeLabel = selected ? dayLabel(selected.iso) : periodLabel(period);

  return (
    <div style={{ padding: "12px 14px 0" }}>
      <MKpiGrid>
        <MKpi label="Orders" value={fmtN(kpis.soCount)} sub={orderSub(kpis.soCount, prev?.count)} />
        <MKpi label="Revenue" value={money(kpis.revenueSen)} tone={M.taupe} sub={orderSub(kpis.revenueSen, prev?.revenueSen)} />
        <MKpi label="Outstanding" value={fmtN(kpis.outstandingCount)} tone="#9C6F1E" sub={`${money(kpis.outstandingSen)} value`} />
        <MKpi label="Pending delivery" value={fmtN(kpis.pendingDelivery)} tone="#3E6570" sub={`${money(kpis.pendingDeliverySen)} value`} />
        <div style={{ gridColumn: "1 / -1" }}>
          <MKpi label="Completed" value={fmtN(kpis.completedCount)} tone="#4F7C3A" />
        </div>
      </MKpiGrid>

      <MSection title="Revenue trend">
        <MChartCard
          title={period.mode === "ytd" ? "Revenue by month" : "Revenue by day"}
          subtitle={
            selected
              ? `${dayLabel(selected.iso)} · ${formatCurrency(selected.Revenue * 100)} · ${fmtN(selected.Orders)} orders`
              : `${periodLabel(period)} · tap a bar to ${period.mode === "ytd" ? "open that month" : "focus that day"}`
          }
          data={chartData.map((d) => ({ key: d.date, value: d.Revenue }))}
          selectedKey={selected?.date ?? null}
          onSelect={(k) => setPeriod(tapBucket(period, chartData, k))}
          formatAxis={fmtRMAxis}
          emptyText="No orders in range."
          footer={selected ? <MFocusChip label={dayLabel(selected.iso)} onClear={clearDay} /> : undefined}
        />
      </MSection>

      <MSection title="Top customers" hint={scopeLabel}>
        <MRankList
          items={top.map((c) => ({
            key: c.name,
            label: c.name,
            sub: `${fmtN(c.count)} ${c.count === 1 ? "order" : "orders"}`,
            value: c.revenueSen,
            valueLabel: money(c.revenueSen),
          }))}
          emptyText="No confirmed orders in this window."
        />
      </MSection>

      <MSection title="Recent orders" hint={`${scopeLabel} · ${fmtN(recent.length)} shown`}>
        {recent.length === 0 ? (
          <MobileCard>
            <MState
              kind="empty"
              text={selected ? `No transactions recorded for ${dayLabel(selected.iso)}.` : "No orders in this window."}
              action={selected ? <MFocusChip label={dayLabel(selected.iso)} onClear={clearDay} /> : undefined}
            />
          </MobileCard>
        ) : (
          <MobileCard padded={false} radius={16} style={{ overflow: "hidden" }}>
            {recent.map((o) => {
              const st = resolveStatus(o.status, STATUS_MAPS.so);
              return (
                <ListRow
                  key={o.id}
                  code={o.no ?? o.id}
                  title={o.customer ?? "—"}
                  subLine={o.createdAt ?? undefined}
                  meta={[{ label: "Total", value: formatCurrency(o.totalSen) }]}
                  pill={<StatusPill style={st.style} label={st.label} size="sm" />}
                  onClick={() => navigate(`/m/sales/${o.id}`)}
                />
              );
            })}
          </MobileCard>
        )}
      </MSection>
    </div>
  );
}
