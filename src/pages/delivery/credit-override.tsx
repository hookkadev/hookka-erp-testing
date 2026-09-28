// ---------------------------------------------------------------------------
// Customer credit block (BUG-34) — the UI half of src/api/lib/customer-credit.ts.
//
// When DO create / packing-list-first / dispatch answers CREDIT_LIMIT_EXCEEDED
// or PAYMENT_OVERDUE, `askCreditOverride` shows why. If the server said the
// override is allowed (switch on + permission), the dialog takes a reason and
// returns it so the caller re-sends with `creditOverride: { reason }`;
// otherwise it just reports the block. Returns null when nothing should be
// re-sent.
// ---------------------------------------------------------------------------
import type { ConfirmOptions } from "@/components/ui/confirm-dialog";
import { formatCurrency } from "@/lib/utils";

type OverdueRow = { invoiceNo: string; dueDate: string; balanceSen: number };
export type CreditBlockBody = {
  code?: string;
  error?: string;
  overrideAllowed?: boolean;
  details?: {
    overdue?: OverdueRow[];
    overdueSen?: number;
    limit?: number;
    outstanding?: number;
    pendingDo?: number;
    doTotal?: number;
    projected?: number;
  };
};

export function isCreditBlock(body: unknown): body is CreditBlockBody {
  const code = (body as CreditBlockBody | null)?.code;
  return code === "CREDIT_LIMIT_EXCEEDED" || code === "PAYMENT_OVERDUE";
}

export async function askCreditOverride(
  confirm: (o: ConfirmOptions) => Promise<boolean>,
  toast: { error: (msg: string) => void },
  body: CreditBlockBody,
): Promise<string | null> {
  if (!body.overrideAllowed) {
    toast.error(body.error || "Blocked by the customer's credit control.");
    return null;
  }
  const d = body.details ?? {};
  let reason = "";
  const ok = await confirm({
    title:
      body.code === "PAYMENT_OVERDUE" ? "Customer has overdue invoices" : "Credit limit exceeded",
    danger: true,
    confirmLabel: "Override and continue",
    message: (
      <div className="space-y-3">
        <p>{body.error}</p>
        {body.code === "PAYMENT_OVERDUE" ? (
          <ul className="max-h-32 overflow-auto rounded border border-[#E2DDD8] text-xs">
            {(d.overdue ?? []).map((i) => (
              <li key={i.invoiceNo} className="flex justify-between gap-2 px-2 py-1">
                <span>{i.invoiceNo}</span>
                <span>due {i.dueDate}</span>
                <span className="font-medium">{formatCurrency(i.balanceSen)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <dl className="grid grid-cols-2 gap-x-3 text-xs">
            <dt>Credit limit</dt><dd className="text-right">{formatCurrency(d.limit ?? 0)}</dd>
            <dt>Outstanding</dt><dd className="text-right">{formatCurrency(d.outstanding ?? 0)}</dd>
            <dt>Undelivered DOs</dt><dd className="text-right">{formatCurrency(d.pendingDo ?? 0)}</dd>
            <dt>This delivery</dt><dd className="text-right">{formatCurrency(d.doTotal ?? 0)}</dd>
            <dt className="font-semibold">Total</dt><dd className="text-right font-semibold">{formatCurrency(d.projected ?? 0)}</dd>
          </dl>
        )}
        <label className="block text-xs font-medium text-[#1F1D1B]">
          Reason for override (required, recorded in the audit log)
          <textarea
            className="mt-1 w-full rounded border border-[#E2DDD8] p-2 text-sm"
            rows={2}
            onChange={(e) => {
              reason = e.target.value;
            }}
          />
        </label>
      </div>
    ),
  });
  if (!ok) return null;
  if (!reason.trim()) {
    toast.error("A reason is required to override the credit block.");
    return null;
  }
  return reason.trim();
}
