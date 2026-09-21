import { useMemo } from "react";
import { useCachedJson } from "@/lib/cached-fetch";
import { PeriodPicker } from "./dashboard-shared";
import type { Period, PeopleSub, OpsSub, ServiceSub, FinSub } from "./dashboard-shared-lib";
import { TAB_SUBS } from "./dashboard-url-state-lib";
import { useDashboardUrlState } from "./use-dashboard-url-state";
import { FinanceView } from "./FinanceView";
import { AllOverviewView } from "./AllOverviewView";
import { SalesOrdersView } from "./SalesOrdersView";
import { OperationsView } from "./OperationsView";
import { EmployeesView } from "./EmployeesView";
import { DepartmentsView } from "./DepartmentsView";
import { ServiceView } from "./ServiceView";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, type TabItem } from "@/components/ui/tabs";

// ---------------------------------------------------------------------------
// Dashboard Prototype — a native React port of the design prototype, which
// used to be a single 8,356-line static HTML report loaded into a sandboxed
// iframe (deleted 2026-09-04). That approach was rejected: wrong theme
// (auto-dark, fought the app's own light theme), boxed internal scrolling,
// and — the real reason — it was a dead end for a REAL page: nothing in an
// injected srcdoc document can be a real, navigable, testable React screen.
//
// Tabs are named after the FUNCTION, never after the person who reads them:
// Overview, Sales, Operations, People, Service, Finance — the same keys the
// /m dashboard uses (m/screens/dashboard/dashboard-m-lib.ts). A reviewer has
// no tab of their own: each chart lives in the tab that owns it, approvals
// live in Service > Approvals, and Overview's "Needs action" strip links
// there. All read the same cached GET /api/dashboard/prototype payload; no
// tab has an endpoint of its own.
// The remaining domain tabs (Delivery, Inventory, Purchase, Production) live
// on laphii/feature/dashboard / other branches and land in follow-ups.
//
// PERIOD: the Monthly/YTD picker below the tab strip is global. Tabs with a
// date column filter by it; Inventory and Production are point-in-time
// snapshots and say so rather than pretending the picker applies.
//
// THEME (owner 2026-09-08): the first React port kept the static prototype's
// own look — Fraunces/Public Sans/IBM Plex Mono loaded from Google Fonts, a
// cream (#FBF7F1) background, and a hand-rolled palette that only
// approximated the app's real tokens. That made this page visibly a
// different product from the rest of the ERP. It now uses the SAME
// PageHeader / Card / Tabs / StatusBadge components and the same hex
// tokens (#1F1D1B ink, #6B5C32 taupe, #6B7280 muted, #E2DDD8 border — see
// src/index.css and src/pages/sales/index.tsx) as every other page, and no
// font is loaded — the app's default font-sans (system-ui) applies here too.
// ---------------------------------------------------------------------------

// Old keys (siti / lim / employee / department) still resolve: see LEGACY in
// dashboard-url-state-lib.ts.
const TABS: TabItem<"overview" | "sales" | "operations" | "people" | "service" | "finance">[] = [
  { key: "overview", label: "Overview" },
  { key: "sales", label: "Sales" },
  { key: "operations", label: "Operations" },
  { key: "people", label: "People" },
  { key: "service", label: "Service" },
  { key: "finance", label: "Finance" },
];

const TAB_KEYS = TABS.map((t) => t.key);

