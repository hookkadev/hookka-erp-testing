// ============================================================
// PwaInstallPrompt — "Add to Home Screen" card for the Worker Portal
//
// PWA Phase 1 install UX. Behaviour by platform:
//   - Android / Chromium: the browser fires `beforeinstallprompt`;
//     src/lib/pwa-install stashes it at page load, then we show an "Install app" button
//     that calls .prompt() on tap. After the user responds the event is
//     single-use, so we hide the card.
//   - iOS Safari: there is NO beforeinstallprompt. We detect iOS + Safari and
//     show a one-line "Share -> Add to Home Screen" hint instead.
//   - Already installed (standalone display-mode, or navigator.standalone on
//     iOS): render nothing — there is nothing to install.
//   - Dismissed: persisted in localStorage so the card never nags again.
//
// Self-contained: no props. Mount once inside the worker layout.
// ============================================================
import { useEffect, useState } from "react";
import { Bell, Download, Home, PlusSquare, Share, X } from "lucide-react";
import { getWorkerToken, workerFetch } from "@/layouts/WorkerLayout";
import {
  isIosSafari,
  isStandalone,
  promptInstall,
  useInstallOffer,
} from "@/lib/pwa-install";

const DISMISS_KEY = "hookka.pwa.install.dismissed";
// Separate dismiss key for the notification opt-in card so dismissing one
// doesn't hide the other.
const NOTIF_DISMISS_KEY = "hookka.pwa.notif.dismissed";

// VAPID application-server PUBLIC key (committed — it is a public value by
// design). The opt-in fetches the live key from GET /api/push/vapid-public-key
// first; this constant is only a fallback so the button still works if that
// request is momentarily unavailable. Must match the VAPID_PUBLIC_KEY env on
// the worker (and the VAPID_PRIVATE_KEY secret it pairs with).
const VAPID_PUBLIC_KEY_FALLBACK =
  "BLN6AkwN9tygMrpGpA7IQnrS7Bc8el6ggxm5KGpbd8gCJEF5lGZzh4sIilL4OKQx22Ox4Q_IMsn4eIOguCinVjk";

