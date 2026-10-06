// ---------------------------------------------------------------------------
// row-menu.tsx — a document list's row actions on right-click (owner
// 2026-10-02 「这个显示太多了，能不能 right click 才选我的东西」).
//
// The list shows no action links: right-click a row — or tap its ⋮, the same
// button the data grid has — for open / print / edit / ladder / void…; the
// menu is the data grid's own ContextMenu. Double-click still opens the
// record's popup with the same actions as buttons. Shift + right-click keeps
// the browser's own menu (copy, inspect).
// ---------------------------------------------------------------------------
import { useCallback, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/data-grid";

/** Menu items in groups; a divider goes between non-empty groups. */
export type RowMenuGroups = ContextMenuItem[][];

function flatten(groups: RowMenuGroups): ContextMenuItem[] {
  return groups
    .filter((g) => g.length > 0)
    .flatMap((g, gi) => g.map((item, i) => (gi > 0 && i === 0 ? { ...item, separator: true } : item)));
}

export function useRowMenu() {
  const [menu, setMenu] = useState<{ key: string; x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const close = useCallback(() => setMenu(null), []);
  const open = (key: string, x: number, y: number, groups: RowMenuGroups) => {
    const items = flatten(groups);
    if (items.length) setMenu({ key, x, y, items });
  };
  return {
    /** The key of the row whose menu is open (to highlight it). */
    openKey: menu?.key ?? null,
    /** `<tr onContextMenu={rowMenu.onContextMenu(key, () => groups)}>` */
    onContextMenu: (key: string, groups: () => RowMenuGroups) => (e: MouseEvent) => {
      if (e.shiftKey) return;
      e.preventDefault();
      open(key, e.clientX, e.clientY, groups());
    },
    /** The ⋮ button for the row's last cell — opens the same menu under it. */
    button: (key: string, groups: () => RowMenuGroups) => (
      <button
        type="button"
        className="inline-flex h-6 w-6 items-center justify-center rounded align-middle text-[#888] hover:bg-[#E0DCD7] hover:text-[#333] active:bg-[#D5D0CB]"
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          open(key, r.right, r.bottom, groups());
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        title="Actions — or right-click the row"
        aria-label="Row actions"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden="true">
          <circle cx="12" cy="5" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="12" cy="19" r="1.6" />
        </svg>
      </button>
    ),
    /** Render once per list — anywhere: it goes to <body> (fixed position). */
    element: menu ? createPortal(<ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={close} />, document.body) : null,
  };
}

/** Void / delete / unvoid as menu items — the same states as LifecycleActions. */
export function lifecycleMenuItems(
  state: string | null | undefined,
  on: { void: () => void; delete: () => void; unvoid: () => void },
  blocked?: string,
): ContextMenuItem[] {
  const s = state ?? "ACTIVE";
  if (s === "VOID") return [{ label: "Unvoid", action: on.unvoid }, { label: "Delete", danger: true, action: on.delete }];
  if (s === "DELETED") return [{ label: "Unvoid", action: on.unvoid }];
  return [
    { label: blocked ? `Void (${blocked})` : "Void", danger: true, disabled: !!blocked, action: on.void },
    { label: blocked ? `Delete (${blocked})` : "Delete", danger: true, disabled: !!blocked, action: on.delete },
  ];
}
