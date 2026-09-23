// Overview tab — phone port of the desktop AllOverviewView: four hero KPIs +
// one tappable summary card per domain. Same feed, same calculations
// (dashboards/dashboard-sales-lib.ts), phone layout. Cards jump to their tab.
import { useMemo, type ReactNode } from "react";
import { ChevronRight, Factory, Package, ShoppingCart, Truck, Users } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { AMBER, fmtN, periodLabel, dayLabel } from "../../../../dashboards/dashboard-shared-lib";
import { overviewSalesSnapshot, overviewTotals, overviewWorkforce } from "../../../../dashboards/dashboard-sales-lib";
import { MobileCard } from "../../../components";
import { M } from "../../../theme";
import { compactSen } from "../dashboard-m-lib";
import { useDashboardFeed } from "../hooks";
import { MDelta, MKpi, MKpiGrid, MSection, MState } from "../primitives";
import type { DashboardTabProps } from "../types";

function DomainCard({
  title,
  icon: Icon,
  stats,
  note,
  onOpen,
}: {
  title: string;
  icon: typeof Factory;
  stats: { label: string; value: string }[];
  note?: ReactNode;
  onOpen: () => void;
}) {
  return (
    <MobileCard radius={16} onClick={onOpen} style={{ minHeight: 44 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Icon size={17} strokeWidth={1.9} color={M.taupe} style={{ flex: "none" }} />
        <div style={{ flex: 1, fontSize: 14, fontWeight: 700, color: M.raisin }}>{title}</div>
        <ChevronRight size={18} strokeWidth={1.75} color="#C4BDB2" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
        {stats.map((s) => (
          <div key={s.label} style={{ minWidth: 0 }}>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4, color: M.muted }}>{s.label}</div>
            <div
              style={{
                fontSize: 13.5,
                fontWeight: 700,
                color: M.raisin,
                fontVariantNumeric: "tabular-nums",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {s.value}
            </div>
          </div>
        ))}
      </div>
      {note ? <div style={{ fontSize: 11.5, color: AMBER, marginTop: 8 }}>{note}</div> : null}
    </MobileCard>
  );
}

export function OverviewTab({ period, months, openTab }: DashboardTabProps) {
  const { feed, loading, error } = useDashboardFeed();

  const totals = useMemo(
    () => overviewTotals(feed?.sales?.byDay ?? [], period, months),
    [feed, period, months],
  );
  const sales = useMemo(
    () => overviewSalesSnapshot(feed?.sales?.orders ?? [], feed?.sales?.byStateCategory ?? [], period),
    [feed, period],
  );
  const workforce = useMemo(
    () => overviewWorkforce(feed?.employee?.attendance ?? [], period, fmtN),
    [feed, period],
  );

  if (loading) return <MState kind="loading" />;
  if (error || !feed?.success) return <MState kind="error" text={`Couldn't load Overview: ${error ?? "unknown error"}`} />;

  const prod = feed.production?.totals;
  const neck = feed.production?.bottleneck;
  const inv = feed.inventory?.totals;
  const outstanding = (feed.delivery?.statusBreakdown ?? []).find((s) => /outstand|pending|open/i.test(s.key + s.label));
  const suffix = period.day ? "day" : period.mode === "monthly" ? "MTD" : "YTD";

  return (
    <div style={{ padding: "12px 14px 0" }}>
      <div style={{ fontSize: 12.5, color: M.muted, margin: "0 4px 10px" }}>
        {periodLabel(period)} · Key operational bottlenecks &amp; priority action items
      </div>

      <MKpiGrid>
        <MKpi
          label={`Revenue (${suffix})`}
          value={compactSen(totals.revenueSen, formatCurrency)}
          tone={M.taupe}
          onClick={() => openTab("sales")}
          sub={
            <>
              <MDelta pct={totals.deltaPct} vs={totals.prevLabel || "—"} />
              <div>{fmtN(totals.orders)} orders</div>
            </>
          }
        />
        <MKpi
          label="Factory backlog"
          value={prod ? fmtN(prod.backlogCards) : "—"}
          sub={prod ? `${fmtN(prod.active)} active orders` : "no production feed"}
          onClick={() => openTab("operations")}
        />
        <MKpi
          label="Bottleneck"
          value={neck?.dept || "—"}
          sub={neck?.dept ? `${fmtN(neck.cards)} cards · ${fmtN(neck.orders)} orders` : "no production feed"}
          onClick={() => openTab("operations")}
        />
        <MKpi
          label="Critical alerts"
          value={prod ? `${fmtN(prod.critical)} critical` : "—"}
          tone={prod && prod.critical > 0 ? "#9A3A2D" : undefined}
          sub={prod ? `${fmtN(prod.atRisk)} more at risk` : "no production feed"}
          onClick={() => openTab("operations")}
        />
      </MKpiGrid>

      <MSection title="Domains">
        <div style={{ display: "grid", gap: 10 }}>
          <DomainCard
            title="Sales & Demand"
            icon={ShoppingCart}
            onOpen={() => openTab("sales")}
            stats={[
              { label: "Top customer", value: sales.topCustomer },
              { label: `Revenue ${suffix}`, value: formatCurrency(totals.revenueSen) },
              { label: "Top state (all time)", value: sales.topState },
              { label: "Category (all time)", value: sales.topCategory },
            ]}
          />
          <DomainCard
            title="Production & Floor"
            icon={Factory}
            onOpen={() => openTab("operations")}
            stats={[
              { label: "Active jobs", value: prod ? fmtN(prod.active) : "—" },
              { label: "Bottleneck", value: neck?.dept || "—" },
              { label: "Backlog cards", value: prod ? fmtN(prod.backlogCards) : "—" },
              { label: "Critical", value: prod ? fmtN(prod.critical) : "—" },
            ]}
          />
          <DomainCard
            title="Fulfillment & Deliveries"
            icon={Truck}
            onOpen={() => openTab("operations")}
            stats={[
              { label: "Outstanding", value: outstanding ? fmtN(outstanding.count) : "—" },
              { label: "Value", value: outstanding ? formatCurrency(outstanding.valueSen) : "—" },
              { label: "Delivery rows", value: fmtN(feed.availability?.delivery?.rows ?? 0) },
              { label: "Feed", value: feed.availability?.delivery?.live ? "live" : "not live" },
            ]}
          />
          <DomainCard
            title="Workforce & Attendance"
            icon={Users}
            onOpen={() => openTab("people")}
            stats={[
              { label: workforce.presentDay ? `Present (${dayLabel(workforce.presentDay)})` : "Present", value: workforce.presentLabel },
              { label: "Efficiency avg", value: workforce.avg == null ? "—" : `${workforce.avg.toFixed(1)}%` },
              { label: "Roster", value: `${fmtN(feed.availability?.employee?.workers ?? 0)} active` },
              { label: "Measured days", value: fmtN(workforce.measuredDays) },
            ]}
            note={workforce.avg == null ? "No efficiency recorded in this period — not shown as 0%." : undefined}
          />
          <DomainCard
            title="Inventory & Supply"
            icon={Package}
            onOpen={() => openTab("operations")}
            stats={[
              { label: "Stock value", value: inv ? compactSen(inv.stockValueSen, formatCurrency) : "—" },
              { label: "Items tracked", value: inv ? fmtN(inv.items) : "—" },
              { label: "Items with stock", value: inv ? fmtN(inv.withStock) : "—" },
              { label: "Active POs", value: fmtN(feed.purchase?.totals?.active ?? 0) },
            ]}
          />
        </div>
      </MSection>
    </div>
  );
}
