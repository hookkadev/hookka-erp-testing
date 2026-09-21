// ---------------------------------------------------------------------------
// Mail Center — pick recipients from the org chart (PRD T-012 R9).
//
// Tabs: Department / My team / My managers / Everyone, served by
// GET /api/mail-center/directory (built on the org chart's people loader).
// Tick people, then "Add to To" / "Add to Cc". The parent merges the picked
// addresses into its chips. Rendered as a fixed overlay the house way (same
// shape as ComposeDialog / useConfirm).
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useCachedJson } from "@/lib/cached-fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Users, X, Search } from "lucide-react";

export type DirectoryPerson = {
  key: string;
  userId: string | null;
  name: string;
  email: string;
  position: string;
  department: string;
};

type Directory = {
  me: DirectoryPerson | null;
  department: DirectoryPerson[];
  team: DirectoryPerson[];
  managers: DirectoryPerson[];
  everyone: DirectoryPerson[];
};

type Tab = "department" | "team" | "managers" | "everyone";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "department", label: "Department" },
  { id: "team", label: "My team" },
  { id: "managers", label: "My managers" },
  { id: "everyone", label: "Everyone" },
];

export function RecipientPicker({
  open,
  onClose,
  onPick,
  already = [],
}: {
  open: boolean;
  onClose: () => void;
  // Called with the ticked addresses and which field they go to.
  onPick: (addresses: string[], field: "to" | "cc") => void;
  // Addresses already on the mail, shown ticked-and-disabled.
  already?: string[];
}) {
  const { data, loading } = useCachedJson<Directory>(
    open ? "/api/mail-center/directory" : null,
    120,
  );
  const [tab, setTab] = useState<Tab>("department");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const alreadySet = useMemo(
    () => new Set(already.map((a) => a.toLowerCase())),
    [already],
  );

  const rows = useMemo(() => {
    const list = data?.[tab] ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        p.email.toLowerCase().includes(needle) ||
        p.position.toLowerCase().includes(needle) ||
        p.department.toLowerCase().includes(needle),
    );
  }, [data, tab, q]);

  if (!open) return null;

  function toggle(email: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  }

  function commit(field: "to" | "cc") {
    const list = Array.from(picked);
    if (list.length === 0) return;
    onPick(list, field);
    setPicked(new Set());
    onClose();
  }

  const counts: Record<Tab, number> = {
    department: data?.department.length ?? 0,
    team: data?.team.length ?? 0,
    managers: data?.managers.length ?? 0,
    everyone: data?.everyone.length ?? 0,
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Pick recipients from the org chart"
        className="relative mx-4 flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg border border-[#E2DDD8] bg-white shadow-xl"
      >
        <div className="flex items-center justify-between gap-2 border-b border-[#E2DDD8] px-4 py-3">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-amber-700" />
            <h3 className="text-sm font-semibold text-[#1F1D1B]">
              Pick from the org chart
            </h3>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-[#6B7280] transition hover:bg-[#F0ECE9]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-[#E2DDD8] px-3 pt-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "rounded-t-md px-3 py-1.5 text-xs font-medium transition",
                tab === t.id
                  ? "border border-b-white border-[#E2DDD8] bg-white text-[#6B5C32] -mb-px"
                  : "text-[#6B7280] hover:bg-[#F0ECE9]",
              )}
            >
              {t.label}
              <span className="ml-1 text-[10px] text-[#9CA3AF]">{counts[t.id]}</span>
            </button>
          ))}
        </div>

        <div className="px-4 pt-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#9CA3AF]" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, address, position"
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {loading && !data ? (
            <p className="py-6 text-center text-xs text-[#6B7280]">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-xs text-[#6B7280]">
              {tab === "department"
                ? "Nobody else is in your department on the org chart."
                : tab === "team"
                  ? "No reports or peers on the org chart yet."
                  : tab === "managers"
                    ? "No manager set for you on the org chart."
                    : "No one matches."}
            </p>
          ) : (
            <ul className="divide-y divide-[#F0ECE9]">
              {rows.map((p) => {
                const email = p.email.toLowerCase();
                const onMail = alreadySet.has(email);
                const checked = onMail || picked.has(email);
                return (
                  <li key={p.key}>
                    <label
                      className={cn(
                        "flex cursor-pointer items-center gap-3 py-2",
                        onMail && "cursor-default opacity-60",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={onMail}
                        onChange={() => toggle(email)}
                        className="h-3.5 w-3.5 accent-[#6B5C32]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-[#1F1D1B]">
                          {p.name}
                          {p.position && (
                            <span className="ml-1.5 text-[11px] text-[#6B7280]">
                              {p.position}
                            </span>
                          )}
                        </span>
                        <span className="block truncate text-[11px] text-[#6B7280]">
                          {p.email}
                          {p.department ? ` · ${p.department}` : ""}
                          {onMail ? " · already on this mail" : ""}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-[#E2DDD8] bg-[#FAF9F7] px-4 py-3">
          <p className="text-[11px] text-[#6B7280]">
            {picked.size === 0 ? "Tick people to add." : `${picked.size} picked`}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={picked.size === 0}
              onClick={() => commit("cc")}
            >
              Add to Cc
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
              disabled={picked.size === 0}
              onClick={() => commit("to")}
            >
              Add to To
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
