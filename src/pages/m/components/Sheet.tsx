// Sheet — bottom-sheet overlay used for filters, quick actions, and (later)
// create/edit forms. Slides up from the bottom, dimmed backdrop, drag handle,
// optional title. Closes on backdrop tap / Esc.
import { type ReactNode, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { M, M_MAX_WIDTH } from "../theme";
import { useResponsiveLayout } from "../lib/responsive-layout";

type Props = {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
};

export function Sheet({ open, onClose, title, children }: Props) {
  const { mode, railWidth } = useResponsiveLayout();
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) {
        e.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const frame = requestAnimationFrame(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]',
      );
      (first ?? dialogRef.current)?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  const phone = mode === "phone";
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        backgroundColor: "rgba(31, 29, 27, 0.45)",
        display: "flex",
        flexDirection: "column",
        justifyContent: phone ? "flex-end" : "center",
        alignItems: "center",
        padding: phone ? 0 : `24px 24px 24px ${railWidth + 24}px`,
      }}
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title || "Dialog"}
        tabIndex={-1}
        style={{
          width: "100%",
          maxWidth: phone ? M_MAX_WIDTH : mode === "tablet-portrait" ? 560 : 640,
          backgroundColor: M.paper,
          borderRadius: phone ? "20px 20px 0 0" : 20,
          maxHeight: phone ? "85dvh" : "min(760px, calc(100dvh - 48px))",
          overflowY: "auto",
          paddingBottom: "max(16px, env(safe-area-inset-bottom))",
          boxShadow: "0 -8px 30px rgba(31,29,27,0.18)",
        }}
      >
        {/* Drag handle */}
        <div style={{ display: "flex", justifyContent: "center", paddingTop: 8 }}>
          <div
            style={{
              width: 40,
              height: 4,
              borderRadius: 9999,
              backgroundColor: M.border,
            }}
          />
        </div>

        {title ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 16px 6px",
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, color: M.raisin }}>
              {title}
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              style={{
                background: "none",
                border: "none",
                padding: 6,
                cursor: "pointer",
                display: "flex",
              }}
            >
              <X size={20} strokeWidth={1.75} color={M.muted} />
            </button>
          </div>
        ) : null}

        <div style={{ padding: "8px 16px 16px" }}>{children}</div>
      </div>
    </div>
  );
}
