// ChipTabs — the horizontal chip row used under the search/action row.
//
// Same look as the status chips on the Sales Orders list (SalesScreen.tsx):
// 30px full-pill chips, gold fill + taupe border when selected, optional count
// after the label. Used by Delivery and Procurement only (ModuleListScreen
// gates it by slug) so the shared SubTabs, which other modules rely on, is
// left untouched.
import { M, M_ACCENT } from "../theme";

type Tab = { key: string; label: string };

type Props = {
  tabs: Tab[];
  active: string;
  onChange: (key: string) => void;
  /** Optional per-tab counts (keyed by tab key); a count of 0 is not shown. */
  counts?: Record<string, number>;
};

export function ChipTabs({ tabs, active, onChange, counts }: Props) {
  return (
    <div
      // Still scrolls sideways; the scrollbar itself is hidden (same Tailwind
      // pattern as components/ui/tabs.tsx).
      className="[scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{
        display: "flex",
        gap: 7,
        overflowX: "auto",
        padding: "10px 18px 4px",
        WebkitOverflowScrolling: "touch",
      }}
    >
      {tabs.map((t) => {
        const on = t.key === active;
        const n = counts?.[t.key] ?? 0;
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            style={{
              height: 30,
              padding: "0 13px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: "nowrap",
              flex: "none",
              cursor: "pointer",
              border: `1px solid ${on ? M.taupe : M.hairline}`,
              background: on ? M_ACCENT.gold.bg : M.card,
              color: on ? M.taupe : M.muted,
              WebkitTapHighlightColor: "transparent",
            }}
          >
            {t.label}
            {n > 0 ? (
              <span style={{ marginLeft: 6, fontSize: 10.5, opacity: 0.7 }}>{n}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
