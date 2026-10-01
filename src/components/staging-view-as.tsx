// Staging-only: never PR this into main.
// Topbar "View as" user picker next to the API log button (src/lib/staging-view-as.ts).
// Lists the accounts from User Management; picking one makes the app act as
// that account (its role and its own Permissions-tab list). Off by default,
// per tab, shown to a real SUPER_ADMIN only (the server ignores the header
// from anyone else). While active the pill turns red. Picking wipes the API
// cache and reloads so every screen re-reads.
import { useEffect, useState } from "react";
import { ChevronDown, Eye } from "lucide-react";
import { getCurrentUser, wipeApiCache } from "@/lib/auth";
import { roleShort } from "@/lib/role-labels";
import { readStagingViewAs, STAGING_VIEW_AS_HEADER, writeStagingViewAs, type ViewAs } from "@/lib/staging-view-as";

const TIP =
  "Staging only, this tab only. The app acts as the picked account: its role, its own list from User Management > Permissions, its customers and its own records. Writes are saved as that account; the audit log records you. Your password / 2FA changes are never done as them.";

type UserRow = { id: string; displayName: string; email: string; role: string; isActive: boolean };

export function StagingViewAs() {
  if (!window.location.hostname.startsWith("staging.")) return null;
  const active = readStagingViewAs();
  // With no pick active getCurrentUser() carries the real role.
  if (!active && getCurrentUser()?.role !== "SUPER_ADMIN") return null;
  return <Picker active={active} />;
}

function apply(v: ViewAs | null) {
  writeStagingViewAs(v);
  wipeApiCache();
  window.location.reload();
}

function Picker({ active }: { active: ViewAs | null }) {
  const [users, setUsers] = useState<UserRow[]>([]);
  useEffect(() => {
    // An empty header beats the tab's pick (see api-client.ts), so the list
    // is always read as you, even while viewing as someone without users:read.
    fetch("/api/users", { headers: { [STAGING_VIEW_AS_HEADER]: "" } })
      .then((r) => (r.ok ? (r.json() as Promise<{ data?: UserRow[] }>) : null))
      .then((j) => {
        const rows = (j?.data ?? []).filter((u) => u.isActive);
        rows.sort((a, b) => (a.displayName || a.email).localeCompare(b.displayName || b.email));
        setUsers(rows);
      })
      .catch(() => undefined);
  }, []);
  const me = getCurrentUser()?.id;

  return (
    <label
      title={TIP}
      className={`relative flex h-9 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-xs font-semibold print:hidden ${
        active ? "bg-red-600 text-white" : "bg-amber-100 text-amber-800"
      }`}
    >
      <Eye className="h-4 w-4 shrink-0" />
      <span className="hidden xl:inline">{active ? "Viewing as" : "View as"}</span>
      <span className="max-w-[8rem] truncate xl:max-w-[12rem]">
        {active ? `${active.name} · ${roleShort(active.role)}` : "Me"}
      </span>
      <ChevronDown className="h-3.5 w-3.5 shrink-0" />
      {/* Native select over the whole pill, invisible: the pill sizes to the
          picked name above, not to the longest name in the list. */}
      <select
        value={active?.id ?? ""}
        onChange={(e) => {
          const u = users.find((x) => x.id === e.target.value);
          apply(u ? { id: u.id, role: u.role, name: u.displayName || u.email } : null);
        }}
        aria-label="View as user"
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        <option value="">Me</option>
        {active && !users.some((u) => u.id === active.id) && (
          <option value={active.id}>{active.name} · {roleShort(active.role)}</option>
        )}
        {users
          .filter((u) => u.id !== me)
          .map((u) => (
            <option key={u.id} value={u.id}>
              {u.displayName || u.email} · {roleShort(u.role)}
            </option>
          ))}
      </select>
    </label>
  );
}
