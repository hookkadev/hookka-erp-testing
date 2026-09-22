// Shape of GET /api/dashboard/prototype (src/api/routes/dashboard-prototype.ts)
// as the /m dashboard reads it. Every tab reads this SAME cached payload via
// useDashboardFeed(); a new tab widens this type with the slice it needs
// (mirror the desktop view's own `Feed` type — the fields are identical).
import type { Period } from "../../../dashboards/dashboard-shared-lib";
import type { MobileTabKey } from "./dashboard-m-lib";

export const DASHBOARD_FEED_URL = "/api/dashboard/prototype";

/** Props the shell hands EVERY tab (see TAB_REGISTRY in registry.tsx). */
export type DashboardTabProps = {
  /** Resolved period (month set once the feed has months). Pass to inPeriod / inFocus. */
  period: Period;
  setPeriod: (p: Period) => void;
  /** Months that have sales, oldest → newest. */
  months: string[];
  /** Jump to another tab keeping the period: openTab("sales"). */
  openTab: (tab: MobileTabKey) => void;
};

export type FeedSalesOrder = {
  id: string;
  no: string | null;
  customer: string | null;
  status: string;
  totalSen: number;
  createdAt: string | null;
  deliveryDate: string | null;
  isServiceOrder: boolean;
};

export type DashboardFeed = {
  success?: boolean;
  meta?: { months?: string[]; monthsWithSales?: string[] };
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
    orders: FeedSalesOrder[];
    byStateCategory: { state: string | null; category: string | null; revenueSen: number }[];
  };
  delivery?: { statusBreakdown?: { key: string; label: string; count: number; valueSen: number }[] };
  production?: {
    totals?: { active: number; critical: number; atRisk: number; backlogCards: number };
    bottleneck?: { dept: string | null; cards: number; orders: number };
  };
  inventory?: { totals?: { items: number; active: number; withStock: number; stockValueSen: number } };
  employee?: {
    attendance?: { employeeName: string | null; date: string | null; status: string | null; efficiencyPct: number | null }[];
  };
  purchase?: { totals?: { active: number; all: number } };
};
