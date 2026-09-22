import { useState } from "react";
import { useCachedJson, invalidateCache } from "@/lib/cached-fetch";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { ShieldCheck } from "lucide-react";
import { BORDER, MUTED } from "./dashboard-shared-lib";
import { ServiceCaseNo } from "./ServiceCaseLink";
import { useServiceCaseLinks } from "./use-service-case-links";

// ---------------------------------------------------------------------------
// ServiceApprovalsPanel — service cases waiting for an approve / reject
// decision (1-to-1 exchanges and general case approvals; `kind` tells them
// apart). Standalone on purpose: it reads and writes its OWN endpoints, not the
// cached dashboard feed, so it can be dropped into any tab unchanged.
//
//   GET  /api/service-cases/approvals             (service-cases:read)
//   POST /api/service-cases/:id/approval/approve  (service-cases:approve)
//   POST /api/service-cases/:id/approval/reject   (service-cases:approve, reason required)
//
// Props are optional: `title` re-labels the card (e.g. "Service Case
// Approvals"), `kind` narrows the list to one approval kind, `onChanged` fires
// after a decision so a host tab can refresh its own numbers.
// ---------------------------------------------------------------------------
type Pending = {
  id: string;
  caseNo: string | null;
  customerName: string | null;
  issue: string;
  caseStatus: string;
  kind: "EXCHANGE" | "GENERAL" | null;
  requestedAt: string | null;
  note: string | null;
};

const URL = "/api/service-cases/approvals";
const KIND_LABEL = { EXCHANGE: "1-to-1 exchange", GENERAL: "Case approval" } as const;

export function ServiceApprovalsPanel({
  title = "Pending approvals",
  kind,
  onChanged,
}: {
  title?: string;
  kind?: "EXCHANGE" | "GENERAL";
  onChanged?: () => void;
}) {
  // ttl 0: an approval queue must never be served stale.
  const { data, loading, error, refresh } = useCachedJson<{ success?: boolean; data?: Pending[] }>(URL, 0);
  const { confirm } = useConfirm();
  const { toast } = useToast();
  // Only the case number links out: the row holds Approve / Reject, so the row
  // itself is never a click target.
  const { canOpen } = useServiceCaseLinks();
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const rows = (data?.data ?? []).filter((r) => !kind || r.kind === kind);

  async function decide(row: Pending, decision: "approve" | "reject") {
    const label = row.caseNo ?? row.id;
    if (decision === "approve") {
      const ok = await confirm({
        title: "Approve",
        message: `Approve ${row.kind ? KIND_LABEL[row.kind].toLowerCase() : "request"} for case ${label}? This lets it proceed.`,
        confirmLabel: "Approve",
      });
      if (!ok) return;
    }
    setBusy(row.id);
    try {
      const res = await fetch(`/api/service-cases/${encodeURIComponent(row.id)}/approval/${decision}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(decision === "reject" ? { note: reason.trim() } : {}),
      });
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || !body.success) throw new Error(body.error ?? `Request failed (${res.status})`);
      toast.success(decision === "approve" ? `Approved ${label}` : `Rejected ${label}`);
      setRejecting(null);
      setReason("");
      invalidateCache(URL);
      invalidateCache("/api/dashboard/prototype");
      refresh();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the decision");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-[#6B5C32]" />
        <CardTitle>{title}</CardTitle>
        <span className="text-xs text-[#6B7280] tabular-nums">{rows.length}</span>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="px-4 py-6 text-center text-xs" style={{ color: MUTED }}>Loading…</div>
        ) : error ? (
          <div className="px-4 py-6 text-center text-xs text-[#B5701A]">Couldn't load approvals: {error}</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs" style={{ color: MUTED }}>Nothing is waiting for approval.</div>
        ) : (
          <ul>
            {rows.map((r) => (
              <li key={r.id} className="px-4 py-3 border-t" style={{ borderColor: BORDER }}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 text-[12.5px]">
                    <p className="text-[#1F1D1B]">
                      <ServiceCaseNo id={r.id} caseNo={r.caseNo ?? r.id} canOpen={canOpen} className="font-mono font-semibold" />
                      <span className="mx-2 text-[#6B7280]">{r.customerName ?? "—"}</span>
                      <span className="inline-flex rounded-full bg-[#FAEFCB] px-2 py-0.5 text-[11px] font-semibold text-[#9C6F1E]">
                        {r.kind ? KIND_LABEL[r.kind] : "Approval"}
                      </span>
                    </p>
                    {r.issue && <p className="mt-0.5 text-[#6B7280] truncate max-w-[60ch] max-md:whitespace-normal">{r.issue}</p>}
                    {r.note && <p className="mt-0.5 text-[#6B7280] italic">Note: {r.note}</p>}
                    {r.requestedAt && <p className="mt-0.5 text-[11px] text-[#6B7280]">Requested {r.requestedAt.slice(0, 10)}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0 [&_button]:max-md:h-10">
                    <Button size="sm" disabled={busy === r.id} onClick={() => decide(r, "approve")}>Approve</Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === r.id}
                      onClick={() => { setRejecting(rejecting === r.id ? null : r.id); setReason(""); }}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
                {rejecting === r.id && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 [&_button]:max-md:h-10">
                    <Input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Reason for rejecting (required)"
                      className="h-8 max-md:h-10 max-md:text-sm text-xs max-w-md"
                    />
                    <Button size="sm" variant="outline" disabled={!reason.trim() || busy === r.id} onClick={() => decide(r, "reject")}>
                      Confirm reject
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
