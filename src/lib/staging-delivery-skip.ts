// Staging-only test tool: carry a sales order past production in one click.
// Never PR this into main.
//
// Creates the DO, dispatches and delivers it, raises the invoice and records
// a full payment, each through the same endpoint an operator's button uses, so
// every cascade fires as normal. The runner re-reads the SO between writes and
// asks nextStep() what to do next, because each write changes what the next
// one should be (delivering a DO usually raises its invoice itself).
//
// EMAIL: there is no opt-out on these paths. PUT /api/delivery-orders/:id
// queues a dispatch notice on the move to LOADED and an invoice notice on the
// move to DELIVERED (fireCustomerNoticeBestEffort in
// routes/delivery-orders/_helpers.ts), and POST /api/invoices queues the
// invoice notice too. They only skip when the notice was already sent or the
// hub and customer have no email on file. The card's confirm text says so.

export type DeliverySkipTarget = "DO" | "DELIVERED" | "INVOICED" | "PAID";
export const DELIVERY_SKIP_TARGETS: DeliverySkipTarget[] = ["DO", "DELIVERED", "INVOICED", "PAID"];

export type DeliverySkipState = {
  customerId: string;
  /** Finished production orders that no live DO holds yet. */
  readyPoIds: string[];
  dos: { id: string; doNo: string; status: string }[];
  invoices: { id: string; invoiceNo: string; status: string; totalSen: number; paidAmount: number }[];
};

export type DeliverySkipStep =
  | { kind: "createDo"; poIds: string[] }
  | { kind: "dispatch" | "deliver" | "invoice"; doId: string; doNo: string }
  | { kind: "pay"; invoiceId: string; invoiceNo: string; amountSen: number };

const rank = (t: DeliverySkipTarget) => DELIVERY_SKIP_TARGETS.indexOf(t);

/** The next write to make, or null when the order has reached the target. */
export function nextStep(s: DeliverySkipState, target: DeliverySkipTarget): DeliverySkipStep | null {
  const r = rank(target);
  if (r < 0) return null;
  if (s.readyPoIds.length > 0) return { kind: "createDo", poIds: s.readyPoIds };
  const live = s.dos.filter((d) => d.status !== "CANCELLED");
  if (r >= rank("DELIVERED")) {
    const draft = live.find((d) => d.status === "DRAFT");
    if (draft) return { kind: "dispatch", doId: draft.id, doNo: draft.doNo };
    const out = live.find((d) => d.status === "LOADED" || d.status === "IN_TRANSIT");
    if (out) return { kind: "deliver", doId: out.id, doNo: out.doNo };
  }
  if (r >= rank("INVOICED")) {
    const unbilled = live.find((d) => d.status === "DELIVERED");
    if (unbilled) return { kind: "invoice", doId: unbilled.id, doNo: unbilled.doNo };
  }
  if (r >= rank("PAID")) {
    const owing = s.invoices.find(
      (i) => i.status !== "CANCELLED" && i.status !== "DRAFT" && i.totalSen - i.paidAmount > 0,
    );
    if (owing) return { kind: "pay", invoiceId: owing.id, invoiceNo: owing.invoiceNo, amountSen: owing.totalSen - owing.paidAmount };
  }
  return null;
}

type SoResponse = {
  data?: { customerId?: string };
  linkedPOs?: { id: string; status: string }[];
  linkedDOs?: DeliverySkipState["dos"];
  linkedInvoices?: DeliverySkipState["invoices"];
};