// base64url → Uint8Array (PushManager.subscribe wants the key as a byte array).
// Typed `Uint8Array<ArrayBuffer>` (concrete buffer, not ArrayBufferLike) so it
// satisfies the BufferSource type of applicationServerKey under strict lib.dom.
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function notifWasDismissed(): boolean {
  try {
    return localStorage.getItem(NOTIF_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

// True when this browser supports Web Push at all (SW + PushManager +
// Notification). Old/unsupported browsers simply never see the opt-in card.
function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export default function PwaInstallPrompt() {
  // Android/Chromium install offer, caught at page load by src/lib/pwa-install.
  const offer = useInstallOffer();
  const [dismissed, setDismissed] = useState(wasDismissed);
  // iOS variant (manual hint) vs Android variant (one-tap button).
  const iosHint = !offer && isIosSafari();
  const show = !dismissed && !isStandalone() && (offer !== null || iosHint);

  // Notification opt-in card — shown separately from the install card. Only
  // surfaces when the browser supports push, a worker is logged in, permission
  // hasn't been denied, the device isn't already subscribed, and the worker
  // hasn't dismissed it before. `busy` guards the button while subscribing.
  const [showNotif, setShowNotif] = useState(false);
  const [notifBusy, setNotifBusy] = useState(false);

  // Decide whether to offer the notification opt-in. Runs once on mount: checks
  // support + permission + existing subscription, all best-effort (any failure
  // just leaves the card hidden — never throws into render).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!pushSupported()) return;
      if (notifWasDismissed()) return;
      if (!getWorkerToken()) return; // only on a logged-in worker portal
      // Permission already denied → don't nag (the browser blocks re-prompts).
      if (Notification.permission === "denied") return;
      try {
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        // Already subscribed → nothing to offer.
        if (existing) return;
      } catch {
        // SW not ready / push query failed — be conservative and skip.
        return;
      }
      if (!cancelled) setShowNotif(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore storage failures — worst case the card shows again */
    }
    setDismissed(true);
  }

  // The offer is single-use; once used, useInstallOffer() goes null and the
  // card hides itself.
  const install = promptInstall;

  function dismissNotif() {
    try {
      localStorage.setItem(NOTIF_DISMISS_KEY, "1");
    } catch {
      /* ignore storage failures — worst case the card shows again */
    }
    setShowNotif(false);
  }

  // Turn on notifications: request permission → subscribe via PushManager using
  // the VAPID public key (fetched live, with a committed fallback) → POST the
  // subscription to /api/push/subscribe (worker-token authed). Best-effort: any
  // failure just hides the card without nagging again this session.
  async function enableNotifications() {
    if (notifBusy) return;
    setNotifBusy(true);
    try {
      // Only ASK when the permission is still undecided. If it's already
      // 'granted', skip requestPermission() entirely and go straight to the
      // subscribe step — calling requestPermission() on an already-granted
      // permission is a no-op (resolves 'granted' with no prompt), but skipping
      // it makes the "never re-ask once granted" contract explicit in code.
      const permission =
        Notification.permission === "granted"
          ? "granted"
          : await Notification.requestPermission();
      if (permission !== "granted") {
        // Denied/dismissed — don't re-prompt; the browser blocks it anyway.
        dismissNotif();
        return;
      }
      // Prefer the live VAPID public key; fall back to the committed constant.
      let appServerKey = VAPID_PUBLIC_KEY_FALLBACK;
      try {
        const res = await fetch("/api/push/vapid-public-key");
        if (res.ok) {
          const json = (await res.json()) as { key?: string };
          if (json && typeof json.key === "string" && json.key) {
            appServerKey = json.key;
          }
        }
      } catch {
        /* use the fallback constant */
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(appServerKey),
      });
      // POST the subscription JSON (endpoint + keys) to the worker-token-authed
      // subscribe endpoint. workerFetch attaches X-Worker-Token automatically.
      await workerFetch("/api/push/subscribe", {
        method: "POST",
        body: JSON.stringify(sub.toJSON()),
      });
      // Subscribed — hide the card (don't persist a dismiss; if they unsubscribe
      // later the mount check re-offers it on the next portal open).
      setShowNotif(false);
    } catch {
      // Permission flow / subscribe / network failed — hide without nagging.
      setShowNotif(false);
    } finally {
      setNotifBusy(false);
    }
  }

  // Nothing to show if neither card is active.
  if (!show && !showNotif) return null;

  return (
    <>
      {show && (
    <div className="mb-4 rounded-lg border border-[#D8D2CC] bg-white p-3 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-[#6B5C32] text-white">
          <Download className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[#1F1D1B]">
            Install Hookka app
          </p>
          {iosHint ? (
            // iOS Safari can't one-tap install — there's no beforeinstallprompt
            // event — so the worker must add it by hand. A single sentence was
            // easy to miss / get stuck on, so spell it out as a compact 3-step
            // visual guide with the actual iOS glyphs (Share / Add-to-Home).
            <div className="mt-1.5 space-y-1.5">
              <p className="text-xs text-[#6B655C]">
                Add it to your home screen in 3 steps:
              </p>
              <ol className="space-y-1.5">
                {[
                  {
                    icon: <Share className="h-4 w-4" aria-hidden="true" />,
                    text: (
                      <>
                        Tap the <span className="font-semibold">Share</span>{" "}
                        button (bottom bar).
                      </>
                    ),
                  },
                  {
                    icon: <PlusSquare className="h-4 w-4" aria-hidden="true" />,
                    text: (
                      <>
                        Scroll and tap{" "}
                        <span className="font-semibold">
                          "Add to Home Screen"
                        </span>
                        .
                      </>
                    ),
                  },
                  {
                    icon: <Home className="h-4 w-4" aria-hidden="true" />,
                    text: (
                      <>
                        Open{" "}
                        <span className="font-semibold">Hookka</span> from your
                        home screen.
                      </>
                    ),
                  },
                ].map((step, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#EFEAE3] text-[11px] font-bold text-[#6B5C32]">
                      {i + 1}
                    </span>
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-[#6B5C32] text-white">
                      {step.icon}
                    </span>
                    <span className="min-w-0 flex-1 text-xs leading-snug text-[#3F3A33]">
                      {step.text}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <p className="mt-0.5 text-xs text-[#6B655C]">
              Add it to your home screen for faster, full-screen access.
            </p>
          )}
          {!iosHint && (
            <button
              type="button"
              onClick={install}
              className="mt-2 inline-flex items-center gap-1.5 rounded bg-[#6B5C32] px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[#5a4d2a]"
            >
              <Download className="h-3.5 w-3.5" />
              Install app
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded p-1 text-[#8A8680] transition-colors hover:bg-[#F0ECE9] hover:text-[#1F1D1B]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
      )}

      {showNotif && (
        <div className="mb-4 rounded-lg border border-[#D8D2CC] bg-white p-3 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-[#6B5C32] text-white">
              <Bell className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-[#1F1D1B]">
                Turn on notifications
              </p>
              <p className="mt-0.5 text-xs text-[#6B655C]">
                Get clock-in reminders and shop-floor announcements on this
                device.
              </p>
              <button
                type="button"
                onClick={enableNotifications}
                disabled={notifBusy}
                className="mt-2 inline-flex items-center gap-1.5 rounded bg-[#6B5C32] px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[#5a4d2a] disabled:opacity-60"
              >
                <Bell className="h-3.5 w-3.5" />
                {notifBusy ? "Turning on..." : "Turn on"}
              </button>
            </div>
            <button
              type="button"
              onClick={dismissNotif}
              aria-label="Dismiss"
              className="shrink-0 rounded p-1 text-[#8A8680] transition-colors hover:bg-[#F0ECE9] hover:text-[#1F1D1B]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
