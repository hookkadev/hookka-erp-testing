import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

export type MobileLayoutMode = "phone" | "tablet-portrait" | "tablet-landscape";

export const PHONE_MAX_WIDTH = 719;
export const FULL_RAIL_MIN_WIDTH = 1024;
export const COMPACT_RAIL_WIDTH = 72;
export const FULL_RAIL_WIDTH = 198;
export const SPLIT_CONTENT_MIN_WIDTH = 760;

type TabletLayoutMode = Exclude<MobileLayoutMode, "phone">;

const RAIL_PREFERENCE_KEYS: Record<TabletLayoutMode, string> = {
  "tablet-portrait": "hookka.mobileRail.portraitExpanded",
  "tablet-landscape": "hookka.mobileRail.landscapeExpanded",
};

export function defaultRailExpanded(mode: TabletLayoutMode): boolean {
  return mode === "tablet-landscape";
}

export function readRailExpandedPreference(mode: TabletLayoutMode): boolean {
  const fallback = defaultRailExpanded(mode);
  if (typeof localStorage === "undefined") return fallback;
  try {
    const saved = localStorage.getItem(RAIL_PREFERENCE_KEYS[mode]);
    return saved == null ? fallback : saved === "1";
  } catch {
    return fallback;
  }
}

export function writeRailExpandedPreference(
  mode: TabletLayoutMode,
  expanded: boolean,
): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(RAIL_PREFERENCE_KEYS[mode], expanded ? "1" : "0");
  } catch {
    /* Storage can be unavailable in private/restricted browsing. */
  }
}

export type ResponsiveLayoutValue = {
  mode: MobileLayoutMode;
  shellWidth: number;
  contentWidth: number;
  railWidth: 0 | typeof COMPACT_RAIL_WIDTH | typeof FULL_RAIL_WIDTH;
  splitMasterWidth: number;
  hasBottomNavigation: boolean;
  canSplitDetail: boolean;
};

export function resolveResponsiveLayout(
  shellWidth: number,
  measuredContentWidth?: number,
  railExpandedOverride?: boolean,
): ResponsiveLayoutValue {
  const safeShellWidth = Math.max(0, shellWidth);
  const mode: MobileLayoutMode =
    safeShellWidth <= PHONE_MAX_WIDTH
      ? "phone"
      : safeShellWidth < FULL_RAIL_MIN_WIDTH
        ? "tablet-portrait"
        : "tablet-landscape";
  const railExpanded =
    mode === "phone"
      ? false
      : railExpandedOverride ?? defaultRailExpanded(mode);
  const railWidth = mode === "phone"
    ? 0
    : railExpanded
      ? FULL_RAIL_WIDTH
      : COMPACT_RAIL_WIDTH;
  const estimatedContentWidth = Math.max(0, safeShellWidth - railWidth);
  const contentWidth =
    measuredContentWidth != null && measuredContentWidth > 0
      ? measuredContentWidth
      : estimatedContentWidth;
  const splitMasterWidth = Math.min(340, Math.max(320, Math.round(contentWidth * 0.38)));

  return {
    mode,
    shellWidth: safeShellWidth,
    contentWidth,
    railWidth,
    splitMasterWidth,
    hasBottomNavigation: mode === "phone",
    canSplitDetail: mode !== "phone" && contentWidth >= SPLIT_CONTENT_MIN_WIDTH,
  };
}

const DEFAULT_LAYOUT = resolveResponsiveLayout(390, 390);
const ResponsiveLayoutContext = createContext<ResponsiveLayoutValue>(DEFAULT_LAYOUT);

export function ResponsiveLayoutProvider({
  value,
  children,
}: {
  value: ResponsiveLayoutValue;
  children: ReactNode;
}) {
  return (
    <ResponsiveLayoutContext.Provider value={value}>
      {children}
    </ResponsiveLayoutContext.Provider>
  );
}

export function useResponsiveLayout(): ResponsiveLayoutValue {
  return useContext(ResponsiveLayoutContext);
}

function initialViewportWidth(): number {
  if (typeof document !== "undefined") {
    return document.documentElement.clientWidth || 390;
  }
  if (typeof window !== "undefined") return window.innerWidth || 390;
  return 390;
}

/** Observe the rendered shell/content box rather than assuming viewport width. */
export function useObservedWidth<T extends HTMLElement>(
  initialWidth = initialViewportWidth(),
): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(initialWidth);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => {
      const next = Math.round(el.getBoundingClientRect().width);
      if (next > 0) setWidth((current) => (current === next ? current : next));
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

export function useResolvedResponsiveLayout(
  shellWidth: number,
  contentWidth: number,
): ResponsiveLayoutValue {
  return useMemo(
    () => resolveResponsiveLayout(shellWidth, contentWidth),
    [shellWidth, contentWidth],
  );
}