async function readState(soId: string, f: typeof fetch): Promise<DeliverySkipState> {
  const get = async <T>(url: string): Promise<T> => {
    const r = await f(url, { cache: "no-store" });
    const j = (await r.json().catch(() => ({}))) as T;
    if (!r.ok) throw new Error(`Could not read ${url} (HTTP ${r.status}).`);
    return j;
  };
  const [so, linked] = await Promise.all([
    get<SoResponse>(`/api/sales-orders/${encodeURIComponent(soId)}`),
    // The SO's own per-PO delivery field is first-DO-wins; ask the server
    // which POs a live DO holds, as the stage-skip tool does.
    get<{ poIds?: string[] }>("/api/delivery-orders/linked-po-ids"),
  ]);
  const onLiveDo = new Set(linked.poIds ?? []);
  return {
    customerId: so.data?.customerId ?? "",
    readyPoIds: (so.linkedPOs ?? []).filter((p) => p.status === "COMPLETED" && !onLiveDo.has(p.id)).map((p) => p.id),
    dos: so.linkedDOs ?? [],
    invoices: so.linkedInvoices ?? [],
  };
}

const STAGING_NOTE = "Staging test tool";

/** Walks the order up to `target`, one operator write at a time. Returns the step log. */
export async function runDeliverySkip(
  soId: string,
  target: DeliverySkipTarget,
  today: string,
  f: typeof fetch = fetch,
): Promise<string[]> {
  const log: string[] = [];
  const send = async (url: string, method: string, body: unknown, idem = false) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (idem) headers["Idempotency-Key"] = crypto.randomUUID();
    const r = await f(url, { method, headers, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as { error?: string; ref?: string; data?: { doNo?: string; receiptNumber?: string } };
    if (!r.ok || (j as { success?: boolean }).success === false) {
      throw new Error(`${j.error ?? `HTTP ${r.status}`}${j.ref ? ` (ref ${j.ref})` : ""}`);
    }
    return j.data ?? {};
  };

  let last = "";
  // ponytail: hard cap of 40 writes, raise it if an order ever needs more DOs/invoices than that.
  for (let i = 0; i < 40; i++) {
    let s: DeliverySkipState;
    try {
      s = await readState(soId, f);
    } catch (e) {
      log.push(e instanceof Error ? e.message : String(e));
      return log;
    }
    const step = nextStep(s, target);
    if (!step) {
      log.push(log.length ? "Done." : "Nothing to do: the order is already there.");
      return log;
    }
    // The same step twice means the last write was accepted but did not move
    // the order. Stop instead of looping.
    const key = JSON.stringify(step);
    if (key === last) {
      log.push(`Stopped: ${step.kind} did not change the order. Check it by hand.`);
      return log;
    }
    last = key;
    try {
      if (step.kind === "createDo") {
        const d = await send("/api/delivery-orders", "POST", { productionOrderIds: step.poIds, salesOrderId: soId, deliveryDate: today }, true);
        log.push(`Created delivery order ${d.doNo ?? ""} for ${step.poIds.length} production order(s).`);
      } else if (step.kind === "dispatch") {
        await send(`/api/delivery-orders/${encodeURIComponent(step.doId)}`, "PUT", { status: "LOADED" });
        log.push(`${step.doNo} dispatched.`);
      } else if (step.kind === "deliver") {
        await send(`/api/delivery-orders/${encodeURIComponent(step.doId)}`, "PUT", {
          status: "DELIVERED",
          proofOfDelivery: { receiverName: STAGING_NOTE, remarks: STAGING_NOTE },
        });
        log.push(`${step.doNo} delivered and signed.`);
      } else if (step.kind === "invoice") {
        await send("/api/invoices", "POST", { deliveryOrderId: step.doId, salesOrderId: soId });
        log.push(`Invoice raised for ${step.doNo}.`);
      } else if (step.kind === "pay") {
        const p = await send(
          "/api/payments",
          "POST",
          {
            customerId: s.customerId,
            amount: step.amountSen,
            method: "BANK_TRANSFER",
            reference: STAGING_NOTE,
            date: today,
            allocations: [{ invoiceId: step.invoiceId, amount: step.amountSen }],
          },
          true,
        );
        log.push(`Payment ${p.receiptNumber ?? ""} of RM ${(step.amountSen / 100).toFixed(2)} recorded on ${step.invoiceNo}.`);
      }
    } catch (e) {
      log.push(`${step.kind} failed: ${e instanceof Error ? e.message : String(e)}`);
      return log;
    }
  }
  log.push("Stopped after 40 writes.");
  return log;
}
