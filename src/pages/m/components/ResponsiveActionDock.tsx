import { type ReactNode } from "react";
import { useResponsiveLayout } from "../lib/responsive-layout";

type Props = {
  children: ReactNode;
  scope?: "content" | "list" | "detail";
  phoneBottom?: number;
  zIndex?: number;
};

/** Fixed actions aligned to the phone column or their owning tablet pane. */
export function ResponsiveActionDock({
  children,
  scope = "content",
  phoneBottom = 56,
  zIndex = 30,
}: Props) {
  const layout = useResponsiveLayout();
  const phone = layout.mode === "phone";
  const split = layout.canSplitDetail;
  const tabletLeft = layout.railWidth + (scope === "detail" && split ? layout.splitMasterWidth : 0);
  const tabletWidth =
    scope === "list" && split ? layout.splitMasterWidth : undefined;

  return (
    <div
      data-responsive-action-dock={scope}
      style={{
        position: "fixed",
        left: phone ? 0 : tabletLeft,
        right: phone || tabletWidth == null ? 0 : "auto",
        width: tabletWidth,
        bottom: phone
          ? `calc(${phoneBottom}px + env(safe-area-inset-bottom))`
          : 0,
        display: "flex",
        justifyContent: "center",
        pointerEvents: "none",
        zIndex,
      }}
    >
      {children}
    </div>
  );
}
