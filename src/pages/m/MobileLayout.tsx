// ===========================================================================
// MobileLayout — the phone (mobile) app shell, mounted at /m.
//
// ADDITIVE: this is an entirely new route subtree. It reuses the SAME
// cookie-based auth/session as the desktop dashboard (gated by <RequireAuth>
// in router.tsx — the user is already logged in), the SAME global fetch
// interceptor (CSRF + credentials), and the SAME design tokens. It does NOT
// touch or import any desktop layout/page, so the existing app is unchanged.
//
// The shell:
//   • centers content to ~414px (phone width) on any viewport,
//   • paints the paper background + system font,
//   • renders its own nested <Routes> for the /m/* screens,
//   • pins the 5-item BottomTabBar (Home · Sales · Production · Procure · More).
//
// Phase 1: Home + More + placeholders. Phase 2 (this): every module's L1 list
// is wired to <ModuleListScreen> driven by its ModuleConfig (config-driven —
// see src/pages/m/config/modules.ts). L2 detail routes (/m/<slug>/:id) land on
// a ComingSoon detail until Phase 3 supplies the real detail screen.
// ===========================================================================
import { lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { Route, Routes } from "react-router-dom";
import { BottomTabBar, LeftRail } from "./components";
import { M, M_FONT, M_MAX_WIDTH } from "./theme";
import MobileHome from "./screens/Home";
import MobileMore from "./screens/More";
import { ComingSoon } from "./screens/ComingSoon";
import { ModuleListScreen } from "./screens/ModuleListScreen";
import { DocumentDetailScreen } from "./screens/DocumentDetailScreen";
import { LineItemDetailScreen } from "./screens/LineItemDetailScreen";
import { WarehouseScreen } from "./screens/WarehouseScreen";
import { ProductionScreen } from "./screens/ProductionScreen";
import { SalesScreen } from "./screens/SalesScreen";
import { SalesDetailScreen } from "./screens/SalesDetailScreen";
import { ProductionDetailScreen } from "./screens/ProductionDetailScreen";
import { ServiceCasesScreen } from "./screens/ServiceCasesScreen";
import { AnnouncementsScreen } from "./screens/AnnouncementsScreen";
import { MailCenterScreen, MailThreadScreen } from "./screens/MailCenterScreen";
import { MODULE_CONFIGS } from "./config/modules";
import { preloadMobileCritical } from "./lib/preload";
import { useAutoUpdateOnNavigate } from "@/lib/use-version-check";
import { bootstrapMobileTheme } from "./lib/theme-mode";
import {
  ResponsiveLayoutProvider,
  readRailExpandedPreference,
  resolveResponsiveLayout,
  useObservedWidth,
  writeRailExpandedPreference,
} from "./lib/responsive-layout";
import "./theme-vars.css";

// The dashboard screen is code-split: it is the only /m screen that needs
// recharts, and most phone sessions never open it.
const DashboardScreen = lazy(() =>
  import("./screens/dashboard/DashboardScreen").then((m) => ({ default: m.DashboardScreen })),
);
function DashboardRoute() {
  return (
    <Suspense fallback={<div style={{ padding: "64px 0", textAlign: "center", color: M.muted, fontSize: 13 }}>Loading…</div>}>
      <DashboardScreen />
    </Suspense>
  );
}

// Apply persisted dark/light mode BEFORE first paint to avoid a flash. This
// runs once at module load time (the import side-effect).
bootstrapMobileTheme();

// Modules whose L1 list is a bespoke screen (not the generic ModuleListScreen).
// Their L2 detail route still uses the config-driven DocumentDetailScreen.
const CUSTOM_L1: Record<string, ComponentType> = {
  sales: SalesScreen,
  servicecases: ServiceCasesScreen,
  announcements: AnnouncementsScreen,
  "mail-center": MailCenterScreen,
  warehouse: WarehouseScreen,
  // Production is a Kanban-style board grouped by current department (dc12
  // design v12) — the generic list flattens that signal. Detail route stays
  // generic via productionConfig.detail.
  production: ProductionScreen,
};

// Modules whose L2 detail is a bespoke screen (v20 alignment) instead of the
// generic DocumentDetailScreen. Sales = the locked create-form + Total/Paid/
// Balance KPI strip + status action bar (v20 MobileSoDetail).
const CUSTOM_L2: Record<string, ComponentType> = {
  sales: SalesDetailScreen,
  production: ProductionDetailScreen,
  "mail-center": MailThreadScreen,
};

export default function MobileLayout() {
  // Kick off background preload of high-traffic endpoints on mount — every
  // subsequent module list navigation paints from cache, not network. Runs
  // once per shell mount (the shell stays mounted for the whole /m session).
  useEffect(() => {
    preloadMobileCritical();
  }, []);

  // Phones never checked for a new deploy at all — pick it up on the next
  // screen change (BUG-2026-09-23-184).
  useAutoUpdateOnNavigate();

  const [railPreferences, setRailPreferences] = useState(() => ({
    "tablet-portrait": readRailExpandedPreference("tablet-portrait"),
    "tablet-landscape": readRailExpandedPreference("tablet-landscape"),
  }));
  const [shellRef, shellWidth] = useObservedWidth<HTMLDivElement>();
  const shellLayout = resolveResponsiveLayout(shellWidth);
  const railExpanded = shellLayout.mode === "phone"
    ? false
    : railPreferences[shellLayout.mode];
  const preferredShellLayout = resolveResponsiveLayout(
    shellWidth,
    undefined,
    railExpanded,
  );
  const [contentRef, measuredContentWidth] = useObservedWidth<HTMLDivElement>(
    Math.max(0, shellWidth - preferredShellLayout.railWidth),
  );
  const expectedContentWidth = Math.max(
    0,
    shellWidth - preferredShellLayout.railWidth,
  );
  // ResizeObserver updates after the rail has painted. Use the immediately
  // derivable width during that one render so split eligibility never lags a
  // user toggle by one frame.
  const effectiveContentWidth = Math.abs(measuredContentWidth - expectedContentWidth) <= 1
    ? measuredContentWidth
    : expectedContentWidth;
  const layout = resolveResponsiveLayout(
    shellWidth,
    effectiveContentWidth,
    railExpanded,
  );
  const tablet = layout.mode !== "phone";
  const compactRail = tablet && !railExpanded;
  const toggleRail = () => {
    if (layout.mode === "phone") return;
    const mode = layout.mode;
    setRailPreferences((current) => {
      const expanded = !current[mode];
      writeRailExpandedPreference(mode, expanded);
      return { ...current, [mode]: expanded };
    });
  };

  return (
    <ResponsiveLayoutProvider value={layout}>
      <div
        ref={shellRef}
        style={{
          minHeight: "100dvh",
          backgroundColor: M.paper,
          fontFamily: M_FONT,
          color: M.raisin,
          display: "flex",
          justifyContent: tablet ? "flex-start" : "center",
        }}
      >
        {tablet ? (
          <LeftRail compact={compactRail} onToggle={toggleRail} />
        ) : null}
        <div
          ref={contentRef}
          data-mobile-content
          style={{
            width: "100%",
            maxWidth: tablet ? "none" : M_MAX_WIDTH,
            flex: tablet ? 1 : "none",
            minWidth: 0,
            minHeight: "100dvh",
            paddingBottom: layout.hasBottomNavigation
              ? "calc(72px + env(safe-area-inset-bottom))"
              : "24px",
            position: "relative",
            overflowX: "hidden",
          }}
        >
          <Routes>
          <Route path="/" element={<MobileHome />} />
          <Route path="/more" element={<MobileMore />} />

          {/* Dashboard (lazy: pulls in recharts). Tab in the path, period in
              the query string — see screens/dashboard/DashboardScreen.tsx. */}
          <Route path="dashboard" element={<DashboardRoute />} />
          <Route path="dashboard/:tab" element={<DashboardRoute />} />

          {/* Config-driven L1 lists + L2 document detail.
              When `detail` is supplied + we're on fold, the L2 route renders
              a two-pane shell: parent list on left, detail on right. On
              phone (or list-only routes) it's the standard single-pane.
              Each module with `detail` also gets /:id/item/:itemId for the
              L3 line-item screen. */}
          {MODULE_CONFIGS.map((cfg) => {
            const CustomL1 = CUSTOM_L1[cfg.slug];
            const L1 = CustomL1 ? <CustomL1 /> : <ModuleListScreen config={cfg} />;
            const CustomL2 = CUSTOM_L2[cfg.slug];
            // The L2 detail: a bespoke screen (CUSTOM_L2) wins; else the generic
            // config-driven detail; else a ComingSoon placeholder.
            const L2 = CustomL2 ? (
              <CustomL2 />
            ) : cfg.detail ? (
              <DocumentDetailScreen config={cfg} />
            ) : null;
            return (
            <Route key={cfg.slug}>
              <Route path={cfg.slug} element={L1} />
              <Route
                path={`${cfg.slug}/:id`}
                element={
                  L2 ? (
                    layout.canSplitDetail ? (
                      <TwoPane left={L1} right={L2} />
                    ) : (
                      L2
                    )
                  ) : (
                    <ComingSoon title={`${cfg.title} detail`} />
                  )
                }
              />
              {cfg.detail ? (
                <Route
                  path={`${cfg.slug}/:id/item/:itemId`}
                  element={
                    layout.canSplitDetail ? (
                      <TwoPane
                        left={<DocumentDetailScreen config={cfg} />}
                        right={<LineItemDetailScreen config={cfg} />}
                      />
                    ) : (
                      <LineItemDetailScreen config={cfg} />
                    )
                  }
                />
              ) : null}
            </Route>
            );
          })}

          {/* Unknown /m/* → Home. */}
          <Route path="*" element={<MobileHome />} />
          </Routes>
        </div>
        {layout.hasBottomNavigation ? <BottomTabBar /> : null}
      </div>
    </ResponsiveLayoutProvider>
  );
}

/** Fold-only 2-pane shell — list (~320px) left, detail right, independent
 * scrollbars. dc13 v13 Fold layout. */
function TwoPane({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div
      data-mobile-split-view
      style={{ display: "flex", height: "100dvh", overflow: "hidden" }}
    >
      <div
        style={{
          width: "clamp(320px, 38%, 340px)",
          flex: "none",
          borderRight: `1px solid ${M.border}`,
          overflowY: "auto",
          overflowX: "hidden",
          background: M.paper,
        }}
      >
        {left}
      </div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          overflowY: "auto",
          overflowX: "hidden",
        }}
      >
        {right}
      </div>
    </div>
  );
}
