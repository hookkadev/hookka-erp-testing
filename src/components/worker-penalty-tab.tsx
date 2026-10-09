// ---------------------------------------------------------------------------
// worker-penalty-tab.tsx — Employees > Worker Penalty (DEV-22).
//
// One screen for the whole life of a penalty: raise it against a production
// order (the order's details are pulled from Production, and whoever worked
// each department is offered as a suggested responsible worker), name one or
// more workers with an amount each, attach photos, submit, approve. Once
// approved it is deducted on the Payroll tab in its payroll month; approving
// that month's payroll marks it POSTED.
//
// Kept out of employees.tsx on purpose — that file is past 11k lines.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Plus, Search, X, Pencil, Trash2, Send, Check, Undo2, ImagePlus } from "lucide-react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { usePermissions } from "@/lib/use-permission";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { DocumentDetailDrawer } from "@/components/ui/document-detail-drawer";
import { ResourceDocuments } from "@/components/resource-documents";
import { formatCurrency, roundSen, todayYmdMY } from "@/lib/utils";
import { useDebounced } from "@/pages/m/lib/use-debounced";

export type PenaltyWorker = {
  id: string;
  empNo: string;
  name: string;
  departmentCode?: string | null;
  status?: string;
};

type PenaltyLine = {
  id: string;
  workerId: string;
  empNo: string;
  workerName: string;
  departmentCode: string;
  amountSen: number;
  payrollPeriod: string;
  payslipId: string;
  postedAt: string;
};

type Penalty = {
  id: string;
  penaltyNo: string;
  penaltyDate: string;
  productionOrderId: string;
  poNo: string;
  salesOrderNo: string;
  customerName: string;
  productCode: string;
  productName: string;
  quantity: number | null;
  reason: string;
  remarks: string;
  status: string;
  createdBy: string;
  createdByName: string;
  submittedAt: string;
  approvedByName: string;
  approvedAt: string;
  rejectedReason: string;
  createdAt: string;
  lines: PenaltyLine[];
  totalSen: number;
};

type OrderHit = {
  id: string;
  poNo: string;
  salesOrderNo: string;
  customerName: string;
  productCode: string;
  productName: string;
  quantity: number;
  sizeLabel: string;
  fabricCode: string;
  status: string;
  currentDepartment: string;
};

type OrderDetail = {
  order: OrderHit & { itemCategory: string; specialOrder: string; notes: string; completedDate: string };
  jobCards: Array<{
    id: string;
    departmentCode: string;
    departmentName: string;
    wipLabel: string;
    status: string;
    pic1Id: string;
    pic1Name: string;
    pic2Id: string;
    pic2Name: string;
  }>;
  suggestedWorkers: Array<{ workerId: string; name: string; departments: string[] }>;
};

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "DRAFT", label: "Draft" },
  { value: "PENDING_APPROVAL", label: "Pending Approval" },
  { value: "APPROVED", label: "Approved" },
  { value: "POSTED", label: "Posted" },
];

const STATUS_STYLE: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-700",
  PENDING_APPROVAL: "bg-[#FBF1DC] text-[#9C6F1E]",
  APPROVED: "bg-[#E0EDF0] text-[#3E6570]",
  POSTED: "bg-[#EEF3E4] text-[#4F7C3A]",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function periodLabel(p: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(p);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : p || "-";
}
function dmy(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ymd || "-";
}
function dateTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString("en-MY", { dateStyle: "medium", timeStyle: "short" });
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap ${STATUS_STYLE[status] ?? "bg-gray-100 text-gray-700"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

async function sendJson(url: string, method: string, body?: unknown): Promise<{ ok: boolean; data: { success?: boolean; error?: string; data?: Penalty; payrollPeriod?: string } }> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string; data?: Penalty };
  if (!res.ok && !data.error) data.error = `HTTP ${res.status}`;
  return { ok: res.ok, data };
}

