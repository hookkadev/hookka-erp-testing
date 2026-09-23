// useVersionCheck — detect when a new deploy lands while the SPA is open.
//
// How it works:
//   1. On mount, remember the "signature" of the current page: the `src`
//      hash of the first bundled <script> tag inside index.html. Vite
//      fingerprints every chunk, so any deploy with real changes produces
//      a new hash.
//   2. Every `intervalMs`, refetch `/` (forced past the CDN with a
//      cache-buster) and parse its first script hash.
//   3. When the hash differs from the one we remembered, call `onNewVersion`
//      exactly once. Callers should use `useAutoUpdateOnNavigate` (below),
//      which also reloads on the next page change — never mid-form.
//
// Why script hash instead of a dedicated /api/version endpoint? No new
// route to deploy, works with any static-host CDN, and is self-calibrating:
// the hash is only different when the build is actually different. Vite
// guarantees stable hashing across identical builds.

import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

function extractFirstScriptHash(html: string): string | null {
  // Matches <script src="/assets/index-<hash>.js"> — both the entry and
  // any preloaded module (whichever comes first).
  const m = html.match(/<script[^>]+src="[^"]*\/assets\/([^"]+)"/);
  return m ? m[1] : null;
}

export function useVersionCheck({
  intervalMs = 2 * 60 * 1000, // 2 min
  onNewVersion,
}: {
  intervalMs?: number;
  onNewVersion: () => void;
}) {
  const baselineRef = useRef<string | null>(null);
  const firedRef = useRef(false);
  // Latest callback in a ref: callers pass an inline arrow, and having it in
  // the effect deps restarted the poll (and its 30s first check) every render.
  const onNewVersionRef = useRef(onNewVersion);
  useEffect(() => {
    onNewVersionRef.current = onNewVersion;
  });

  useEffect(() => {
    // Capture the baseline hash from the page that's currently running.
    const existing = Array.from(
      document.querySelectorAll<HTMLScriptElement>('script[src*="/assets/"]'),
    )
      .map((s) => {
        const m = s.src.match(/\/assets\/([^"?]+)/);
        return m ? m[1] : null;
      })
      .find((v) => Boolean(v)) as string | null;
    baselineRef.current = existing;

    let stopped = false;
    const check = async () => {
      if (stopped || firedRef.current) return;
      if (document.hidden) return;
      try {
        // Cache-buster query so we always hit origin through CDN revalidation.
        const res = await fetch(`/?v=${Date.now()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!res.ok) return;
        const html = await res.text();
        const current = extractFirstScriptHash(html);
        if (current && baselineRef.current && current !== baselineRef.current) {
          firedRef.current = true;
          onNewVersionRef.current();
        }
      } catch {
        // Network hiccup is fine — try again next interval.
      }
    };

    const id = window.setInterval(check, intervalMs);
    // Also check when the tab regains focus (user came back after a while).
    const onFocus = () => { void check(); };
    const onVisible = () => {
      if (!document.hidden) void check();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    // First quick check 30s after mount — don't wait the full interval on
    // the very first load.
    const firstId = window.setTimeout(check, 30_000);

    return () => {
      stopped = true;
      window.clearInterval(id);
      window.clearTimeout(firstId);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs]);
}

/**
 * Version check that actually lands the new deploy: once a new build is seen,
 * the NEXT page change does a full reload (the router has already moved to
 * the new path, so the reload just re-opens it on the new code). The user has
 * left whatever form they were in by then, so nothing half-typed is lost.
 * BUG-2026-09-23-184: the old one-shot "Reload?" prompt, once dismissed, left
 * the tab on old code for the rest of the day — a deployed fix (e.g. a
 * pricing fix) silently didn't reach that operator.
 */
export function useAutoUpdateOnNavigate(onNewVersion?: () => void) {
  const { pathname } = useLocation();
  const staleRef = useRef(false);
  useVersionCheck({
    onNewVersion: () => {
      staleRef.current = true;
      onNewVersion?.();
    },
  });
  useEffect(() => {
    if (staleRef.current) window.location.reload();
  }, [pathname]);
}
