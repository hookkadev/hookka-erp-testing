// Hooks every /m dashboard tab uses. A tab needs nothing else to get data.
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useCachedJson } from "@/lib/cached-fetch";
import type { Period } from "../../../dashboards/dashboard-shared-lib";
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
 * / day) so refresh and Back keep the place. `period` is RESOLVED: an unset or
 * unknown month becomes the newest month with data. Pass it straight to
 * `inPeriod` / `inFocus`. `setPeriod` REPLACES history (Back does not step
 * through every month tap).
 */
export function useDashboardPeriod(months: string[]) {
  const [params, setParams] = useSearchParams();
  const raw = useMemo(() => readPeriod(params), [params]);
  const period = useMemo(() => resolvePeriod(raw, months), [raw, months]);
  const setPeriod = useCallback(
    (p: Period) => setParams((prev) => writePeriod(prev, p), { replace: true }),
    [setParams],
  );
  return { period, setPeriod };
}