export default function DashboardPrototypePage() {
  // Tab, sub-tab and period all live in the URL (use-dashboard-url-state.ts):
  // refresh keeps the place, Back/Forward walks tab changes. Sub-tabs are ONE
  // value keyed by the current tab; see TAB_SUBS in dashboard-url-state-lib.ts.
  type TabKey = (typeof TABS)[number]["key"];
  const { tab, sub, period, setTab, setSub, setPeriod } = useDashboardUrlState<TabKey>(TAB_KEYS);
  const subTabs = TAB_SUBS[tab];

  // The page reads the feed only for `meta.months` — the months that actually
  // exist in the book, which bound the stepper. Every tab below calls the same
  // cached URL, so this costs no extra request.
  const { data } = useCachedJson<{
    meta?: { months?: string[]; monthsWithSales?: string[] };
    sales?: { byDay?: { date: string }[] };
  }>("/api/dashboard/prototype");

  // Driven by the months that actually HAVE SALES, not `meta.months` — that is
  // a union with attendance, and this org has three months holding one
  // attendance row and no sales at all. Offering them made YTD look broken:
  // stepping to Apr 2026 and pressing YTD showed only April, because the
  // Jan-Apr window genuinely contains no other sales month, while the picker
  // implied Feb was there to be found.
  //
  // Stays sales-driven now that the Employees tab has landed too. Attendance
  // covers three extra months (2025-08, 2025-12, 2026-02) holding ONE row each;
  // owner 2026-09-15 confirmed those are test rows, not a real 2025 book, so
  // widening to the union would offer a year the factory never traded in. If a
  // genuine earlier book ever arrives, this becomes a per-tab list rather than
  // a wider shared one — a picker cannot serve two coverage sets silently.
  const months = useMemo(
    () => data?.meta?.monthsWithSales ?? data?.meta?.months ?? [],
    [data],
  );

  // The newest day that actually carries data — the datepicker presets anchor
  // to this rather than to today or to the end of the newest month, either of
  // which can select a window the book has no rows for.
  const latestDay = useMemo(
    () => (data?.sales?.byDay ?? []).reduce((m, d) => (d.date > m ? d.date : m), ""),
    [data],
  );

  // The selected month is DERIVED, not synced with an effect: until the user
  // picks one (and any time the stored month is not in the book) it resolves
  // to the newest month that exists. Doing this with a setState-in-effect
  // caused a cascading re-render on every load.
  const effectivePeriod = useMemo<Period>(
    () => ({
      ...period,
      month:
        period.month && months.includes(period.month)
          ? period.month
          : (months[months.length - 1] ?? ""),
    }),
    [period, months],
  );

  return (
    <div className="space-y-6 max-md:space-y-4">
      {/* Sticky: the title, the tab strip and the period control stay put while
          a long tab scrolls, so you can switch tab or month without scrolling
          back up. -mx/px cancels the page gutter so the backdrop reaches the
          full width; the bottom border separates it from the content beneath. */}
      <div className="sticky top-0 z-30 -mx-4 px-4 md:-mx-6 md:px-6 pt-1 pb-3 max-md:pb-2 bg-[#F7F5F3]/95 backdrop-blur border-b border-[#E2DDD8] space-y-3 max-md:space-y-2">
        {/* Phones: no big title and no tab strip (keeps the sticky block to two
            short rows) - the tab is a native <select> beside the period button
            below, which opens the OS picker. md+: the PageHeader, unchanged. */}
        <h1 className="sr-only md:hidden">Dashboard</h1>
        <PageHeader
          className="max-md:hidden"
          title="Dashboard"
          subtitle="Live where noted"
          actions={<Tabs tabs={TABS} value={tab} onChange={setTab} variant="pill" />}
        />

        {/* Sub-tab strip shares this sticky row with the period picker, so
            both stay put while a long tab scrolls. */}
        <div className="flex flex-wrap items-center justify-between gap-2 max-md:gap-y-2">
          <select
            aria-label="Dashboard section"
            value={tab}
            onChange={(e) => setTab(e.target.value as TabKey)}
            className="md:hidden order-1 h-11 min-w-0 flex-1 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm font-semibold text-[#1F1D1B] focus:outline-none focus:border-[#6B5C32]"
          >
            {TABS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          {subTabs ? (
            <div className="max-md:order-3 max-md:w-full min-w-0">
              <Tabs tabs={[...subTabs]} value={sub} onChange={setSub} variant="pill" scrollable />
            </div>
          ) : (
            <div />
          )}
          {months.length > 0 && (
            <div className="max-md:order-2">
              <PeriodPicker
                period={effectivePeriod}
                months={months}
                latestDay={latestDay}
                onChange={setPeriod}
              />
            </div>
          )}
        </div>
      </div>

      {tab === "overview" && (
        <AllOverviewView
          period={effectivePeriod}
          months={months}
          onOpenTab={(t, s) => setTab(t as TabKey, s)}
        />
      )}
      {tab === "sales" && (
        <SalesOrdersView period={effectivePeriod} months={months} onPeriodChange={setPeriod} />
      )}
      {tab === "operations" && <OperationsView period={effectivePeriod} sub={sub as OpsSub} onPeriodChange={setPeriod} />}
      {tab === "people" && ((sub as PeopleSub) === "departments"
        ? <DepartmentsView period={effectivePeriod} />
        : <EmployeesView period={effectivePeriod} sub={sub as Exclude<PeopleSub, "departments">} onPeriodChange={setPeriod} />)}
      {tab === "service" && <ServiceView period={effectivePeriod} sub={sub as ServiceSub} onPeriodChange={setPeriod} onSubChange={(x) => setSub(x)} />}
      {tab === "finance" && <FinanceView period={effectivePeriod} sub={sub as FinSub} months={months} onPeriodChange={setPeriod} />}
    </div>
  );
}
