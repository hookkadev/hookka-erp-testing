// DashboardScreen — the /m/dashboard/:tab shell: header (back + period chip),
// scrollable tab strip, and the active tab from TAB_REGISTRY. It owns nothing
// tab-specific: tabs, their data and their states live behind the registry.
//
// URL: tab in the path (/m/dashboard/sales), period in the query string
// (?mode=ytd&month=2026-07&day=2026-07-12 — same scheme as the desktop page).
// Tab changes push history (Back walks tabs); period changes replace it.
import { useCallback } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { usePermissions } from "@/lib/use-permission";
import { MobileHeader, SubTabs } from "../../components";
import { DASHBOARD_NAV_HREF, MOBILE_TABS, isMobileTab, type MobileTabKey } from "./dashboard-m-lib";
import { useDashboardFeed, useDashboardPeriod } from "./hooks";
import { PeriodChip } from "./PeriodChip";
import { MState } from "./primitives";
import { TAB_REGISTRY } from "./registry";

export function DashboardScreen() {
  const { tab } = useParams();
  const { search } = useLocation();
  const navigate = useNavigate();
  const { isNavAllowed } = usePermissions();
  const { months } = useDashboardFeed();
  const { period, setPeriod } = useDashboardPeriod(months);

  const openTab = useCallback(
    (key: MobileTabKey) => navigate(`/m/dashboard/${key}${search}`),
    [navigate, search],
  );

  if (!isMobileTab(tab)) return <Navigate to={`/m/dashboard/overview${search}`} replace />;

  if (!isNavAllowed(DASHBOARD_NAV_HREF)) {
    return (
      <>
        <MobileHeader title="Dashboard" onBack={() => navigate("/m/more")} />
        <MState kind="empty" text="Your role doesn't have access to the dashboard." />
      </>
    );
  }

  const Tab = TAB_REGISTRY[tab];
  return (
    <>
      <MobileHeader
        title="Dashboard"
        onBack={() => navigate("/m/more")}
        trailing={<PeriodChip period={period} months={months} onChange={setPeriod} />}
      />
      <SubTabs tabs={[...MOBILE_TABS]} active={tab} onChange={(k) => openTab(k as MobileTabKey)} />
      <Tab period={period} setPeriod={setPeriod} months={months} openTab={openTab} />
    </>
  );
}
