// Staging-only: never PR this into main.
// "View as role" for testing what each role sees and may do, without a test
// account per role. The picked role lives in sessionStorage (per tab, off by
// default) and is only read on a staging.* host. It is sent as X-Staging-Role
// by the fetch patch in api-client.ts; the server half is
// src/api/lib/staging-role.ts, which honours it only for a real SUPER_ADMIN.
// No top-level window access: the worker imports parseStagingRole from here.
import { ROLE_OPTIONS } from "./role-labels";

export const STAGING_ROLE_HEADER = "X-Staging-Role";
export const STAGING_ROLE_KEY = "hookka_staging_role";

/** A role from the picker list (case-insensitive), else null. */
export function parseStagingRole(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const r = v.trim().toUpperCase();
  return ROLE_OPTIONS.some((o) => o.value === r) ? r : null;
}

/** The role this tab is viewing as, or null (not staging, unset, invalid). */
export function readStagingRole(): string | null {
  if (typeof window === "undefined") return null;
  if (!window.location.hostname.startsWith("staging.")) return null;
  try {
    return parseStagingRole(window.sessionStorage.getItem(STAGING_ROLE_KEY));
  } catch {
    return null;
  }
}

/** Set (a valid role) or clear (null) the role for this tab. */
export function writeStagingRole(v: string | null): void {
  try {
    const ok = parseStagingRole(v);
    if (ok) window.sessionStorage.setItem(STAGING_ROLE_KEY, ok);
    else window.sessionStorage.removeItem(STAGING_ROLE_KEY);
  } catch {
    // storage blocked: the override simply stays off
  }
}
