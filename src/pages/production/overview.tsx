// ---------------------------------------------------------------------------
// /production → Overview route.
//
// Thin wrapper around the shared ProductionPage component with
// mode="overview". The in-page tab bar is hidden (users navigate between
// overview and per-dept pages via the sidebar) and the activeTab is locked
// to "ALL" so the matrix view is the only thing rendered.
//
// All heavy logic (data fetching, filter state, merge logic for FAB_CUT,
// print hooks, QR sticker rendering) still lives in ./index.tsx — this file
// is intentionally a near-empty shell so the split has zero behavioral drift.
//
// Narrow viewports (≤1280px, 2026-09-22): the Overview matrix is a fixed-px
// grid ~1,980px wide, so on a laptop / iPad it only ever showed a slice and
// scrolled sideways. Below that width this route renders the /m production
// card list INSTEAD — the same component /m/production mounts, not a copy —
// so there is exactly one small-screen layout to maintain. Card tap goes to
// /m/production/:id (desktop has no PO-detail route since 2026-04-26).
// ---------------------------------------------------------------------------
import { lazy, Suspense } from "react";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import ProductionPage from "./index";

const MobileProductionScreen = lazy(() =>
  import("../m/screens/ProductionScreen").then((m) => ({ default: m.ProductionScreen })),
);

export default function ProductionOverview() {
  const narrow = useMediaQuery("(max-width: 1280px)");
  if (narrow) {
    return (
      <Suspense fallback={null}>
        <MobileProductionScreen />
      </Suspense>
    );
  }
  return <ProductionPage mode="overview" />;
}
