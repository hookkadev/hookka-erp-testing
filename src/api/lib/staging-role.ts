// Staging-only: never PR this into main.
// Server half of "view as role". Returns the X-Staging-Role role only when the
// request is a staging request (isStagingRequest), the signed-in account is
// really SUPER_ADMIN, and the header names a known role. ADMIN is refused on
// purpose: it cannot manage users, so letting it pick SUPER_ADMIN would be a
// promotion. Anywhere else it returns null and the real role stands.
import { isStagingRequest } from "./staging-gate";
import { parseStagingRole, STAGING_ROLE_HEADER } from "../../lib/staging-role";

type RoleCtx = Parameters<typeof isStagingRequest>[0] & {
  req: { header(name: string): string | undefined };
};

export function stagingRoleFromRequest(c: RoleCtx, realRole: string | null | undefined): string | null {
  if ((realRole ?? "").toUpperCase() !== "SUPER_ADMIN") return null;
  if (!isStagingRequest(c)) return null;
  return parseStagingRole(c.req.header(STAGING_ROLE_HEADER));
}