// ===========================================================================
export function WorkerPenaltyTab({ workers }: { workers: PenaltyWorker[] }) {
  const { hasPermission } = usePermissions();
  const canCreate = hasPermission("worker-penalties", "create");
  const canApprove = hasPermission("worker-penalties", "approve");

  const [status, setStatus] = useState("");
  const [qInput, setQInput] = useState("");
  const q = useDebounced(qInput.trim(), 300);

  const listUrl = `/api/worker-penalties?status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}`;
  const { data: resp, loading, refresh } = useCachedJson<{ data?: Penalty[]; counts?: Record<string, number> }>(listUrl);
  const penalties = useMemo(() => resp?.data ?? [], [resp]);
  const counts = resp?.counts ?? {};
  const allCount = Object.values(counts).reduce((s, n) => s + n, 0);

  const reload = useCallback(() => {
    invalidateCachePrefix("/api/worker-penalties");
    // An approval or revoke changes what Payroll deducts.
    invalidateCachePrefix("/api/payslips");
    refresh();
  }, [refresh]);

  const [editing, setEditing] = useState<Penalty | "new" | null>(null);
  // The drawer holds its own copy: an action can move a penalty out of the
  // filtered list (Submit while filtering on Draft) and the drawer must stay.
  const [opened, setOpened] = useState<Penalty | null>(null);

  const pendingSen = penalties.filter((p) => p.status === "PENDING_APPROVAL").reduce((s, p) => s + p.totalSen, 0);
  const awaitingPayrollSen = penalties.filter((p) => p.status === "APPROVED").reduce((s, p) => s + p.totalSen, 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280] uppercase tracking-wide">Pending Approval</p>
            <p className="text-xl font-bold text-[#9C6F1E] mt-1">{counts.PENDING_APPROVAL ?? 0}</p>
            <p className="text-[10px] text-[#9CA3AF] mt-0.5">{formatCurrency(pendingSen)} in the list below</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280] uppercase tracking-wide">Approved, Awaiting Payroll</p>
            <p className="text-xl font-bold text-[#3E6570] mt-1">{counts.APPROVED ?? 0}</p>
            <p className="text-[10px] text-[#9CA3AF] mt-0.5">{formatCurrency(awaitingPayrollSen)} deducted when its payroll month is approved</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280] uppercase tracking-wide">Posted</p>
            <p className="text-xl font-bold text-[#4F7C3A] mt-1">{counts.POSTED ?? 0}</p>
            <p className="text-[10px] text-[#9CA3AF] mt-0.5">Deducted on an approved payslip</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-[#6B5C32]" /> Worker Penalty
            </CardTitle>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9CA3AF]" />
                <Input
                  value={qInput}
                  onChange={(e) => setQInput(e.target.value)}
                  placeholder="Penalty no., order, customer, worker..."
                  className="h-10 w-[280px] pl-8"
                />
              </div>
              {canCreate && (
                <Button variant="primary" onClick={() => setEditing("new")}>
                  <Plus className="h-4 w-4" /> New Penalty
                </Button>
              )}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {STATUS_FILTERS.map((f) => {
              const n = f.value ? counts[f.value] ?? 0 : allCount;
              const active = status === f.value;
              return (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setStatus(f.value)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium ${active ? "border-[#6B5C32] bg-[#6B5C32] text-white" : "border-[#E2DDD8] bg-white text-[#374151] hover:bg-[#FAF9F7]"}`}
                >
                  {f.label} <span className={active ? "text-white/80" : "text-[#9CA3AF]"}>{n}</span>
                </button>
              );
            })}
          </div>
        </CardHeader>
        <CardContent>
          {loading && penalties.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-[#6B7280]">Loading penalties...</div>
          ) : penalties.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-[#6B7280]">
              <p>No penalties{status ? ` with status ${status.replace(/_/g, " ").toLowerCase()}` : ""}{q ? ` matching "${q}"` : ""}.</p>
            </div>
          ) : (
            <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
              <table className="w-full min-w-max text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                    <th className="h-10 px-3 text-left font-medium text-[#374151] whitespace-nowrap">Penalty No.</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151] whitespace-nowrap">Date</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151] whitespace-nowrap">Order No.</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151] whitespace-nowrap">Customer</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151] whitespace-nowrap">Reason</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151] whitespace-nowrap">Workers</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151] whitespace-nowrap">Amount</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151] whitespace-nowrap" title="The payroll month the deduction belongs to — set when the penalty is approved">Payroll Month</th>
                    <th className="h-10 px-2 text-center font-medium text-[#374151] whitespace-nowrap">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {penalties.map((p) => {
                    const periods = [...new Set(p.lines.map((l) => l.payrollPeriod).filter(Boolean))];
                    return (
                      <tr
                        key={p.id}
                        onClick={() => setOpened(p)}
                        className="cursor-pointer border-b border-[#E2DDD8] hover:bg-[#FAF9F7] transition-colors"
                      >
                        <td className="h-11 px-3 whitespace-nowrap font-medium text-[#6B5C32]">{p.penaltyNo}</td>
                        <td className="h-11 px-3 whitespace-nowrap">{dmy(p.penaltyDate)}</td>
                        <td className="h-11 px-3 whitespace-nowrap">{p.poNo || "-"}</td>
                        <td className="h-11 px-3 max-w-[180px] truncate" title={p.customerName}>{p.customerName || "-"}</td>
                        <td className="h-11 px-3 max-w-[240px] truncate text-[#6B7280]" title={p.reason}>{p.reason}</td>
                        <td className="h-11 px-3 max-w-[220px] truncate" title={p.lines.map((l) => l.workerName).join(", ")}>
                          {p.lines.map((l) => l.workerName).join(", ") || "-"}
                        </td>
                        <td className="h-11 px-3 text-right whitespace-nowrap tabular-nums font-semibold text-[#9A3A2D]">{formatCurrency(p.totalSen)}</td>
                        <td className="h-11 px-3 whitespace-nowrap">{periods.length ? periods.map(periodLabel).join(", ") : "-"}</td>
                        <td className="h-11 px-2 text-center"><StatusPill status={p.status} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-[11px] text-[#9CA3AF]">
            An approved penalty is deducted in the payroll month of its approval date (the next open month if that one is already approved),
            after EPF / SOCSO / EIS / PCB. Payslips already generated for that month need a &ldquo;Regenerate&rdquo; on the Payroll tab.
          </p>
        </CardContent>
      </Card>

      {opened && (
        <PenaltyDetail
          penalty={opened}
          canApprove={canApprove}
          canEdit={canCreate}
          onClose={() => setOpened(null)}
          onEdit={() => {
            setEditing(opened);
            setOpened(null);
          }}
          onChanged={(next) => {
            reload();
            if (next) setOpened(next);
          }}
        />
      )}
      {editing && (
        <PenaltyEditor
          initial={editing === "new" ? null : editing}
          workers={workers}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            setEditing(null);
            reload();
            setOpened(p);
          }}
        />
      )}
    </div>
  );
}

// ===========================================================================
// Detail drawer — read view + the status actions.
// ===========================================================================
function PenaltyDetail({
  penalty: p,
  canApprove,
  canEdit,
  onClose,
  onEdit,
  onChanged,
}: {
  penalty: Penalty;
  canApprove: boolean;
  canEdit: boolean;
  onClose: () => void;
  onEdit: () => void;
  onChanged: (next?: Penalty) => void;
}) {
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const act = async (path: string, body?: unknown, okMsg?: string) => {
    setBusy(true);
    const { ok, data } = await sendJson(`/api/worker-penalties/${p.id}${path}`, path ? "POST" : "DELETE", body);
    setBusy(false);
    if (!ok) {
      toast.error(data.error || "Action failed");
      return false;
    }
    if (okMsg) toast.success(okMsg);
    onChanged(data.data);
    return true;
  };

  const anyPosted = p.lines.some((l) => l.postedAt);
  const isDraft = p.status === "DRAFT";
  const isPending = p.status === "PENDING_APPROVAL";
  const isApproved = p.status === "APPROVED";

  const footer = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {rejecting ? (
        <>
          <Input
            autoFocus
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Why is it rejected? (goes back to the raiser as a draft)"
            className="h-10 min-w-[320px] flex-1"
          />
          <Button variant="outline" onClick={() => setRejecting(false)} disabled={busy}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              if (await act("/reject", { reason: rejectReason }, "Penalty rejected — back to draft.")) setRejecting(false);
            }}
          >
            Confirm Reject
          </Button>
        </>
      ) : (
        <>
          {isDraft && canEdit && (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  if (
                    await confirm({
                      title: `Delete ${p.penaltyNo}?`,
                      message: "The draft and its worker lines are removed. Photos stay in file storage.",
                      confirmLabel: "Delete",
                      tone: "danger",
                    })
                  ) {
                    if (await act("", undefined, "Draft deleted.")) onClose();
                  }
                }}
              >
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
              <Button variant="outline" disabled={busy} onClick={onEdit}>
                <Pencil className="h-4 w-4" /> Edit
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => act("/submit", undefined, "Submitted for approval.")}>
                <Send className="h-4 w-4" /> Submit for Approval
              </Button>
            </>
          )}
          {isPending && canApprove && (
            <>
              <Button variant="outline" disabled={busy} onClick={() => setRejecting(true)}>
                <X className="h-4 w-4" /> Reject
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={async () => {
                  if (
                    await confirm({
                      title: `Approve ${p.penaltyNo}?`,
                      message: `${formatCurrency(p.totalSen)} across ${p.lines.length} worker${p.lines.length === 1 ? "" : "s"} will be deducted from pay in this payroll month (or the next open one).`,
                      confirmLabel: "Approve",
                    })
                  ) {
                    await act("/approve", undefined, "Penalty approved.");
                  }
                }}
              >
                <Check className="h-4 w-4" /> Approve
              </Button>
            </>
          )}
          {isApproved && canApprove && !anyPosted && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                if (
                  await confirm({
                    title: `Revoke approval of ${p.penaltyNo}?`,
                    message: "It goes back to draft and comes off the payroll month. Regenerate that month's payslips if they were already generated.",
                    confirmLabel: "Revoke",
                    tone: "danger",
                  })
                ) {
                  await act("/revoke", undefined, "Approval revoked.");
                }
              }}
            >
              <Undo2 className="h-4 w-4" /> Revoke Approval
            </Button>
          )}
        </>
      )}
    </div>
  );

  return (
    <DocumentDetailDrawer
      docNo={p.penaltyNo}
      docType="Worker Penalty"
      status={<StatusPill status={p.status} />}
      onClose={onClose}
      footer={footer}
    >
      {confirmDialog}
      {/* Same body padding as the Delivery Order drawer. */}
      <div className="px-6 py-5 space-y-5 max-md:px-4 max-sm:px-3">
        {p.rejectedReason && isDraft && (
          <div className="rounded-md border border-[#E8C9C3] bg-[#FBEFEC] px-3 py-2 text-xs text-[#9A3A2D]">
            <span className="font-semibold">Rejected:</span> {p.rejectedReason}
          </div>
        )}

        <section className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-4">
          <Field label="Date" value={dmy(p.penaltyDate)} />
          <Field label="Production Order" value={p.poNo || "-"} />
          <Field label="Sales Order" value={p.salesOrderNo || "-"} />
          <Field label="Customer" value={p.customerName || "-"} />
          <Field label="Product" value={[p.productCode, p.productName].filter(Boolean).join(" · ") || "-"} wide />
          <Field label="Quantity" value={p.quantity === null ? "-" : String(p.quantity)} />
          <Field label="Total Penalty" value={formatCurrency(p.totalSen)} />
          <Field label="Reason for Penalty" value={p.reason} wide full />
          {p.remarks && <Field label="Remarks" value={p.remarks} wide full />}
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#6B5C32]">Responsible Workers</h3>
          <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                  <th className="h-9 px-3 text-left font-medium text-[#374151]">Worker</th>
                  <th className="h-9 px-3 text-left font-medium text-[#374151]">Department</th>
                  <th className="h-9 px-3 text-right font-medium text-[#374151]">Penalty Amount</th>
                  <th className="h-9 px-3 text-left font-medium text-[#374151]">Payroll Month</th>
                  <th className="h-9 px-3 text-left font-medium text-[#374151]">Payroll Deduction</th>
                </tr>
              </thead>
              <tbody>
                {p.lines.map((l) => (
                  <tr key={l.id} className="border-b border-[#E2DDD8] last:border-b-0">
                    <td className="h-10 px-3">
                      <div className="font-medium text-[#1F1D1B]">{l.workerName}</div>
                      <div className="text-[10px] text-[#9CA3AF]">{l.empNo}</div>
                    </td>
                    <td className="h-10 px-3 text-[#6B7280]">{l.departmentCode.replace(/_/g, " ") || "-"}</td>
                    <td className="h-10 px-3 text-right tabular-nums font-semibold text-[#9A3A2D]">{formatCurrency(l.amountSen)}</td>
                    <td className="h-10 px-3">{l.payrollPeriod ? periodLabel(l.payrollPeriod) : "-"}</td>
                    <td className="h-10 px-3 text-xs">
                      {l.postedAt ? (
                        <span className="text-[#4F7C3A]">Deducted on {l.payslipId}</span>
                      ) : l.payslipId ? (
                        <span className="text-[#3E6570]">On draft payslip {l.payslipId}</span>
                      ) : l.payrollPeriod ? (
                        <span className="text-[#9C6F1E]">Scheduled</span>
                      ) : (
                        <span className="text-[#9CA3AF]">After approval</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <ResourceDocuments
          resourceType="worker-penalty"
          resourceId={p.id}
          title="Photos"
          hint="Evidence of the mistake — the damaged piece, the wrong label, the QC finding."
          photosOnly
          emptyText="No photos yet."
        />

        <section className="text-xs text-[#6B7280] space-y-1">
          <p>Raised by {p.createdByName || "-"} on {dateTime(p.createdAt)}</p>
          {p.submittedAt && <p>Submitted {dateTime(p.submittedAt)}</p>}
          {p.approvedAt && <p>Approved by {p.approvedByName || "-"} on {dateTime(p.approvedAt)}</p>}
        </section>
      </div>
    </DocumentDetailDrawer>
  );
}

function Field({ label, value, wide, full }: { label: string; value: string; wide?: boolean; full?: boolean }) {
  return (
    <div className={full ? "col-span-2 md:col-span-4" : wide ? "col-span-2" : ""}>
      <div className="text-[11px] uppercase tracking-wide text-[#9CA3AF]">{label}</div>
      <div className="mt-0.5 whitespace-pre-wrap text-[#1F1D1B]">{value}</div>
    </div>
  );
}

// ===========================================================================
// Editor — create or edit a DRAFT.
// ===========================================================================
type DraftLine = { workerId: string; amountRM: number | null };

/**
 * Upload photos picked before the penalty existed, now that it has an id.
 * Same /api/files store and PHOTO__ prefix ResourceDocuments uses, so they
 * show up in the detail drawer exactly like ones uploaded there. Returns the
 * names that failed, with the reason.
 */
async function uploadPenaltyPhotos(penaltyId: string, files: File[]): Promise<string[]> {
  const failed: string[] = [];
  for (const file of files) {
    const fd = new FormData();
    fd.append("file", new File([file], `PHOTO__${file.name}`, { type: file.type }));
    fd.append("resourceType", "worker-penalty");
    fd.append("resourceId", penaltyId);
    try {
      const res = await fetch("/api/files", { method: "POST", body: fd });
      const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (!res.ok || !j?.success) failed.push(`${file.name}: ${j?.error || `HTTP ${res.status}`}`);
    } catch {
      failed.push(`${file.name}: network error`);
    }
  }
  return failed;
}

function PenaltyEditor({
  initial,
  workers,
  onClose,
  onSaved,
}: {
  initial: Penalty | null;
  workers: PenaltyWorker[];
  onClose: () => void;
  onSaved: (p: Penalty) => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [penaltyDate, setPenaltyDate] = useState(initial?.penaltyDate || todayYmdMY());
  const [reason, setReason] = useState(initial?.reason ?? "");
  const [remarks, setRemarks] = useState(initial?.remarks ?? "");
  const [manualPoNo, setManualPoNo] = useState(initial && !initial.productionOrderId ? initial.poNo : "");
  const [manualCustomer, setManualCustomer] = useState(initial && !initial.productionOrderId ? initial.customerName : "");
  const [lines, setLines] = useState<DraftLine[]>(
    () => initial?.lines.map((l) => ({ workerId: l.workerId, amountRM: l.amountSen / 100 })) ?? [],
  );

  // ---- production order -------------------------------------------------
  const [orderId, setOrderId] = useState(initial?.productionOrderId ?? "");
  const [orderQueryInput, setOrderQueryInput] = useState("");
  const orderQuery = useDebounced(orderQueryInput.trim(), 300);
  const { data: hitsResp, loading: hitsLoading } = useCachedJson<{ data?: OrderHit[] }>(
    !orderId && orderQuery ? `/api/worker-penalties/order-lookup?q=${encodeURIComponent(orderQuery)}` : null,
    60,
  );
  const hits = hitsResp?.data ?? [];
  const { data: detailResp } = useCachedJson<{ data?: OrderDetail }>(
    orderId ? `/api/worker-penalties/order-lookup/${encodeURIComponent(orderId)}` : null,
    60,
  );
  const order = detailResp?.data ?? null;

  // ---- workers ------------------------------------------------------------
  const workerById = useMemo(() => new Map(workers.map((w) => [w.id, w] as const)), [workers]);
  const [pickerQuery, setPickerQuery] = useState("");
  const pickable = useMemo(() => {
    const qq = pickerQuery.trim().toLowerCase();
    const taken = new Set(lines.map((l) => l.workerId));
    return workers
      .filter((w) => w.status !== "RESIGNED" && !w.empNo?.startsWith("TEST") && !taken.has(w.id))
      .filter((w) => !qq || `${w.empNo} ${w.name} ${w.departmentCode ?? ""}`.toLowerCase().includes(qq))
      .sort((a, b) => (a.empNo || "").localeCompare(b.empNo || ""))
      .slice(0, 30);
  }, [workers, lines, pickerQuery]);
  const addWorker = (id: string) =>
    setLines((prev) => (prev.some((l) => l.workerId === id) ? prev : [...prev, { workerId: id, amountRM: null }]));

  const totalSen = lines.reduce((s, l) => s + (l.amountRM === null ? 0 : roundSen(l.amountRM * 100)), 0);

  // ---- photos picked on a NEW penalty (uploaded once it has an id) ---------
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [pendingPhotos, setPendingPhotos] = useState<File[]>([]);
  const previews = useMemo(
    () => pendingPhotos.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [pendingPhotos],
  );
  useEffect(() => () => previews.forEach((p) => URL.revokeObjectURL(p.url)), [previews]);
  const pickPhotos = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (photoInputRef.current) photoInputRef.current.value = "";
    if (picked.length) setPendingPhotos((prev) => [...prev, ...picked]);
  };

  const save = async (submit: boolean) => {
    const payloadLines = lines.map((l) => ({
      workerId: l.workerId,
      amountSen: l.amountRM === null ? 0 : roundSen(l.amountRM * 100),
    }));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(penaltyDate)) return toast.error("Pick the date.");
    if (!reason.trim()) return toast.error("Enter the reason for the penalty.");
    if (payloadLines.length === 0) return toast.error("Select at least one responsible worker.");
    if (payloadLines.some((l) => l.amountSen <= 0)) return toast.error("Every worker needs a penalty amount above zero.");
    setSaving(true);
    const body = {
      penaltyDate,
      productionOrderId: orderId || undefined,
      poNo: orderId ? undefined : manualPoNo,
      customerName: orderId ? undefined : manualCustomer,
      reason,
      remarks,
      lines: payloadLines,
      submit: initial ? undefined : submit,
    };
    let result = initial
      ? await sendJson(`/api/worker-penalties/${initial.id}`, "PUT", body)
      : await sendJson("/api/worker-penalties", "POST", body);
    if (result.ok && initial && submit) {
      result = await sendJson(`/api/worker-penalties/${initial.id}/submit`, "POST");
    }
    if (!result.ok || !result.data.data) {
      setSaving(false);
      toast.error(result.data.error || "Could not save the penalty.");
      return;
    }
    const saved = result.data.data;
    // The penalty is saved either way; a photo that fails is reported by name
    // and can be re-uploaded from the detail drawer.
    const failedPhotos = pendingPhotos.length ? await uploadPenaltyPhotos(saved.id, pendingPhotos) : [];
    setSaving(false);
    toast.success(submit ? "Penalty submitted for approval." : "Draft saved.");
    for (const f of failedPhotos) toast.error(`Photo not uploaded: ${f}`);
    onSaved(saved);
  };

  return (
    <DocumentDetailDrawer
      docNo={initial ? initial.penaltyNo : "New Worker Penalty"}
      docType={initial ? "Edit draft" : "Draft"}
      onClose={onClose}
      onScrimClick={() => undefined}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-[#6B7280]">
            {lines.length} worker{lines.length === 1 ? "" : "s"} · <span className="font-semibold text-[#1F1D1B] tabular-nums">{formatCurrency(totalSen)}</span>
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button variant="outline" onClick={() => save(false)} disabled={saving}>Save Draft</Button>
            <Button variant="primary" onClick={() => save(true)} disabled={saving}>
              <Send className="h-4 w-4" /> {saving ? "Saving..." : "Save & Submit"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="px-6 py-5 space-y-6 max-md:px-4 max-sm:px-3">
        {/* 1. The order */}
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#6B5C32]">1. Production Order</h3>
          {orderId ? (
            <div className="rounded-lg border border-[#E2DDD8] bg-[#FAF9F7] p-3">
              {order ? (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold text-[#1F1D1B]">{order.order.poNo}</div>
                      <div className="text-xs text-[#6B7280]">
                        {order.order.salesOrderNo && `${order.order.salesOrderNo} · `}{order.order.customerName}
                      </div>
                    </div>
                    <button type="button" onClick={() => setOrderId("")} className="text-xs text-[#9A3A2D] hover:underline">
                      Change order
                    </button>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
                    <Field label="Product" value={[order.order.productCode, order.order.productName].filter(Boolean).join(" · ") || "-"} wide />
                    <Field label="Quantity" value={String(order.order.quantity)} />
                    <Field label="Status" value={order.order.status.replace(/_/g, " ")} />
                    {order.order.sizeLabel && <Field label="Size" value={order.order.sizeLabel} />}
                    {order.order.fabricCode && <Field label="Fabric" value={order.order.fabricCode} />}
                    {order.order.specialOrder && <Field label="Special Order" value={order.order.specialOrder} wide />}
                  </div>
                  {order.jobCards.length > 0 && (
                    <div className="mt-3">
                      <div className="text-[11px] uppercase tracking-wide text-[#9CA3AF]">Who worked each department</div>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {order.jobCards.map((j) => (
                          <span key={j.id} className="rounded border border-[#E2DDD8] bg-white px-2 py-0.5 text-[11px] text-[#374151]">
                            <span className="font-semibold">{j.departmentCode.replace(/_/g, " ")}</span>
                            {j.wipLabel ? ` (${j.wipLabel})` : ""}: {[j.pic1Name, j.pic2Name].filter(Boolean).join(", ") || "-"}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="text-sm text-[#6B7280]">Loading order...</div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9CA3AF]" />
                <Input
                  value={orderQueryInput}
                  onChange={(e) => setOrderQueryInput(e.target.value)}
                  placeholder="Search production order no., SO no., customer or product"
                  className="h-10 pl-8"
                />
              </div>
              {orderQuery && (
                <div className="max-h-64 overflow-y-auto rounded-md border border-[#E2DDD8]">
                  {hitsLoading && hits.length === 0 ? (
                    <p className="px-3 py-3 text-sm text-[#9CA3AF]">Searching...</p>
                  ) : hits.length === 0 ? (
                    <p className="px-3 py-3 text-sm text-[#9CA3AF]">No production order matches that.</p>
                  ) : (
                    hits.map((h) => (
                      <button
                        key={h.id}
                        type="button"
                        onClick={() => {
                          setOrderId(h.id);
                          setOrderQueryInput("");
                        }}
                        className="flex w-full items-center justify-between gap-3 border-b border-[#F0ECE9] px-3 py-2 text-left text-sm last:border-b-0 hover:bg-[#FAF9F7]"
                      >
                        <span className="min-w-0">
                          <span className="font-medium text-[#1F1D1B]">{h.poNo}</span>
                          <span className="ml-2 text-xs text-[#6B7280]">{h.customerName}</span>
                          <span className="block truncate text-xs text-[#9CA3AF]">
                            {[h.productCode, h.productName].filter(Boolean).join(" · ")} · Qty {h.quantity}
                          </span>
                        </span>
                        <span className="shrink-0 text-[10px] text-[#9CA3AF]">{h.status.replace(/_/g, " ")}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
              <p className="text-[11px] text-[#9CA3AF]">Not tied to one production order? Leave the search empty and type the reference instead.</p>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <Input value={manualPoNo} onChange={(e) => setManualPoNo(e.target.value)} placeholder="Order / reference no. (optional)" className="h-10" />
                <Input value={manualCustomer} onChange={(e) => setManualCustomer(e.target.value)} placeholder="Customer (optional)" className="h-10" />
              </div>
            </div>
          )}
        </section>

        {/* 2. What happened */}
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[#6B5C32]">2. Penalty Details</h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <label className="text-sm">
              <span className="text-[11px] uppercase tracking-wide text-[#9CA3AF]">Date</span>
              <Input type="date" value={penaltyDate} onChange={(e) => setPenaltyDate(e.target.value)} className="mt-1 h-10" />
            </label>
            <label className="text-sm md:col-span-3">
              <span className="text-[11px] uppercase tracking-wide text-[#9CA3AF]">Reason for Penalty</span>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Wrong fabric cut for this order" className="mt-1 h-10" />
            </label>
          </div>
          <label className="block text-sm">
            <span className="text-[11px] uppercase tracking-wide text-[#9CA3AF]">Remarks</span>
            <textarea
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
            />
          </label>
        </section>

        {/* 3. Who, and how much */}
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[#6B5C32]">3. Responsible Workers</h3>
          {order && order.suggestedWorkers.length > 0 && (
            <div>
              <div className="text-[11px] text-[#9CA3AF]">Suggested from the order&rsquo;s job cards — click to add</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {order.suggestedWorkers.map((s) => {
                  const added = lines.some((l) => l.workerId === s.workerId);
                  const known = workerById.has(s.workerId);
                  return (
                    <button
                      key={s.workerId}
                      type="button"
                      disabled={added || !known}
                      onClick={() => addWorker(s.workerId)}
                      title={known ? undefined : "Not in the employee master"}
                      className="rounded-full border border-[#E2DDD8] bg-white px-2.5 py-1 text-xs text-[#374151] hover:bg-[#FAF9F7] disabled:opacity-40"
                    >
                      {added ? "Added: " : "+ "}{s.name} <span className="text-[#9CA3AF]">{s.departments.join(", ").replace(/_/g, " ")}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9CA3AF]" />
            <Input
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
              placeholder="Add a worker from the employee master — type a name or employee no."
              className="h-10 pl-8"
            />
          </div>
          {pickerQuery.trim() && (
            <div className="max-h-56 overflow-y-auto rounded-md border border-[#E2DDD8]">
              {pickable.length === 0 ? (
                <p className="px-3 py-3 text-sm text-[#9CA3AF]">No employee matches that.</p>
              ) : (
                pickable.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => {
                      addWorker(w.id);
                      setPickerQuery("");
                    }}
                    className="flex w-full items-center justify-between border-b border-[#F0ECE9] px-3 py-2 text-left text-sm last:border-b-0 hover:bg-[#FAF9F7]"
                  >
                    <span>{w.empNo} — {w.name}</span>
                    <span className="text-xs text-[#9CA3AF]">{(w.departmentCode ?? "").replace(/_/g, " ")}</span>
                  </button>
                ))
              )}
            </div>
          )}

          {lines.length === 0 ? (
            <p className="rounded-md border border-dashed border-[#E2DDD8] py-4 text-center text-sm text-[#9CA3AF]">No worker selected yet.</p>
          ) : (
            <div className="space-y-1.5">
              {lines.map((l) => {
                const w = workerById.get(l.workerId);
                const fallback = initial?.lines.find((x) => x.workerId === l.workerId);
                return (
                  <div key={l.workerId} className="grid grid-cols-1 items-center gap-2 rounded-md border border-[#E2DDD8] px-3 py-2 md:grid-cols-12">
                    <div className="min-w-0 md:col-span-6">
                      <div className="truncate text-sm font-medium text-[#1F1D1B]">{w?.name ?? fallback?.workerName ?? l.workerId}</div>
                      <div className="text-[10px] text-[#9CA3AF]">
                        {w?.empNo ?? fallback?.empNo ?? "-"}
                        {(w?.departmentCode ?? fallback?.departmentCode) ? ` - ${(w?.departmentCode ?? fallback?.departmentCode ?? "").replace(/_/g, " ")}` : ""}
                      </div>
                    </div>
                    <div className="md:col-span-5">
                      <MoneyInput
                        value={l.amountRM}
                        onChange={(v) => setLines((prev) => prev.map((x) => (x.workerId === l.workerId ? { ...x, amountRM: v } : x)))}
                        placeholder="Penalty amount (RM)"
                        className="h-9 w-full rounded-md border border-[#E2DDD8] bg-white px-3 text-sm text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                      />
                    </div>
                    <div className="flex justify-end md:col-span-1">
                      <button
                        type="button"
                        onClick={() => setLines((prev) => prev.filter((x) => x.workerId !== l.workerId))}
                        title="Remove"
                        className="rounded p-1.5 text-[#9CA3AF] hover:bg-[#F3F0EC] hover:text-[#9A3A2D]"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* 4. Evidence */}
        {initial ? (
          <ResourceDocuments
            resourceType="worker-penalty"
            resourceId={initial.id}
            title="4. Photos"
            hint="Evidence of the mistake — the damaged piece, the wrong label, the QC finding."
            photosOnly
            emptyText="No photos yet."
          />
        ) : (
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[#6B5C32]">4. Photos</h3>
                <p className="text-[11px] text-[#9CA3AF]">Uploaded when you save. The damaged piece, the wrong label, the QC finding.</p>
              </div>
              <input ref={photoInputRef} type="file" accept="image/*" multiple className="hidden" onChange={pickPhotos} />
              <Button type="button" variant="outline" onClick={() => photoInputRef.current?.click()} disabled={saving}>
                <ImagePlus className="h-4 w-4" /> Add Photos
              </Button>
            </div>
            {previews.length === 0 ? (
              <p className="rounded-md border border-dashed border-[#E2DDD8] py-4 text-center text-sm text-[#9CA3AF]">No photos yet.</p>
            ) : (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                {previews.map((p, i) => (
                  <div key={p.url} className="group relative">
                    <img src={p.url} alt={p.file.name} title={p.file.name} className="h-24 w-full rounded border border-[#E2DDD8] object-cover" />
                    <button
                      type="button"
                      onClick={() => setPendingPhotos((prev) => prev.filter((_, j) => j !== i))}
                      title="Remove"
                      className="absolute right-1 top-1 rounded bg-white/90 p-1 text-[#9A3A2D]"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </DocumentDetailDrawer>
  );
}
