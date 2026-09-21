import type { MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import { usePermissions } from "@/lib/use-permission";
import { SERVICE_CASES_NAV_HREF, serviceCaseHref } from "./service-case-link-lib";

// Desktop Service tab -> Service Cases module. `canOpen` is the same server-decided
// gate the sidebar uses for its "Service Cases" entry; when it is false the case
// number stays plain text and rows are not clickable.
//
// `rowProps(id, className)` makes the whole table row a mouse shortcut. The keyboard /
// middle-click / open-in-new-tab path is the <ServiceCaseNo> link inside the row,
// so the row handler steps aside for clicks on a link, button or input, for
// modified clicks, and while the user is selecting text.
export function useServiceCaseLinks() {
  const { isNavAllowed } = usePermissions();
  const navigate = useNavigate();
  const canOpen = isNavAllowed(SERVICE_CASES_NAV_HREF);

  const rowProps = (
    id: string | null | undefined,
    className: string,
  ): { className: string; onClick?: (e: MouseEvent<HTMLElement>) => void } => {
    const href = canOpen ? serviceCaseHref(id) : null;
    if (!href) return { className };
    return {
      className: `${className} cursor-pointer hover:bg-[#F7F5F3]`,
      onClick: (e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        if ((e.target as HTMLElement).closest("a,button,input,textarea,select")) return;
        if (window.getSelection()?.toString()) return;
        navigate(href);
      },
    };
  };

  return { canOpen, rowProps };
}
