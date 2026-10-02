// PWA install helpers shared by the worker portal card and the /m office app.
//
// Chromium fires `beforeinstallprompt` ONCE, shortly after the page loads. A
// listener added later (a lazily-loaded screen, the More menu) misses it and
// the "Install app" button can never work. So this module attaches the
// listener at import time; src/main.tsx imports it before anything mounts.
// Components read the stashed offer through useInstallOffer().
import { useSyncExternalStore } from "react";

// The shape of the (non-standard but widely-shipped) beforeinstallprompt event.
export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let offer: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    // Stop Chrome's own mini-infobar; our button calls prompt() instead.
    e.preventDefault();
    offer = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    offer = null;
    emit();
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The browser's pending install offer, or null (none yet / used / not supported). */
export function useInstallOffer(): BeforeInstallPromptEvent | null {
  return useSyncExternalStore(subscribe, () => offer, () => null);
}

/** Show the browser's install dialog. The offer is single-use either way. */
export async function promptInstall(): Promise<void> {
  const e = offer;
  if (!e) return;
  offer = null;
  emit();
  try {
    await e.prompt();
    await e.userChoice;
  } catch {
    /* user closed the native dialog — nothing to do */
  }
}

// Already running as an installed app? Then there's nothing to prompt.
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const mql =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches;
  // iOS Safari exposes navigator.standalone instead of the display-mode query.
  const iosStandalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return mql || iosStandalone;
}

// iOS Safari has no beforeinstallprompt — callers show a manual hint there.
export function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua);
  // Exclude Chrome / Firefox / Edge on iOS (they can't Add to Home Screen).
  const isSafari = /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
  return isIos && isSafari;
}
