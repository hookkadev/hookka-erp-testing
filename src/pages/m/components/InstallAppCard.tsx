// "Install app" for the /m office app — the More-menu row and the Home card.
//
// Android / desktop Chromium: one tap opens the browser's own install dialog
// (the offer is caught at page load by src/lib/pwa-install). iPhone Safari has
// no such offer (Apple does not let a site install itself), so a tap shows the
// three Share → Add to Home Screen steps. Any other browser gets a one-line
// "use your browser menu" hint. Hidden once running as the installed app.
//
// `dismissible` (Home): only shown when a one-tap offer or the iPhone steps
// exist, and an X hides it for good. Without it (More): always there.
import { useState } from "react";
import { Download, X } from "lucide-react";
import { MobileCard } from "./MobileCard";
import { M } from "../theme";
import {
  isIosSafari,
  isStandalone,
  promptInstall,
  useInstallOffer,
} from "@/lib/pwa-install";

const DISMISS_KEY = "hookka.m.install.dismissed";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

const IOS_STEPS = [
  "Tap the Share button in Safari's bottom bar.",
  'Scroll and tap "Add to Home Screen".',
  "Open Hookka from your home screen.",
];

export function InstallAppCard({ dismissible = false }: { dismissible?: boolean }) {
  const offer = useInstallOffer();
  const ios = isIosSafari();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(() => dismissible && readDismissed());

  if (isStandalone() || dismissed) return null;
  if (dismissible && !offer && !ios) return null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* worst case the card shows again next visit */
    }
    setDismissed(true);
  }

  return (
    <MobileCard radius={14} style={{ padding: 0, marginBottom: 18, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <button
          onClick={() => (offer ? void promptInstall() : setOpen((o) => !o))}
          aria-expanded={offer ? undefined : open}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "13px 16px",
            background: "none",
            border: "none",
            cursor: "pointer",
            fontFamily: "inherit",
            textAlign: "left",
            WebkitTapHighlightColor: "transparent",
          }}
        >
          <span
            style={{
              width: 34,
              height: 34,
              borderRadius: 10,
              background: M.taupe,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flex: "none",
            }}
          >
            <Download size={18} color="#fff" strokeWidth={1.9} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: M.raisin }}>Install app</div>
            <div style={{ fontSize: 12, color: M.muted, marginTop: 1 }}>
              {offer ? "Add Hookka to your home screen" : "Tap to see how"}
            </div>
          </div>
        </button>
        {dismissible && (
          <button
            onClick={dismiss}
            aria-label="Dismiss"
            style={{
              background: "none",
              border: "none",
              padding: "13px 16px 13px 4px",
              cursor: "pointer",
              display: "flex",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            <X size={18} color={M.muted} strokeWidth={1.9} />
          </button>
        )}
      </div>
      {open && !offer && (
        <div style={{ padding: "0 16px 14px 62px", fontSize: 12.5, lineHeight: 1.5, color: M.body }}>
          {ios ? (
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              {IOS_STEPS.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          ) : (
            "Open your browser menu (⋮) and choose Install app or Add to Home screen."
          )}
        </div>
      )}
    </MobileCard>
  );
}
