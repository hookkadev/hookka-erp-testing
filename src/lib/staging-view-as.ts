// Staging-only: never PR this into main.
// "View as" a user, for testing what an account sees and may do (its role and
// its own list from User Management > Permissions) without signing in as it.
// The pick lives in sessionStorage (per tab, off by default) and is only read
// on a staging.* host. Its id is sent as X-Staging-View-As by the fetch patch
// in api-client.ts; the server half is src/api/lib/staging-view-as.ts, which
// honours it only for a real SUPER_ADMIN.
// No top-level window access: the worker imports parseViewAsId from here.

export const STAGING_VIEW_AS_HEADER = "X-Staging-View-As";
export const STAGING_VIEW_AS_KEY = "hookka_staging_view_as";

export type ViewAs = { id: string; role: string; name: string };

/** A user id as the users table issues them, else null. */
export function parseViewAsId(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
}

function parseViewAs(raw: string | null): ViewAs | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ViewAs>;
    const id = parseViewAsId(v.id);
    if (!id || typeof v.role !== "string" || !v.role) return null;
    return { id, role: v.role.toUpperCase(), name: typeof v.name === "string" ? v.name : id };
  } catch {
    return null;
  }
}

/** The user this tab is viewing as, or null (not staging, unset, invalid). */
export function readStagingViewAs(): ViewAs | null {
  if (typeof window === "undefined") return null;
  if (!window.location.hostname.startsWith("staging.")) return null;
  try {
    return parseViewAs(window.sessionStorage.getItem(STAGING_VIEW_AS_KEY));
  } catch {
    return null;
  }
}

/** Set (a valid pick) or clear (null) the user for this tab. */
export function writeStagingViewAs(v: ViewAs | null): void {
  try {
    const ok = v ? parseViewAs(JSON.stringify(v)) : null;
    if (ok) window.sessionStorage.setItem(STAGING_VIEW_AS_KEY, JSON.stringify(ok));
    else window.sessionStorage.removeItem(STAGING_VIEW_AS_KEY);
  } catch {
    // storage blocked: the override simply stays off
  }
}
