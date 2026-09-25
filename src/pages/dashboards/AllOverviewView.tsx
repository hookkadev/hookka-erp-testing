import { useMemo } from "react";
import { Link } from "react-router-dom";
import { isUnknownOutcome, useCachedJson } from "@/lib/cached-fetch";
import { formatCurrency } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowRight, TrendingUp, TrendingDown } from "lucide-react";
import {
  MUTED, GREEN, RED, AMBER, fmtN, fmtRM2, widgetPeriod, widgetPeriodLabel,
  periodLabel, dayLabel, isConfirmedOrder, type Period,
} from "./dashboard-shared-lib";
import { LiveBadge } from "./dashboard-shared";
import { overviewTotals, overviewSalesSnapshot, overviewWorkforce } from "./dashboard-sales-lib";
import { complianceSummary, monthWindow, type ComplianceResp, type Overview } from "./dashboard-widgets-lib";
import { OcrAccuracyCard } from "../dashboard-b/OcrAccuracyCard";

// All Overview — the dashboard's landing tab, ported from the static design
// prototype's own first screen. Reads the SAME GET /api/dashboard/prototype
// feed the six domain tabs read; it adds no endpoint of its own, because every
// figure below already ships in that payload.
//
// Period: `meta.months` is the list of months that actually exist in the book,
// which is why the route sends the whole sales table rather than a window (see
// its "Whole book, not a window" comment). Monthly reads one month; YTD reads
// every month of the selected month's year up to and including it.
//
// A domain card links onward only when its tab is mounted (Sales, Operations,
// Employees); the others show their figures without a dead "Open" button.
//
// "Needs action" is the reviewer's entry point — there is no per-person tab.
// Each tile is a count plus a link to the sub-tab that owns the list; the
// approval queue itself lives once, in Service > Approvals.
//
// HONESTY RULE followed here: a figure whose source has no date column is NOT
// relabelled as if it were period-scoped. Top state / dominant category come
// from `byStateCategory`, which carries no date, so they are labelled "all
// time" rather than silently inheriting the month in the picker.

type Feed = {
  success?: boolean;
  meta?: { months?: string[] };
  availability?: {
    sales?: { live: boolean; rows: number };
    production?: { live: boolean; rows: number };
    employee?: { live: boolean; workers: number };
    inventory?: { live: boolean; rows: number };
    purchase?: { live: boolean; rows: number };
    delivery?: { live: boolean; rows: number };
  };
  sales?: {
    byDay: { date: string; orders: number; revenueSen: number; cancelled: number }[];
    orders: { customer: string | null; totalSen: number; createdAt: string | null; status: string }[];
    byStateCategory: { state: string | null; category: string | null; revenueSen: number }[];
  };
  delivery?: { statusBreakdown?: { key: string; label: string; count: number; valueSen: number }[] };
  production?: {
    overdueByDept?: { department: string; count: number }[];
    dueSoon3Days?: unknown[];
    totals?: { active: number; critical: number; atRisk: number; backlogCards: number };
    bottleneck?: { dept: string | null; cards: number; orders: number };
  };
  inventory?: { totals?: { items: number; active: number; withStock: number; stockValueSen: number } };
  employee?: {
    attendance?: { employeeName: string | null; date: string | null; status: string | null; efficiencyPct: number | null }[];
  };
  purchase?: { totals?: { active: number; all: number } };
  // Absent without service-cases:read, or on a feed cached before it shipped.
  service?: { cases: { approvalStatus: string | null; daysOverdue: number }[] } | null;
};

function ActionTile({ label, value, hint, onOpen }: { label: string; value: number | null; hint: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="text-left rounded-md border border-[#E2DDD8] bg-white transition-shadow hover:shadow-md p-4 max-md:p-3 min-h-11 hover:bg-[#F7F5F3] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#6B5C32]"
    >
      <p className="text-2xl max-md:text-xl font-bold tabular-nums" style={{ color: value ? RED : value === 0 ? GREEN : MUTED }}>
        {value == null ? "—" : fmtN(value)}
      </p>
      <p className="text-xs font-medium text-[#1F1D1B] flex items-center gap-1">
        {label}
        <ArrowRight className="h-3 w-3 shrink-0" />
      </p>
      <p className="text-xs" style={{ color: MUTED }}>{hint}</p>
    </button>
  );
}

