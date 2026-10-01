// Staging-only: never PR this into main.
// Server half of "view as". Returns the X-Staging-View-As user (id, role, org)
// only when the request is a staging request (isStagingRequest), the signed-in
// account is really SUPER_ADMIN, and the id names an active user. ADMIN is
// refused on purpose: it cannot manage users, so acting as a Super Admin would
// be a promotion. Writes under /api/auth/ (password, 2FA, sessions) are never
// impersonated, so your own account changes stay yours. Anywhere else, on a
// bad id or on a lookup error it returns null and the real account stands.
import { isStagingRequest } from "./staging-gate";
import { parseViewAsId, STAGING_VIEW_AS_HEADER } from "../../lib/staging-view-as";

type ViewAsCtx = Parameters<typeof isStagingRequest>[0] & {
  req: { header(name: string): string | undefined; method: string; path: string };
  var: { DB: D1Database };
};

export type ViewAsUser = { userId: string; role: string; orgId: string | null };

export async function stagingViewAsUser(
  c: ViewAsCtx,
  real: { userId: string; role: string | null | undefined },
): Promise<ViewAsUser | null> {
  if ((real.role ?? "").toUpperCase() !== "SUPER_ADMIN") return null;
  if (!isStagingRequest(c)) return null;
  if (c.req.method !== "GET" && c.req.path.startsWith("/api/auth/")) return null;
  const id = parseViewAsId(c.req.header(STAGING_VIEW_AS_HEADER));
  if (!id || id === real.userId) return null;
  try {
    const u = await c.var.DB.prepare(
      "SELECT id, role, isActive, orgId FROM users WHERE id = ? LIMIT 1",
    )
      .bind(id)
      .first<{ id: string; role: string | null; isActive: number | boolean; orgId: string | null }>();
    if (!u || Number(u.isActive) !== 1 || !u.role) return null;
    return { userId: u.id, role: u.role, orgId: u.orgId ?? null };
  } catch {
    return null;
  }
}
