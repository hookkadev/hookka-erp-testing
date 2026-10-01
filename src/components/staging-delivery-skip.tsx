// Staging-only test tool on the SO detail page: after production is done,
// create the DO, deliver it, invoice it and pay it in one click, through the
// normal operator endpoints. Renders only on the staging host.
// Staging-only: never PR this into main.
import { useState } from "react";
import { FlaskConical } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { invalidateCachePrefix } from "@/lib/cached-fetch";
import { todayYmdMY } from "@/lib/utils";
import { DELIVERY_SKIP_TARGETS, runDeliverySkip, type DeliverySkipTarget } from "@/lib/staging-delivery-skip";

const LABELS: Record<DeliverySkipTarget, string> = {
  DO: "Delivery order (draft)",
  DELIVERED: "Delivered (also raises the invoice)",
  INVOICED: "Invoiced",
  PAID: "Paid in full",
};

export function StagingDeliverySkipCard({ soId, onChanged }: { soId: string; onChanged: () => void }) {
  const { confirm } = useConfirm();
  const [upTo, setUpTo] = useState<DeliverySkipTarget>("PAID");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  if (!window.location.hostname.startsWith("staging.")) return null;

  const run = async () => {
    const ok = await confirm({
      title: `Go up to: ${LABELS[upTo]}`,
      message:
        `Create a DO for every finished production order not on a live DO, then take every live DO and invoice of this order up to "${LABELS[upTo]}". Staging only.` +
        (upTo === "DO"
          ? ""
          : " This sends real email: dispatching and delivering a DO queue the dispatch and invoice notices to the hub or customer email on file. There is no opt-out on that path, and staging holds real customer addresses."),
      danger: upTo !== "DO",
    });
    if (!ok) return;
    setBusy(true);
    try {
      setLog(await runDeliverySkip(soId, upTo, todayYmdMY()));
    } catch (e) {
      setLog([e instanceof Error ? e.message : "That did not work."]);
    } finally {
      setBusy(false);
      for (const p of ["/api/delivery-orders", "/api/production-orders", "/api/invoices", "/api/payments", "/api/sales-orders", "/api/customers"]) {
        invalidateCachePrefix(p);
      }
      onChanged();
    }
  };

  return (
    <Card className="border-dashed border-amber-300">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="h-5 w-5 text-amber-700" />
          Staging test tools: delivery and billing skip
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-[#6B7280]">
          For an order whose production is done. Each step uses the normal operator endpoint, so every cascade fires.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="delivery-skip-upto" className="text-[#374151]">Go up to</label>
          <select
            id="delivery-skip-upto"
            value={upTo}
            onChange={(e) => setUpTo(e.target.value as DeliverySkipTarget)}
            disabled={busy}
            className="h-9 rounded-md border border-[#E2DDD8] bg-white px-2"
          >
            {DELIVERY_SKIP_TARGETS.map((t) => (
              <option key={t} value={t}>{LABELS[t]}</option>
            ))}
          </select>
          <Button size="sm" onClick={run} disabled={busy}>
            {busy ? "Working..." : "Run"}
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
