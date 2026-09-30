// ---------------------------------------------------------------------------
// user-permissions-panel.tsx — Settings → User Management → Permissions tab.
//
// Owner 2026-09-30: see every account's access and edit it PER ACCOUNT —
// view / create / edit / delete per module, plus the few special rights
// (approve, void, …). Super Admin only; the tab is not rendered for anyone
// else and every route behind it refuses them too.
//
// An account starts out following its role. The first Save gives it its own
// list (from then on a role change does not alter its access); "Reset to role"
// deletes that list again. Super Admin / Admin accounts always have full
// access and are shown read-only.
// ---------------------------------------------------------------------------
import { useCallback, useMemo, useState } from "react";
import { Search, Save, RotateCcw, Lock, Loader2 } from "lucide-react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { roleLabel } from "@/lib/role-labels";
import { useConfirm } from "@/components/ui/confirm-dialog";

type PanelUser = { id: string; email: string; displayName: string; role: string; isActive: boolean };
type CatalogEntry = { resource: string; actions: string[] };
type Access = { userId: string; role: string; locked: boolean; customized: boolean; permissions: string[] };

const STANDARD = [
  { action: "read", label: "View" },
  { action: "create", label: "Create" },
  { action: "update", label: "Edit" },
  { action: "delete", label: "Delete" },
] as const;
const STANDARD_SET = new Set<string>(STANDARD.map((s) => s.action));