function Delta({ pct, vs }: { pct: number | null; vs: string }) {
  if (pct === null) {
    return <p className="text-xs" style={{ color: MUTED }}>no prior period to compare</p>;
  }
  const up = pct >= 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <p className="text-xs flex items-center gap-1" style={{ color: up ? GREEN : RED }}>
      <Icon className="h-3 w-3 shrink-0" />
      <span className="tabular-nums font-medium">
        {up ? "+" : ""}{pct.toFixed(1)}%
      </span>
      <span style={{ color: MUTED }}>vs {vs}</span>
    </p>
  );
}

function Hero({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-4 space-y-1">
        <p className="text-[11px] uppercase tracking-wide" style={{ color: MUTED }}>
          {label}
        </p>
        <p className="text-2xl font-bold tabular-nums truncate text-[#1F1D1B]">{value}</p>
        {children}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide truncate" style={{ color: MUTED }}>{label}</p>
      <p className="text-sm font-semibold tabular-nums truncate text-[#1F1D1B]">{value}</p>
    </div>
  );
}

function DomainCard({
  title,
  stats,
  note,
  noteTone,
  cta,
  onOpen,
}: {
  title: string;
  stats: { label: string; value: string }[];
  note?: string;
  noteTone?: string;
  cta?: string;
  onOpen?: () => void;
}) {
  return (
    <Card className="flex flex-col">
      <CardContent className="p-4 flex flex-col gap-3 flex-1">
        <p className="text-sm font-semibold text-[#1F1D1B]">
          {title}
        </p>
        <div className="grid grid-cols-2 gap-3 flex-1">
          {stats.map((s) => (
            <Stat key={s.label} label={s.label} value={s.value} />
          ))}
        </div>
        {note && <p className="text-xs" style={{ color: noteTone ?? MUTED }}>{note}</p>}
        {cta && onOpen && (
          <Button variant="outline" size="sm" className="w-full justify-between" onClick={onOpen}>
            {cta}
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function AllOverviewView({
  period,
  months,
  onOpenTab,
}: {
  period: Period;
  months: string[];
  onOpenTab: (tab: string, sub: string | undefined) => void;
}) {
  const { data, loading, error } = useCachedJson<Feed>("/api/dashboard/prototype");
  // Invoices KPI + Daily Report tile — the SAME URLs
  // /dashboard reads, derived with the same formulas (dashboard-widgets-lib.ts).
  const wp = widgetPeriod(period);
  const wpLabel = widgetPeriodLabel(period);
  const { data: ovRaw, loading: ovLoading } = useCachedJson<Overview>(`/api/dashboard/overview?period=${wp}`);
  const ovData = ovRaw && ovRaw.success !== false ? ovRaw : null;
  const { data: compRaw, loading: compLoading, failure: compFailure } =
    useCachedJson<ComplianceResp>("/api/reports/compliance.json");
  // A dead read is not a clean day (C15): only a 2xx body licenses a number.
  const comp = complianceSummary(compRaw, isUnknownOutcome(compFailure));

  const totals = useMemo(
    () => overviewTotals(data?.sales?.byDay ?? [], period, months),
    [data, period, months],
  );

  // Whole-book reconciliation. Deliberately ignores the period picker: its job
  // is to be compared against the house Sales page, which shows the book.
  //
  // It also CHECKS itself rather than just printing a number. The order rows
  // and the day buckets are built from the same query but aggregated
  // differently, so if period slicing ever drops or double-counts a row the
  // two stop agreeing — and a reconciliation panel that cannot disagree with
  // itself is decoration.
  const book = useMemo(() => {
    const orders = data?.sales?.orders ?? [];
    const byDay = data?.sales?.byDay ?? [];
    // Same confirmed-order definition the Sales tab and the route use, so the
    // book total cannot disagree with the tab that breaks it down.
    const confirmed = orders.filter((o) => isConfirmedOrder(o.status));
    const rowRevenueSen = confirmed.reduce((t, o) => t + o.totalSen, 0);
    const dayRevenueSen = byDay.reduce((t, d) => t + d.revenueSen, 0);
    const dayOrders = byDay.reduce((t, d) => t + d.orders, 0);
    return {
      orders: confirmed.length,
      excluded: orders.length - confirmed.length,
      revenueSen: rowRevenueSen,
      feedRows: data?.availability?.sales?.rows ?? 0,
      months: months.length,
      days: byDay.length,
      // Compare CONFIRMED against the day buckets, which now also count only
      // confirmed orders. This read `orders.length` (every row, excluded ones
      // included) while the line beside it printed the confirmed count, so the
      // check failed against a number it was not showing.
      ordersAgree: confirmed.length === dayOrders,
      revenueAgree: rowRevenueSen === dayRevenueSen,
      dayOrders,
      dayRevenueSen,
    };
  }, [data, months]);

  const deltaPct = totals.deltaPct;

  const sales = useMemo(
    () => overviewSalesSnapshot(data?.sales?.orders ?? [], data?.sales?.byStateCategory ?? [], period),
    [data, period],
  );

  const workforce = useMemo(
    () => overviewWorkforce(data?.employee?.attendance ?? [], period, fmtN),
    [data, period],
  );

  if (loading) {
    return <div className="py-16 text-center text-sm" style={{ color: MUTED }}>Loading…</div>;
  }
  if (error || !data?.success) {
    return (
      <Card className="border-[#F0D9AE] bg-[#FDF3E4]">
        <CardContent className="p-4 text-sm text-[#B5701A]">
          Couldn't load Overview: {error ?? "unknown error"}
        </CardContent>
      </Card>
    );
  }

  const prod = data.production?.totals;
  const neck = data.production?.bottleneck;
  const inv = data.inventory?.totals;
  const outstanding = (data.delivery?.statusBreakdown ?? []).find((s) =>
    /outstand|pending|open/i.test(s.key + s.label),
  );
  const periodName = periodLabel(period);
  const svc = data.service?.cases;
  const overdueByDept = data.production?.overdueByDept;

  return (
    <div className="space-y-6 max-md:space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Overview</h2>
        <LiveBadge live={!!data.availability?.sales?.live} />
        <span className="text-xs text-[#6B7280]">{periodName}</span>
      </div>

      <p className="text-sm" style={{ color: MUTED }}>
        Key operational bottlenecks &amp; priority action items
      </p>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Hero label={`Total Revenue (${period.day ? "day" : period.mode === "monthly" ? "MTD" : "YTD"})`} value={formatCurrency(totals.revenueSen)}>
          <Delta pct={deltaPct} vs={totals.prevLabel || "—"} />
          <p className="text-xs" style={{ color: MUTED }}>{fmtN(totals.orders)} orders recorded</p>
        </Hero>

        <Hero label="Active Factory Backlog" value={prod ? fmtN(prod.backlogCards) : "—"}>
          <p className="text-xs" style={{ color: MUTED }}>
            {prod ? `${fmtN(prod.active)} active production orders` : "no production feed"}
          </p>
        </Hero>

        <Hero label="Operational Bottleneck" value={neck?.dept || "—"}>
          <p className="text-xs" style={{ color: MUTED }}>
            {neck?.dept ? `${fmtN(neck.cards)} cards · ${fmtN(neck.orders)} orders` : "no production feed"}
          </p>
        </Hero>

        <Hero label="Critical Alerts" value={prod ? `${fmtN(prod.critical)} Critical` : "—"}>
          <p className="text-xs" style={{ color: prod && prod.atRisk > 0 ? AMBER : MUTED }}>
            {prod ? `${fmtN(prod.atRisk)} more at risk` : "no production feed"}
          </p>
        </Hero>

        {/* Invoices KPI (as on /dashboard): Σ invoice totals (excl. cancelled)
            by invoice date for the month, or all-time. */}
        <Hero
          label={`Invoices (${wpLabel})`}
          value={ovData ? fmtRM2(ovData.invoicesThisMonthSen ?? 0) : ovLoading ? "…" : "—"}
         
        >
          <p className="text-xs" style={{ color: ovData || ovLoading ? MUTED : AMBER }}>
            {ovData ? "issued, by invoice date" : ovLoading ? "loading" : "Couldn't load invoices — not shown as zero"}
          </p>
        </Hero>
      </div>

      <section aria-label="Needs action" className="space-y-2">
        <h3 className="text-sm font-semibold text-[#1F1D1B]">Needs action</h3>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 max-md:gap-3">
          <ActionTile
            label="Pending approvals"
            value={svc ? svc.filter((c) => c.approvalStatus === "PENDING").length : null}
            hint={svc ? "service cases and 1-to-1 exchanges" : "no service access"}
            onOpen={() => onOpenTab("service", "approvals")}
          />
          <ActionTile
            label="Service cases overdue"
            value={svc ? svc.filter((c) => c.daysOverdue > 0).length : null}
            hint={svc ? "open past the service deadline" : "no service access"}
            onOpen={() => onOpenTab("service", "overdue")}
          />
          <ActionTile
            label="Production orders overdue"
            value={overdueByDept ? overdueByDept.reduce((a, d) => a + d.count, 0) : null}
            hint={overdueByDept ? "open, past customer date" : "no production feed"}
            onOpen={() => onOpenTab("operations", undefined)}
          />
          <ActionTile
            label="Due within 3 days"
            value={data.production?.dueSoon3Days?.length ?? null}
            hint="production early warning"
            onOpen={() => onOpenTab("operations", undefined)}
          />
          {/* Daily Report — process / SOP exceptions, same summary as the
              /dashboard tile. Failed = "—", partial = a floor ("+"). */}
          <Link
            to="/daily-report"
            className="text-left rounded-md border border-[#E2DDD8] bg-white transition-shadow hover:shadow-md p-4 max-md:p-3 min-h-11 hover:bg-[#F7F5F3] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#6B5C32]"
          >
            <p
              className="text-2xl max-md:text-xl font-bold tabular-nums"
              style={{ color: comp.failed || comp.partial ? MUTED : comp.total === 0 ? GREEN : RED }}
            >
              {compLoading && !comp.counts ? "…" : comp.failed ? "—" : `${fmtN(comp.total)}${comp.partial ? "+" : ""}`}
            </p>
            <p className="text-xs font-medium text-[#1F1D1B] flex items-center gap-1">
              Daily Report
              <ArrowRight className="h-3 w-3 shrink-0" />
            </p>
            <p className="text-xs" style={{ color: MUTED }}>
              {compLoading && !comp.counts ? "loading" : comp.caption}
            </p>
            {comp.chips.length > 0 && (
              <p className="mt-1 text-[11px]" style={{ color: RED }}>
                {comp.chips.map(([l, n]) => `${l} ${fmtN(n)}`).join(" · ")}
              </p>
            )}
          </Link>
        </div>
      </section>

      {/* Whole-book reconciliation — the panel to compare against the house
          Sales page. Ignores the period picker on purpose. */}
      <Card className="bg-white border-[#E5E0D8]">
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-semibold text-[#1F1D1B]">Book totals</p>
            <p className="text-xs" style={{ color: MUTED }}>
              Whole book, all {fmtN(book.months)} months · not filtered by the period above
            </p>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <p className="text-2xl font-bold tabular-nums text-[#1F1D1B]">{fmtN(book.orders)}</p>
              <p className="text-xs" style={{ color: MUTED }}>
                Total sales orders
              </p>
              <p className="text-[11px]" style={{ color: MUTED }}>
                {fmtN(book.excluded)} draft/cancelled/on-hold excluded · service orders included
              </p>
            </div>
            <div>
              <p className="text-2xl font-bold tabular-nums text-[#1F1D1B]">
                {formatCurrency(book.revenueSen)}
              </p>
              <p className="text-xs" style={{ color: MUTED }}>
                Total revenue
              </p>
              <p className="text-[11px]" style={{ color: MUTED }}>
                draft, cancelled and on-hold excluded
              </p>
            </div>
            <div>
              <p className="text-2xl font-bold tabular-nums text-[#1F1D1B]">{fmtN(book.days)}</p>
              <p className="text-xs" style={{ color: MUTED }}>
                Days with orders
              </p>
            </div>
            <div>
              <p className="text-2xl font-bold tabular-nums text-[#1F1D1B]">{fmtN(book.feedRows)}</p>
              <p className="text-xs" style={{ color: MUTED }}>
                Rows the feed reports
              </p>
            </div>
          </div>

          {/* Self-check. Order rows and day buckets come from one query but are
              aggregated separately, so a mismatch means the slicing lost or
              duplicated rows — worth seeing rather than trusting. */}
          <div className="border-t border-[#E5E0D8] pt-2.5 space-y-1">
            {[
              {
                label: "Order rows = sum of day buckets",
                ok: book.ordersAgree,
                detail: `${fmtN(book.orders)} vs ${fmtN(book.dayOrders)}`,
              },
              {
                label: "Row revenue = sum of day buckets",
                ok: book.revenueAgree,
                detail: `${formatCurrency(book.revenueSen)} vs ${formatCurrency(book.dayRevenueSen)}`,
              },
              {
                label: "Feed rows = confirmed + excluded",
                ok: book.feedRows === book.orders + book.excluded,
                detail: `${fmtN(book.feedRows)} vs ${fmtN(book.orders)} confirmed + ${fmtN(book.excluded)} excluded`,
              },
            ].map((c) => (
              <p key={c.label} className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
                <span
                  className="font-semibold shrink-0"
                  style={{ color: c.ok ? GREEN : RED }}
                >
                  {c.ok ? "✓" : "✗"}
                </span>
                <span className="text-[#1F1D1B]">{c.label}</span>
                <span className="tabular-nums" style={{ color: c.ok ? MUTED : RED }}>
                  — {c.detail}
                </span>
              </p>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <DomainCard
          title="Sales &amp; Demand Snapshot"
          stats={[
            { label: "Top customer", value: sales.topCustomer },
            { label: `Revenue ${period.day ? "this day" : period.mode === "monthly" ? "this period" : "YTD"}`, value: formatCurrency(totals.revenueSen) },
            { label: "Top state (all time)", value: sales.topState },
            { label: "Dominant category (all time)", value: sales.topCategory },
          ]}
          cta="Open Sales"
          onOpen={() => onOpenTab("sales", undefined)}
        />

        <DomainCard
          title="Production &amp; Floor Status"
          stats={[
            { label: "Active jobs", value: prod ? fmtN(prod.active) : "—" },
            { label: "Bottleneck", value: neck?.dept || "—" },
            { label: "Backlog cards", value: prod ? fmtN(prod.backlogCards) : "—" },
            { label: "Critical", value: prod ? fmtN(prod.critical) : "—" },
          ]}
          cta="Open Operations"
          onOpen={() => onOpenTab("operations", undefined)}
        />

        <DomainCard
          title="Fulfillment &amp; Deliveries"
          stats={[
            { label: "Outstanding", value: outstanding ? fmtN(outstanding.count) : "—" },
            { label: "Value", value: outstanding ? formatCurrency(outstanding.valueSen) : "—" },
            { label: "Delivery rows", value: fmtN(data.availability?.delivery?.rows ?? 0) },
            { label: "Feed", value: data.availability?.delivery?.live ? "live" : "not live" },
          ]}
        />

        <DomainCard
          title="Workforce &amp; Attendance"
          stats={[
            { label: workforce.presentDay ? `Present (${dayLabel(workforce.presentDay)})` : "Present", value: workforce.presentLabel },
            { label: "Team efficiency avg", value: workforce.avg == null ? "—" : `${workforce.avg.toFixed(1)}%` },
            { label: "Roster", value: `${fmtN(data.availability?.employee?.workers ?? 0)} active` },
            { label: "Measured days", value: fmtN(workforce.measuredDays) },
          ]}
          note={workforce.avg == null ? "No efficiency recorded in this period — not shown as 0%." : undefined}
          noteTone={AMBER}
          cta="Open Employees"
          onOpen={() => onOpenTab("people", "efficiency")}
        />

        <DomainCard
          title="Inventory &amp; Supply Chain"
          stats={[
            { label: "Stock value on hand", value: inv ? formatCurrency(inv.stockValueSen) : "—" },
            { label: "Items tracked", value: inv ? fmtN(inv.items) : "—" },
            { label: "Items with stock", value: inv ? fmtN(inv.withStock) : "—" },
            { label: "Active POs", value: fmtN(data.purchase?.totals?.active ?? 0) },
          ]}
        />
      </div>

      {/* OCR accuracy — shared with /dashboard, same period rule. */}
      <OcrAccuracyCard period={wp} range={wp === "all" ? null : monthWindow(wp)} />
    </div>
  );
}
