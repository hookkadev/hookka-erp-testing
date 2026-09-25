// DashboardScreen — the /m/dashboard/:tab shell: header (back + period chip),
// a tab DROPDOWN (native <select>: one 44px row and the OS picker, instead of a
// six-pill strip stacked on each tab's own sub-tab pills), and the active tab
// from TAB_REGISTRY. It owns nothing
// tab-specific: tabs, their data and their states live behind the registry.
//
// URL: tab in the path (/m/dashboard/sales), period in the query string
// (?mode=ytd&month=2026-07&day=2026-07-12 — same scheme as the desktop page).
// Tab changes push history (Back walks tabs); period changes replace it.
import { useCallback } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { usePermissions } from "@/lib/use-permission";
import { MobileHeader } from "../../components";
import { M } from "../../theme";
import { DASHBOARD_NAV_HREF, MOBILE_TABS, isMobileTab, type MobileTabKey } from "./dashboard-m-lib";
import { useDashboardFeed, useDashboardPeriod } from "./hooks";
import { PeriodChip } from "./PeriodChip";
import { MState } from "./primitives";
import { TAB_REGISTRY } from "./registry";

export function DashboardScreen() {
  const { tab } = useParams();
  const { search } = useLocation();
  const navigate = useNavigate();
  const { isNavAllowed, dashboardTabs, loading: permsLoading } = usePermissions();
  // Tab-restricted role (role-policy.ts DASHBOARD_TABS_BY_ROLE): only its tabs
  // are offered, a bare /m/dashboard lands on the first, and any other tab
  // reached by URL shows "Under maintenance". Same rule as the desktop page.
  const tabs = dashboardTabs ? MOBILE_TABS.filter((t) => dashboardTabs.includes(t.key)) : MOBILE_TABS;
  const landing = tabs[0]?.key ?? "overview";
  const { feed, months } = useDashboardFeed();
  // Newest day that carries data: the period sheet anchors its presets to it.
  const latestDay = (feed?.sales?.byDay ?? []).reduce((m, d) => (d.date > m ? d.date : m), "");
  const { period, setPeriod } = useDashboardPeriod(months, tab);

  const openTab = useCallback(
    (key: MobileTabKey) => navigate(`/m/dashboard/${key}${search}`),
    [navigate, search],
  );

  // Wait for the permission set (first visit only; it is cached after), so a
  // restricted role never lands on, or fetches for, a tab it may not see.
  if (permsLoading) return null;
  if (!isMobileTab(tab)) return <Navigate to={`/m/dashboard/${landing}${search}`} replace />;
  const blocked = !tabs.some((t) => t.key === tab);

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
        trailing={<PeriodChip period={period} months={months} latestDay={latestDay} onChange={setPeriod} />}
      />
      {/* Sticky under the MobileHeader (minHeight 52), like SubTabs. */}
      <div style={{ position: "sticky", top: 52, zIndex: 30, padding: "8px 12px", backgroundColor: M.paper, borderBottom: `1px solid ${M.border}` }}>
        <select
          aria-label="Dashboard section"
          value={tab}
          onChange={(e) => openTab(e.target.value as MobileTabKey)}
          style={{
            width: "100%", minHeight: 44, padding: "0 12px", borderRadius: 11, border: `1px solid ${M.hairline}`,
            // 16px: iOS Safari zooms the whole page when a control under 16px takes focus.
            backgroundColor: M.card, color: M.raisin, fontSize: 16, fontWeight: 700,
          }}
        >
          {blocked && <option value={tab} disabled>Choose a section</option>}
          {tabs.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
      </div>
      {blocked ? (
        <MState kind="empty" text="Under maintenance" />
      ) : (
        <Tab period={period} setPeriod={setPeriod} months={months} openTab={openTab} />
      )}
    </>
  );
}
