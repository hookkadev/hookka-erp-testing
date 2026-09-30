// Staging-only test tool on the SO detail page: complete this order's job
// cards up to a chosen stage in one click, or put them back to WAITING, so a
// test can start from "ready for DO" without walking every department tab.
// Renders only on the staging host. Staging-only: never PR this into main.
import { useState } from "react";
import { FlaskConical } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { invalidateCachePrefix } from "@/lib/cached-fetch";
import { todayYmdMY } from "@/lib/utils";
import { REPAIR_DEPT_CODES, REPAIR_DEPT_LABELS } from "@/lib/repair-scope";
import { planCompleteUpTo, planReset, type SkipPO, type SkipPatch } from "@/lib/staging-stage-skip";

type LinkedPORef = { id: string; poNo: string; status: string; deliveryDoNo?: string; deliveryStatus?: string };

export function StagingStageSkipCard({ linkedPOs, onChanged }: { linkedPOs: LinkedPORef[]; onChanged: () => void }) {
  const { confirm } = useConfirm();
  const [upTo, setUpTo] = useState<string>("PACKING");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  if (!window.location.hostname.startsWith("staging.")) return null;

  // A PO already on a live delivery order is left alone: moving it would
  // change a document that exists, not set up a test. The SO still reports a
  // CANCELLED DO as the PO's delivery, and that one no longer holds it.
  const open = linkedPOs.filter(
    (po) => (!po.deliveryDoNo || po.deliveryStatus === "CANCELLED") && po.status !== "CANCELLED",
  );

  const run = async (mode: "complete" | "reset") => {
    const label = REPAIR_DEPT_LABELS[upTo as keyof typeof REPAIR_DEPT_LABELS];
    const ok = await confirm({
      title: mode === "complete" ? `Complete up to ${label}` : "Reset stages",
      message:
        mode === "complete"
          ? `Mark every job card up to ${label} as completed today on ${open.length} production order(s)? Staging only.`
          : `Clear the completion date on every completed job card of ${open.length} production order(s)? They go back to WAITING. Staging only.`,
      danger: mode === "reset",
    });
    if (!ok) return;
    setBusy(true);
    const lines: string[] = [];
    try {
      // The SO's per-PO delivery field is first-DO-wins and can name a
      // cancelled DO while a live one exists, so ask the server which POs a
      // live DO holds before writing anything.
      const lr = await fetch("/api/delivery-orders/linked-po-ids");
      const lj = (await lr.json().catch(() => ({}))) as { poIds?: string[] };
      if (!lr.ok || !Array.isArray(lj.poIds)) throw new Error("Could not check which orders are on a delivery order.");
      const onLiveDo = new Set(lj.poIds);
      const pos: SkipPO[] = [];
      for (const po of open) {
        if (onLiveDo.has(po.id)) {
          lines.push(`${po.poNo} is on a live delivery order, left alone.`);
          continue;
        }
        const r = await fetch(`/api/production-orders/${encodeURIComponent(po.id)}?fresh=1`);
        const j = (await r.json().catch(() => ({}))) as { data?: SkipPO };
        if (!r.ok || !j.data) throw new Error(`Could not read ${po.poNo}.`);
        pos.push({ id: j.data.id, jobCards: j.data.jobCards ?? [] });
      }
      const batches: SkipPatch[][] = mode === "complete" ? planCompleteUpTo(pos, upTo, todayYmdMY()) : planReset(pos);
      let done = 0;
      let failed = 0;
      for (const patches of batches) {
        const res = await fetch("/api/production-orders/bulk-patch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patches }),
        });
        const j = (await res.json().catch(() => ({}))) as { results?: Array<{ success: boolean; error?: string }>; error?: string };
        if (!res.ok) throw new Error(j.error ?? `bulk-patch returned ${res.status}`);
        for (const r of j.results ?? []) {
          if (r.success) done++;
          else {
            failed++;
            lines.push(r.error ?? "unknown error");
          }
        }
        // Stop at the first failing wave: later waves would only hit the
        // sequence lock behind it.
        if (failed > 0) break;
      }
      lines.unshift(
        batches.length === 0
          ? "Nothing to change."
          : `${done} job card(s) updated${failed ? `, ${failed} failed` : ""}.`,
      );
    } catch (e) {
      lines.unshift(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setLog(lines);
      setBusy(false);
      invalidateCachePrefix("/api/production-orders");
      invalidateCachePrefix("/api/delivery-orders");
      onChanged();
    }
  };

  return (
    <Card className="border-dashed border-amber-300">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="h-5 w-5 text-amber-700" />
          Staging test tools: skip production stages
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-[#6B7280]">
          {open.length} of {linkedPOs.length} production order(s) can be moved. Orders already on a delivery order are left alone.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="stage-skip-upto" className="text-[#374151]">Complete up to</label>
          <select
            id="stage-skip-upto"
            value={upTo}
            onChange={(e) => setUpTo(e.target.value)}
            disabled={busy}
            className="h-9 rounded-md border border-[#E2DDD8] bg-white px-2"
          >
            {REPAIR_DEPT_CODES.map((d) => (
              <option key={d} value={d}>{REPAIR_DEPT_LABELS[d]}{d === "PACKING" ? " (ready for DO)" : ""}</option>
            ))}
          </select>
          <Button size="sm" onClick={() => run("complete")} disabled={busy || open.length === 0}>
            {busy ? "Working..." : "Complete stages"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => run("reset")} disabled={busy || open.length === 0}>
            Reset stages
          </Button>
        </div>
        {log.length > 0 && (
          <ul className="rounded border border-[#E2DDD8] bg-[#FAF9F7] px-3 py-2 text-xs text-[#374151] space-y-1">
            {log.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
