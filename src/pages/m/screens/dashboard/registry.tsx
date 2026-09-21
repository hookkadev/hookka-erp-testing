// TAB_REGISTRY — the ONLY place a dashboard tab is wired to its screen.
//
// To build a tab: create tabs/<Name>Tab.tsx exporting a component that takes
// DashboardTabProps (see types.ts), import it here and replace that key's
// `placeholder(...)` line. Do not touch DashboardScreen.tsx (the shell) — it
// renders whatever is registered. The tab reads its own data with
// useDashboardFeed() (or its own cached endpoint) and owns its loading / error
// / empty states.
import { type ComponentType } from "react";
import { Hammer } from "lucide-react";
import { M } from "../../theme";
import type { MobileTabKey } from "./dashboard-m-lib";
import { OverviewTab } from "./tabs/OverviewTab";
import { SalesTab } from "./tabs/SalesTab";
import type { DashboardTabProps } from "./types";

// Same look as screens/ComingSoon.tsx minus its own MobileHeader (the shell
// already renders one).
function placeholder(title: string): ComponentType<DashboardTabProps> {
  return function Placeholder() {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "64px 24px", textAlign: "center" }}>
        <div
          style={{ width: 64, height: 64, borderRadius: 18, backgroundColor: "#F0EAD8", display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <Hammer size={28} strokeWidth={1.75} color="#6B5C32" />
        </div>
        <div style={{ fontSize: 17, fontWeight: 700, color: M.raisin }}>{title}</div>
        <div style={{ fontSize: 13, color: M.muted, maxWidth: 260 }}>
          This dashboard view arrives in the next phase of the mobile app. The desktop version is fully available.
        </div>
      </div>
    );
  };
}

export const TAB_REGISTRY: Record<MobileTabKey, ComponentType<DashboardTabProps>> = {
  overview: OverviewTab,
  sales: SalesTab,
  operations: placeholder("Operations"),
  people: placeholder("People"),
  service: placeholder("Service"),
  daily: placeholder("Daily"),
  finance: placeholder("Finance"),
};
