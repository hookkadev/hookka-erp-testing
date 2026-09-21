// TAB_REGISTRY — the ONLY place a dashboard tab is wired to its screen.
//
// To build a phone-native tab: create tabs/<Name>Tab.tsx exporting a component
// that takes DashboardTabProps (see types.ts), import it here and replace that
// key's `desktopTab(...)` line. Do not touch DashboardScreen.tsx (the shell) — it
// renders whatever is registered. The tab reads its own data with
// useDashboardFeed() (or its own cached endpoint) and owns its loading / error
// / empty states.
import { type ComponentType, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Tabs } from "@/components/ui/tabs";
import { ToastProvider } from "@/components/ui/toast";
import type { Period, OpsSub, PeopleSub, ServiceSub, FinSub } from "../../../dashboards/dashboard-shared-lib";
import { TAB_SUBS } from "../../../dashboards/dashboard-url-state-lib";
import { OperationsView } from "../../../dashboards/OperationsView";
import { EmployeesView } from "../../../dashboards/EmployeesView";
import { DepartmentsView } from "../../../dashboards/DepartmentsView";
import { ServiceView } from "../../../dashboards/ServiceView";
import { FinanceView } from "../../../dashboards/FinanceView";
import type { MobileTabKey } from "./dashboard-m-lib";
import { OverviewTab } from "./tabs/OverviewTab";
import { SalesTab } from "./tabs/SalesTab";
import type { DashboardTabProps } from "./types";

// ponytail: these four tabs mount the DESKTOP view, which is already laid out
// for phones (its max-md classes), under a phone sub-tab strip — one set of
// charts and maths, not two. Give a tab its own tabs/<Name>Tab.tsx only if the
// desktop layout proves too dense on a real phone. Sub-tab = ?sub=, the same
// param the desktop page uses, so a link means the same thing on both.
// ToastProvider: /m has none and the approvals queue reports through a toast.
function desktopTab(
  tab: string,
  render: (sub: string, setSub: (s: string) => void, p: DashboardTabProps) => ReactNode,
): ComponentType<DashboardTabProps> {
  return function DesktopTab(props) {
    const [params, setParams] = useSearchParams();
    const subs = TAB_SUBS[tab];
    const sub = subs.find((s) => s.key === params.get("sub"))?.key ?? subs[0].key;
    const setSub = (s: string) =>
      setParams((prev) => { const n = new URLSearchParams(prev); n.set("sub", s); return n; });
    return (
      <ToastProvider>
        <div className="px-3 pt-3 pb-6 space-y-3">
          <Tabs tabs={[...subs]} value={sub} onChange={setSub} variant="pill" scrollable className="max-md:w-full" />
          {render(sub, setSub, props)}
        </div>
      </ToastProvider>
    );
  };
}
const on = (p: DashboardTabProps) => ({ period: p.period, onPeriodChange: (x: Period) => p.setPeriod(x) });

export const TAB_REGISTRY: Record<MobileTabKey, ComponentType<DashboardTabProps>> = {
  overview: OverviewTab,
  sales: SalesTab,
  operations: desktopTab("operations", (sub, _set, p) => <OperationsView {...on(p)} sub={sub as OpsSub} />),
  people: desktopTab("people", (sub, _set, p) =>
    sub === "departments"
      ? <DepartmentsView period={p.period} />
      : <EmployeesView {...on(p)} sub={sub as Exclude<PeopleSub, "departments">} />),
  service: desktopTab("service", (sub, setSub, p) => <ServiceView {...on(p)} sub={sub as ServiceSub} onSubChange={setSub} />),
  finance: desktopTab("finance", (sub, _set, p) => <FinanceView {...on(p)} sub={sub as FinSub} months={p.months} />),
};
