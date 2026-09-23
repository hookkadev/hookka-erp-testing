// TAB_REGISTRY — the ONLY place a dashboard tab is wired to its screen.
//
// To add a tab: create tabs/<Name>Tab.tsx exporting a component that takes
// DashboardTabProps (see types.ts), add its key to MOBILE_TABS and register it
// here. Sub-tabs: useDashboardSub(<key>) + <MSubPills/> (same ?sub= keys as
// desktop). Do not touch DashboardScreen.tsx (the shell) — it
// renders whatever is registered. The tab reads its own data with
// useDashboardFeed() (or its own cached endpoint) and owns its loading / error
// / empty states.
import { type ComponentType } from "react";
import type { MobileTabKey } from "./dashboard-m-lib";
import { FinanceTab } from "./tabs/FinanceTab";
import { OperationsTab } from "./tabs/OperationsTab";
import { OverviewTab } from "./tabs/OverviewTab";
import { PeopleTab } from "./tabs/PeopleTab";
import { SalesTab } from "./tabs/SalesTab";
import { ServiceTab } from "./tabs/ServiceTab";
import type { DashboardTabProps } from "./types";

export const TAB_REGISTRY: Record<MobileTabKey, ComponentType<DashboardTabProps>> = {
  overview: OverviewTab,
  sales: SalesTab,
  operations: OperationsTab,
  people: PeopleTab,
  service: ServiceTab,
  finance: FinanceTab,
};
