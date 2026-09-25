// Hooks every /m dashboard tab uses. A tab needs nothing else to get data.
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useCachedJson } from "@/lib/cached-fetch";
import { opensOnToday, ymd, type Period } from "../../../dashboards/dashboard-shared-lib";
import { LEGACY, TAB_SUBS } from "../../../dashboards/dashboard-url-state-lib";
import { readPeriod, resolvePeriod, writePeriod } from "./dashboard-m-lib";
import { DASHBOARD_FEED_URL, type DashboardFeed } from "./types";

/**
 * The cached dashboard feed (stale-while-revalidate, keyed on URL — every tab
 * and the desktop page share ONE entry). `months` = months that actually have
 * sales, oldest → newest (same list the desktop PeriodPicker is driven by).
 */
export function useDashboardFeed() {
  const r = useCachedJson<DashboardFeed>(DASHBOARD_FEED_URL);
  const feed = r.data;
  const months = useMemo(
    () => feed?.meta?.monthsWithSales ?? feed?.meta?.months ?? [],
    [feed],
  );
  return { feed, months, loading: r.loading, error: r.error, refresh: r.refresh };
}

/**
 * The selected period, held in the URL search params (mode / month / from / to
 * / day) so refresh and Back keep the place. `period` is RESOLVED: a bare URL
 * opens on today (on the plain month for the Overview and Sales tabs), an
 * unset or unknown month becomes the newest month with data. Pass it straight to
 * `inPeriod` / `inFocus`. `setPeriod` REPLACES history (Back does not step
 * through every month tap).
 */
export function useDashboardPeriod(months: string[], tab?: string) {
  const [params, setParams] = useSearchParams();
  const raw = useMemo(() => readPeriod(params), [params]);
  const period = useMemo(() => resolvePeriod(raw, months, ymd(new Date()), opensOnToday(tab)), [raw, months, tab]);
  const setPeriod = useCallback(
    (p: Period) => setParams((prev) => writePeriod(prev, p), { replace: true }),
    [setParams],
  );
  return { period, setPeriod };
}

/**
 * The current tab's sub-tab, held in `?sub=` — the same param and the same
 * keys (TAB_SUBS) as the desktop page, so a link means the same on both. An
 * unknown or missing value resolves to the tab's first sub-tab. `setSub`
 * pushes history (Back walks sub-tabs).
 */
export function useDashboardSub(tab: string) {
  const [params, setParams] = useSearchParams();
  const subs = TAB_SUBS[tab] ?? [];
  // A retired sub-tab (e.g. people:departments) opens where desktop sends it.
  const legacy = LEGACY[`${tab}:${params.get("sub")}`];
  const want = legacy?.[0] === tab ? legacy[1] : params.get("sub");
  const sub = subs.find((s) => s.key === want)?.key ?? subs[0]?.key ?? "";
  const setSub = useCallback(
    (key: string) => setParams((prev) => { const n = new URLSearchParams(prev); n.set("sub", key); return n; }),
    [setParams],
  );
  return { sub, setSub, subs };
}
