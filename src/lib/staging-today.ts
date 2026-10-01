// Staging-only: never PR this into main.
// "Today override" for testing month-end, overdue and aging screens without
// waiting for the calendar. The fake date lives in sessionStorage (per tab,
// off by default) and is only read on a staging.* host. It affects READS only:
// todayYmdMYForReads() honours it, todayYmdMY() (used for dates written into
// documents) never does. The server side is src/api/lib/staging-today.ts.
// No top-level window access: the worker imports parseStagingToday from here.
import { todayYmdMY } from "./utils";

export const STAGING_TODAY_HEADER = "X-Staging-Today";
export const STAGING_TODAY_KEY = "hookka_staging_today";

/** A real calendar date as yyyy-mm-dd, else null (2026-02-30 is rejected). */
export function parseStagingToday(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(v + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
}

/** The active fake date for this tab, or null (not staging, unset, invalid). */
export function readStagingToday(): string | null {
  if (typeof window === "undefined") return null;
  if (!window.location.hostname.startsWith("staging.")) return null;
  try {
    return parseStagingToday(window.sessionStorage.getItem(STAGING_TODAY_KEY));
  } catch {
    return null;
  }
}

/** Set (valid yyyy-mm-dd) or clear (null) the fake date for this tab. */
export function writeStagingToday(v: string | null): void {
  try {
    const ok = parseStagingToday(v);
    if (ok) window.sessionStorage.setItem(STAGING_TODAY_KEY, ok);
    else window.sessionStorage.removeItem(STAGING_TODAY_KEY);
  } catch {
    // storage blocked: the override simply stays off
  }
}

/** todayYmdMY() for read/report defaults: the fake date when one is active. */
export function todayYmdMYForReads(): string {
  return readStagingToday() ?? todayYmdMY();
}
