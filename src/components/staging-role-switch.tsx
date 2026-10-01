// Staging-only: never PR this into main.
// Topbar "View as" role picker next to the API log button (src/lib/staging-role.ts).
// Off by default, per tab, shown to a real SUPER_ADMIN only (the server
// ignores the header from anyone else). While a role is picked the pill turns
// red. Picking wipes the API cache and reloads so every screen re-reads.
import { getCurrentUser, wipeApiCache } from "@/lib/auth";
import { ROLE_OPTIONS, roleShort } from "@/lib/role-labels";
import { readStagingRole, writeStagingRole } from "@/lib/staging-role";

const TIP =
  "Staging only, this tab only. Menus, page guards and the API all act as the picked role. You stay signed in as yourself, so 'my own' data (attendance, payslip) is still yours, and the audit log records your real role.";

export function StagingRoleSwitch() {
  if (!window.location.hostname.startsWith("staging.")) return null;
  const active = readStagingRole();
  // With no pick active getCurrentUser() carries the real role.
  if (!active && getCurrentUser()?.role !== "SUPER_ADMIN") return null;

  return (
    <label
      title={TIP}
      className={`flex h-8 items-center gap-1 rounded-full px-3 text-xs font-semibold print:hidden ${
        active ? "bg-red-600 text-white" : "bg-amber-100 text-amber-800"
      }`}
    >
      View as
      <select
        value={active ?? ""}
        onChange={(e) => {
          writeStagingRole(e.target.value || null);
          wipeApiCache();
          window.location.reload();
        }}
        aria-label="View as role"
        className="bg-transparent font-semibold outline-none [&>option]:text-stone-900"
      >
        <option value="">Me (Super Admin)</option>
        {ROLE_OPTIONS.filter((o) => o.value !== "SUPER_ADMIN").map((o) => (
          <option key={o.value} value={o.value}>
            {roleShort(o.value)}
          </option>
        ))}
      </select>
    </label>
  );
}
