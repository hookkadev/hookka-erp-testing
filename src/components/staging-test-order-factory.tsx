// Staging-only test tool on the Sales Orders list: create a realistic test SO
// in one click through the normal POST /api/sales-orders, and cancel your own
// test SOs from today through the normal status PUT. Renders only on the
// staging host. Staging-only: never PR this into main.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { FlaskConical } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { getCurrentUser } from "@/lib/auth";
import { todayYmdMY } from "@/lib/utils";
import type { Customer } from "@/types";
import {
  buildTestSoPayload,
  checkDownstream,
  filterVoidable,
  testMarker,
  voidOrders,
  type FactoryCustomerProduct,
  type FactoryFabric,
  type FactoryProduct,
  type ListedSo,
} from "@/lib/staging-test-order-factory";

async function getData<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const j = (await r.json().catch(() => ({}))) as { data?: T; error?: string };
  if (!r.ok || j.data === undefined) throw new Error(j.error ?? `Could not load ${url}`);
  return j.data;
}

export function StagingTestOrderFactory({ basePath }: { basePath: string }) {
  const isStaging = window.location.hostname.startsWith("staging.");
  const navigate = useNavigate();
  const { confirm } = useConfirm();
  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [count, setCount] = useState(3);
  const [productId, setProductId] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const { data: customersResp } = useCachedJson<{ data?: Customer[] }>(isStaging && open ? "/api/customers" : null);
  const { data: productsResp } = useCachedJson<{ data?: FactoryProduct[] }>(isStaging && open ? "/api/products" : null);

  if (!isStaging) return null;

  const user = getCurrentUser();
  const marker = user ? testMarker(todayYmdMY(), user.id) : "";
  const customers = (customersResp?.data ?? []).filter((c) => (c.customerStage ?? "CONFIRMED") !== "POTENTIAL");
  const products = (productsResp?.data ?? []).filter((p) => String(p.status).toUpperCase() === "ACTIVE");

  const create = async () => {
    if (!user) return setLog(["You are not signed in."]);
    setBusy(true);
    try {
      const [prods, cps, fabrics] = await Promise.all([
        getData<FactoryProduct[]>("/api/products"),
        getData<FactoryCustomerProduct[]>(`/api/customer-products?customerId=${encodeURIComponent(customerId)}`),
        getData<FactoryFabric[]>("/api/fabric-tracking"),
      ]);
      const body = buildTestSoPayload({
        customerId, count, chosenId: productId || undefined, products: prods, customerProducts: cps, fabrics, marker,
      });
      const res = await fetch("/api/sales-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string; data?: { id?: string } };
      if (!res.ok || !j.success || !j.data?.id) throw new Error(j.error ?? `Create failed (HTTP ${res.status})`);
      invalidateCachePrefix("/api/sales-orders");
      navigate(`${basePath}/${j.data.id}`);
    } catch (e) {
      setLog([e instanceof Error ? e.message : "That did not work."]);
      setBusy(false);
    }
  };

  const cleanup = async () => {
    if (!user) return setLog(["You are not signed in."]);
    setBusy(true);
    const lines: string[] = [];
    try {
      const r = await fetch(`/api/sales-orders?page=1&limit=500&search=${encodeURIComponent(marker)}`);
      const j = (await r.json().catch(() => ({}))) as { data?: ListedSo[]; total?: number; error?: string };
      if (!r.ok || !Array.isArray(j.data)) throw new Error(j.error ?? "Could not list sales orders.");
      if ((j.total ?? 0) > j.data.length) lines.push(`Only the first ${j.data.length} matches were read. Run it again after this.`);
      const plan = await checkDownstream(filterVoidable(j.data, marker, todayYmdMY()));
      const skippedText = plan.skipped.map((s) => `${s.so.companySOId}: skipped, ${s.reason}`);
      lines.push(...skippedText);
      if (plan.toVoid.length === 0) {
        lines.unshift("No test orders of yours from today to cancel.");
        return;
      }
      const ok = await confirm({
        title: "Cancel my test orders from today",
        message: (
          <div className="space-y-2 text-sm">
            <p>These {plan.toVoid.length} sales order(s) will be set to CANCELLED. Staging only.</p>
            <ul className="list-disc pl-5">
              {plan.toVoid.map((so) => <li key={so.id}>{so.companySOId} ({so.customerName}, {so.status})</li>)}
            </ul>
            {skippedText.length > 0 && (
              <>
                <p>Left alone:</p>
                <ul className="list-disc pl-5">{skippedText.map((t) => <li key={t}>{t}</li>)}</ul>
              </>
            )}
          </div>
        ),
        danger: true,
        confirmLabel: "Cancel these orders",
        cancelLabel: "Keep them",
      });
      if (!ok) {
        lines.unshift("Nothing changed.");
        return;
      }
      const res = await voidOrders(plan.toVoid, user.displayName || user.email || user.id);
      lines.unshift(`${res.done} test order(s) cancelled${res.errors.length ? `, ${res.errors.length} failed` : ""}.`, ...res.errors);
    } catch (e) {
      lines.unshift(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setLog(lines);
      setBusy(false);
      invalidateCachePrefix("/api/sales-orders");
      invalidateCachePrefix("/api/production-orders");
    }
  };

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        <FlaskConical className="h-4 w-4" /> New test SO
      </Button>
    );
  }

  return (
    <Card className="w-full border-dashed border-amber-300">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="h-5 w-5 text-amber-700" />
          Staging test tools: test order factory
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-[#6B7280]">
          Creates a DRAFT sales order tagged <code>{marker || "(sign in)"}</code> in Reference, priced the way the create page prices it, then opens it.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-64">
            <SearchableSelect
              value={customerId}
              onChange={setCustomerId}
              options={customers.map((c) => ({ value: c.id, label: c.name }))}
              placeholder="Customer..."
            />
          </div>
          <label htmlFor="tof-count" className="text-[#374151]">Lines</label>
          <input
            id="tof-count"
            type="number"
            min={1}
            max={10}
            value={count}
            onChange={(e) => setCount(Math.min(10, Math.max(1, Number(e.target.value) || 1)))}
            className="h-9 w-16 rounded-md border border-[#E2DDD8] bg-white px-2"
          />
          <div className="w-64">
            <SearchableSelect
              value={productId}
              onChange={setProductId}
              options={[{ value: "", label: "Random products" }, ...products.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` }))]}
              placeholder="Random products"
            />
          </div>
          <Button size="sm" onClick={create} disabled={busy || !customerId}>
            {busy ? "Working..." : "Create test SO"}
          </Button>
          <Button size="sm" variant="outline" onClick={cleanup} disabled={busy}>
            Void my test docs from today
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Close
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
