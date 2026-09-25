import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import type { Period } from "./dashboard-shared-lib";
import { parseDashboardUrl, serializeDashboardUrl, defaultSub, DEFAULT_TAB } from "./dashboard-url-state-lib";

/**
 * Dashboard navigation state lives in the query string (see the scheme in
 * dashboard-url-state-lib.ts) - no React state to drift from it.
 * Tab / sub-tab changes PUSH a history entry (Back walks tabs); period and
 * focused-day changes REPLACE (Back does not step through every month click).
 * `landingTab` is where a bare URL opens (Overview unless the role is tab-restricted).
 */
export function useDashboardUrlState<T extends string>(tabKeys: readonly T[], landingTab: string = DEFAULT_TAB) {
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => parseDashboardUrl(params, tabKeys, landingTab), [params, tabKeys, landingTab]);

  const write = useCallback(
    (patch: (cur: ReturnType<typeof parseDashboardUrl>) => Partial<ReturnType<typeof parseDashboardUrl>>, replace: boolean) =>
      setParams(
        (prev) => {
          const cur = parseDashboardUrl(prev, tabKeys, landingTab);
          return serializeDashboardUrl({ ...cur, ...patch(cur) }, prev);
        },
        { replace },
      ),
    [setParams, tabKeys, landingTab],
  );

  const setTab = useCallback((tab: T, sub?: string) => write(() => ({ tab, sub: sub ?? defaultSub(tab) }), false), [write]);
  const setSub = useCallback((sub: string) => write(() => ({ sub }), false), [write]);
  const setPeriod = useCallback((period: Period) => write(() => ({ period }), true), [write]);

  return { tab: state.tab as T, sub: state.sub, period: state.period, setTab, setSub, setPeriod };
}
