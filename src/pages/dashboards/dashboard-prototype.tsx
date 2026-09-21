import { useMemo, useState } from "react";
import { useCachedJson } from "@/lib/cached-fetch";
import { PeriodPicker } from "./dashboard-shared";
import type { Period } from "./dashboard-shared-lib";
import { AllOverviewView } from "./AllOverviewView";
import { SalesOrdersView } from "./SalesOrdersView";
import { SitiOpsView } from "./SitiOpsView";
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
// This branch carries THREE tabs — All Overview (the landing tab), Sales
// Orders, and a draft "Operations (Siti)" tab tracking the owner's report
// checklist handed over on paper. All read the same cached
// GET /api/dashboard/prototype payload; no tab has an endpoint of its own.
// The remaining domain tabs (Delivery, Inventory, Purchase, Employees,
// Production) live on laphii/feature/dashboard / other branches and land in
// follow-ups.
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

// The three tabs being trialled on main. Operations (Siti) is a draft — see
// SitiOpsView.tsx's own header comment for what's real vs. stubbed.
const TABS: TabItem<"overview" | "sales" | "siti">[] = [
  { key: "overview", label: "All Overview" },
  { key: "sales", label: "Sales Orders" },
  { key: "siti", label: "Operations (Siti)" },
];

export default function DashboardPrototypePage() {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("overview");
  const [period, setPeriod] = useState<Period>({ mode: "monthly", month: "" });

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
  // This list stays sales-driven when the Employees tab lands too. Attendance
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
      <div className="sticky top-0 z-30 -mx-4 px-4 md:-mx-6 md:px-6 pt-1 pb-3 bg-[#F7F5F3]/95 backdrop-blur border-b border-[#E2DDD8] space-y-3">
        <PageHeader
          title="Overview"
          subtitle="Operations · live where noted"
          actions={
            <Tabs tabs={TABS} value={tab} onChange={setTab} variant="pill" />
          }
        />

        {months.length > 0 && (
          <div className="flex justify-end">
            <PeriodPicker
              period={effectivePeriod}
              months={months}
              latestDay={latestDay}
              onChange={setPeriod}
            />
          </div>
        )}
      </div>

      {tab === "overview" && (
        <AllOverviewView
          period={effectivePeriod}
          months={months}
          onOpenTab={(t) => setTab(t as (typeof TABS)[number]["key"])}
        />
      )}
      {tab === "sales" && (
        <SalesOrdersView period={effectivePeriod} months={months} onPeriodChange={setPeriod} />
      )}
      {tab === "siti" && <SitiOpsView period={effectivePeriod} />}
    </div>
  );
}
