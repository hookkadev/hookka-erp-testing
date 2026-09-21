// ---------------------------------------------------------------------------
// Mail Center — "What may I see" (PRD T-012 R10).
//
// A collapsible note at the bottom of the left rail listing the caller's
// effective scope level and every mailbox they can read from and send from,
// served by GET /api/mail-center/visibility. Answers the question that used
// to need an admin: "why can't I see finance@?" — because it is not here.
// ---------------------------------------------------------------------------
import { useState } from "react";
import { useCachedJson } from "@/lib/cached-fetch";
import { cn } from "@/lib/utils";
import { Eye, ChevronRight } from "lucide-react";

type Visibility = {
  level: string;
  isAdmin: boolean;
  readable: Array<{ address: string; label: string; dept: string; own: boolean }>;
  sendable: Array<{ address: string; label: string; dept: string; own: boolean }>;
};

const LEVEL_COPY: Record<string, string> = {
  personal: "Personal: your own mailbox plus any shared box granted to you.",
  department: "Department: your own mailbox plus every mailbox in your department.",
  company: "Company: every active mailbox.",
};

export function VisibilityPanel() {
  const [open, setOpen] = useState(false);
  const { data } = useCachedJson<Visibility>(
    open ? "/api/mail-center/visibility" : null,
    120,
  );

  return (
    <div className="border-t border-border/60 pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-1.5 text-left text-xs text-muted-foreground transition hover:bg-muted"
        aria-expanded={open}
      >
        <span className="flex items-center gap-1.5">
          <Eye className="h-3.5 w-3.5" />
          What may I see
        </span>
        <ChevronRight
          className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-2 pt-1 text-[11px] text-muted-foreground">
          {!data ? (
            <p>Loading…</p>
          ) : (
            <>
              <p>{LEVEL_COPY[data.level] ?? `Level: ${data.level}`}</p>
              {data.readable.length === 0 ? (
                <p>
                  No mailbox is assigned to you yet. Ask an admin to assign one
                  in User Management.
                </p>
              ) : (
                <ul className="space-y-0.5">
                  {data.readable.map((m) => (
                    <li key={m.address} className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          "inline-block h-1.5 w-1.5 rounded-full",
                          m.own ? "bg-amber-500" : "bg-muted-foreground/40",
                        )}
                        title={m.own ? "Your own mailbox" : "Shared / granted"}
                      />
                      <span className="truncate text-foreground/80" title={m.address}>
                        {m.label ? `${m.label} · ${m.address}` : m.address}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[10px] text-muted-foreground/70">
                You can read from and send from every mailbox listed.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