const titleCase = (s: string) =>
  s
    .split("-")
    .map((w) => (w === "qc" || w === "rm" || w === "ai" ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");

/** Same wildcard rule as the gate (rbac.ts `permitted`). */
function granted(set: Set<string>, resource: string, action: string): boolean {
  return set.has(`${resource}:${action}`) || set.has(`${resource}:*`) || set.has(`*:${action}`) || set.has("*:*");
}

/** A stored list (wildcards and all) as the explicit boxes it ticks in this catalog. */
function expand(perms: string[], catalog: CatalogEntry[]): Set<string> {
  const set = new Set(perms);
  const out = new Set<string>();
  for (const e of catalog) for (const a of e.actions) if (granted(set, e.resource, a)) out.add(`${e.resource}:${a}`);
  return out;
}

export function UserPermissionsPanel({
  users,
  currentUserId,
  onFlash,
}: {
  users: PanelUser[];
  currentUserId: string | undefined;
  onFlash: (msg: string, kind: "ok" | "err") => void;
}) {
  const { data: catalogResp } = useCachedJson<{ data?: CatalogEntry[] }>("/api/user-permissions/catalog");
  const catalog = useMemo(() => catalogResp?.data ?? [], [catalogResp]);
  const { data: customResp, refresh: refreshCustom } = useCachedJson<{ data?: { userId: string }[] }>(
    "/api/user-permissions",
  );
  const customIds = useMemo(() => new Set((customResp?.data ?? []).map((r) => r.userId)), [customResp]);

  const [userQuery, setUserQuery] = useState("");
  const [moduleQuery, setModuleQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // In-app confirm, never window.confirm ([[feedback_no_naked_edits]]).
  const { confirm, confirmDialog } = useConfirm();

  const original = useMemo(
    () => (access && catalog.length ? expand(access.permissions, catalog) : new Set<string>()),
    [access, catalog],
  );
  const dirty = useMemo(
    () => draft.size !== original.size || [...draft].some((p) => !original.has(p)),
    [draft, original],
  );

  const open = useCallback(
    async (id: string) => {
      if (
        dirty &&
        !(await confirm({
          title: "Unsaved changes",
          message: "Discard your unsaved changes for this account?",
          confirmLabel: "Discard",
          tone: "danger",
        }))
      )
        return;
      setSelectedId(id);
      setAccess(null);
      setLoading(true);
      try {
        const res = await fetch(`/api/user-permissions/${encodeURIComponent(id)}`, { cache: "no-store" });
        const j = (await res.json().catch(() => ({}))) as { success?: boolean; data?: Access; error?: string };
        if (!res.ok || !j.data) throw new Error(j.error || `HTTP ${res.status}`);
        setAccess(j.data);
        setDraft(expand(j.data.permissions, catalog));
      } catch (err) {
        onFlash(`Could not load access: ${err instanceof Error ? err.message : String(err)}`, "err");
      } finally {
        setLoading(false);
      }
    },
    [catalog, confirm, dirty, onFlash],
  );

  const toggle = (key: string) =>
    setDraft((d) => {
      const n = new Set(d);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const toggleRow = (e: CatalogEntry) =>
    setDraft((d) => {
      const n = new Set(d);
      const all = e.actions.every((a) => n.has(`${e.resource}:${a}`));
      for (const a of e.actions) {
        if (all) n.delete(`${e.resource}:${a}`);
        else n.add(`${e.resource}:${a}`);
      }
      return n;
    });

  async function save() {
    if (!access) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/user-permissions/${encodeURIComponent(access.userId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: [...draft].sort() }),
      });
      const j = (await res.json().catch(() => ({}))) as { success?: boolean; data?: Access; error?: string };
      if (!res.ok || !j.data) throw new Error(j.error || `HTTP ${res.status}`);
      setAccess(j.data);
      setDraft(expand(j.data.permissions, catalog));
      invalidateCachePrefix("/api/user-permissions");
      refreshCustom();
      onFlash("Access saved. It applies within a few seconds; the person may need to refresh.", "ok");
    } catch (err) {
      onFlash(`Could not save: ${err instanceof Error ? err.message : String(err)}`, "err");
    } finally {
      setSaving(false);
    }
  }

  async function resetToRole() {
    if (!access) return;
    if (
      !(await confirm({
        title: "Reset to role",
        message: `Reset this account to the ${roleLabel(access.role)} role's access? Its own list is removed.`,
        confirmLabel: "Reset",
        tone: "danger",
      }))
    )
      return;
    setSaving(true);
    try {
      const res = await fetch(`/api/user-permissions/${encodeURIComponent(access.userId)}`, { method: "DELETE" });
      const j = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || j.success === false) throw new Error(j.error || `HTTP ${res.status}`);
      invalidateCachePrefix("/api/user-permissions");
      refreshCustom();
      setAccess(null);
      setDraft(new Set());
      await open(access.userId);
      onFlash("Reset: this account follows its role again.", "ok");
    } catch (err) {
      onFlash(`Could not reset: ${err instanceof Error ? err.message : String(err)}`, "err");
    } finally {
      setSaving(false);
    }
  }

  const listedUsers = useMemo(() => {
    const q = userQuery.trim().toLowerCase();
    return users
      .filter((u) => !q || `${u.displayName} ${u.email} ${roleLabel(u.role)}`.toLowerCase().includes(q))
      .sort((a, b) => (a.displayName || a.email).localeCompare(b.displayName || b.email));
  }, [users, userQuery]);

  const rows = useMemo(() => {
    const q = moduleQuery.trim().toLowerCase();
    return catalog.filter((e) => !q || e.resource.includes(q) || titleCase(e.resource).toLowerCase().includes(q));
  }, [catalog, moduleQuery]);

  const selected = users.find((u) => u.id === selectedId);
  const locked = !!access?.locked;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
      {confirmDialog}
      {/* Accounts */}
      <div className="rounded-lg border border-[#E2DDD8] bg-white">
        <div className="border-b border-[#E2DDD8] p-3">
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-[#9CA3AF]" />
            <input
              className="h-9 w-full rounded-md border border-[#E2DDD8] pl-8 pr-2 text-sm"
              placeholder="Search accounts…"
              value={userQuery}
              onChange={(e) => setUserQuery(e.target.value)}
            />
          </div>
        </div>
        <ul className="max-h-[65vh] overflow-y-auto">
          {listedUsers.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                onClick={() => open(u.id)}
                className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-[#F5F3EF] ${
                  u.id === selectedId ? "bg-[#F0ECE9]" : ""
                }`}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium text-[#1F1D1B]">
                    {u.displayName || u.email}
                    {u.id === currentUserId ? " (you)" : ""}
                  </span>
                  <span className="block truncate text-xs text-[#8A8577]">
                    {roleLabel(u.role)}
                    {u.isActive ? "" : " · Disabled"}
                  </span>
                </span>
                {customIds.has(u.id) && (
                  <span className="shrink-0 rounded bg-[#FFF4DD] px-1.5 py-0.5 text-[10px] font-semibold text-[#8A5A00]">
                    Custom
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* Access grid */}
      <div className="rounded-lg border border-[#E2DDD8] bg-white">
        {!selectedId ? (
          <div className="p-10 text-center text-sm text-[#8A8577]">Pick an account to see and edit its access.</div>
        ) : loading || !access || !catalog.length ? (
          <div className="flex items-center justify-center gap-2 p-10 text-sm text-[#8A8577]">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading access…
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#E2DDD8] p-4">
              <div>
                <div className="text-base font-semibold text-[#1F1D1B]">{selected?.displayName || selected?.email}</div>
                <div className="text-xs text-[#8A8577]">
                  Role: {roleLabel(access.role)} ·{" "}
                  {locked ? "Full access (always)" : access.customized ? "Custom access" : `Follows the ${roleLabel(access.role)} role`}
                </div>
              </div>
              {!locked && (
                <div className="flex gap-2">
                  {access.customized && (
                    <button
                      type="button"
                      onClick={resetToRole}
                      disabled={saving}
                      className="flex h-9 items-center gap-1.5 rounded-md border border-[#E2DDD8] px-3 text-[13px] text-[#6B7280] hover:text-[#1F1D1B] disabled:opacity-50"
                    >
                      <RotateCcw className="h-4 w-4" /> Reset to role
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setDraft(new Set(original))}
                    disabled={!dirty || saving}
                    className="h-9 rounded-md border border-[#E2DDD8] px-3 text-[13px] text-[#6B7280] hover:text-[#1F1D1B] disabled:opacity-50"
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    onClick={save}
                    disabled={!dirty || saving}
                    className="flex h-9 items-center gap-1.5 rounded-md bg-[#6B5C32] px-3 text-[13px] font-semibold text-white disabled:opacity-50"
                  >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Save
                  </button>
                </div>
              )}
            </div>

            {locked ? (
              <div className="flex items-center gap-2 p-6 text-sm text-[#6B7280]">
                <Lock className="h-4 w-4" />
                Super Admin and Admin accounts always have full access. Change their role on the Users tab if needed.
              </div>
            ) : (
              <>
                {!access.customized && (
                  <p className="border-b border-[#E2DDD8] bg-[#F7F5F2] px-4 py-2 text-xs text-[#6B7280]">
                    Saving gives this account its own access list. After that, changing its role no longer changes
                    what it can do — use "Reset to role" to follow the role again.
                  </p>
                )}
                <div className="p-3">
                  <div className="relative mb-2 max-w-xs">
                    <Search className="absolute left-2 top-2.5 h-4 w-4 text-[#9CA3AF]" />
                    <input
                      className="h-9 w-full rounded-md border border-[#E2DDD8] pl-8 pr-2 text-sm"
                      placeholder="Filter modules…"
                      value={moduleQuery}
                      onChange={(e) => setModuleQuery(e.target.value)}
                    />
                  </div>
                  <div className="max-h-[60vh] overflow-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-white text-[11px] uppercase tracking-wide text-[#8A8577]">
                        <tr>
                          <th className="px-2 py-2 text-left">Module</th>
                          {STANDARD.map((s) => (
                            <th key={s.action} className="w-16 px-2 py-2 text-center">
                              {s.label}
                            </th>
                          ))}
                          <th className="px-2 py-2 text-left">Other rights</th>
                          <th className="w-12 px-2 py-2 text-center">All</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((e) => {
                          const specials = e.actions.filter((a) => !STANDARD_SET.has(a));
                          const all = e.actions.every((a) => draft.has(`${e.resource}:${a}`));
                          return (
                            <tr key={e.resource} className="border-t border-[#F0ECE9]">
                              <td className="px-2 py-1.5 text-[#1F1D1B]">{titleCase(e.resource)}</td>
                              {STANDARD.map((s) => {
                                const key = `${e.resource}:${s.action}`;
                                return (
                                  <td key={s.action} className="px-2 py-1.5 text-center">
                                    <input
                                      type="checkbox"
                                      aria-label={`${titleCase(e.resource)} ${s.label}`}
                                      checked={draft.has(key)}
                                      onChange={() => toggle(key)}
                                    />
                                  </td>
                                );
                              })}
                              <td className="px-2 py-1.5">
                                <div className="flex flex-wrap gap-2">
                                  {specials.map((a) => {
                                    const key = `${e.resource}:${a}`;
                                    return (
                                      <label key={a} className="flex items-center gap-1 text-xs text-[#6B7280]">
                                        <input type="checkbox" checked={draft.has(key)} onChange={() => toggle(key)} />
                                        {titleCase(a)}
                                      </label>
                                    );
                                  })}
                                </div>
                              </td>
                              <td className="px-2 py-1.5 text-center">
                                <input
                                  type="checkbox"
                                  aria-label={`${titleCase(e.resource)} all`}
                                  checked={all}
                                  onChange={() => toggleRow(e)}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
