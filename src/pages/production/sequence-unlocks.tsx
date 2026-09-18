// ---------------------------------------------------------------------------
// Sequence unlock report — who released the upstream lock, on which step, and
// whether it was a real skip or a recording gap (PRD T-013 R12).
//
// This page is the instrument that decides when the lock tightens from
// "anyone may release it" to supervisors only. A quiet week of recording gaps
// means the floor was ahead of the record and the fix is on the recording
// side; real skips mean the record was ahead of the floor. Reads
// GET /api/production-orders/sequence-unlocks; nothing here is computed on
// the client beyond formatting.
// ---------------------------------------------------------------------------
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ArrowLeft, Lock } from "lucide-react";

type Tally = { total: number; realSkips: number; recordingGaps: number };
type Report = {
  days: number;
  since: string;
  total: number;
  realSkips: number;
  recordingGaps: number;
  byActor: Array<Tally & { actorKind: string; actorName: string }>;
  byDepartment: Array<Tally & { departmentCode: string }>;
  byReason: Array<Tally & { reasonCode: string }>;
  rows: Array<{
    id: string;
    at: string | null;
    actorName: string | null;
    actorKind: string | null;
    poNo: string | null;
    productionOrderId: string | null;
    departmentCode: string | null;
    blockedBy: string | null;
    reasonCode: string;
    reason: string | null;
    recordingGap: boolean;
  }>;
};

const REASON_LABEL: Record<string, string> = {
  RECORDING_GAP: "Recording gap",
  REAL_SKIP: "Real skip",
  NOT_APPLICABLE: "Step not applicable",
  OTHER: "Other",
  SHEETS_SYNC: "Google Sheets edit",
  UNCLASSIFIED: "Before 2026-09-17 (no code)",
};

const DAY_OPTIONS = [7, 14, 30, 90];

function fmtAt(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-MY", { timeZone: "Asia/Kuala_Lumpur", hour12: false });
}


function Tile({ label, value, tone }: { label: string; value: number; tone?: "amber" | "red" }) {
  return (
    <div
      className={`rounded-lg border px-4 py-3 ${
        tone === "red"
          ? "border-[#E8D7D2] bg-[#FBF2F0]"
          : tone === "amber"
            ? "border-[#E8D9A8] bg-[#FAEFCB]"
            : "border-[#E2DDD8] bg-white"
      }`}
    >
      <p className="text-xs text-[#6B7280]">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-[#1F1D1B]">{value}</p>
    </div>
  );
}

function TallyTable<T extends Tally>({
  title,
  rows,
  keyLabel,
  keyOf,
}: {
  title: string;
  rows: T[];
  keyLabel: string;
  keyOf: (r: T) => string;
}) {
  return (
    <div className="rounded-lg border border-[#E2DDD8] bg-white">
      <div className="border-b border-[#E2DDD8] px-4 py-2 text-sm font-semibold text-[#1F1D1B]">
        {title}
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-[#8A8680]">Nothing in this window.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-[#6B7280]">
              <th className="px-4 py-2 font-normal">{keyLabel}</th>
              <th className="px-2 py-2 text-right font-normal">Total</th>
              <th className="px-2 py-2 text-right font-normal">Real skips</th>
              <th className="px-4 py-2 text-right font-normal">Recording gaps</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={keyOf(r)} className="border-t border-[#F0ECE8]">
                <td className="px-4 py-1.5">{keyOf(r)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{r.total}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-[#9A3A2D]">{r.realSkips}</td>
                <td className="px-4 py-1.5 text-right tabular-nums text-[#7A5610]">{r.recordingGaps}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function SequenceUnlocksPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const days = Number(params.get("days") ?? 7) || 7;
  const [report, setReport] = useState<Report | null>(null);
  // Loading = the report on screen is not for the window selected. Derived,
  // so the effect below never sets state synchronously.
  const loading = report === null || report.days !== days;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/production-orders/sequence-unlocks?days=${encodeURIComponent(days)}`,
          { credentials: "include" },
        );
        const j = (await res.json()) as { success: boolean; data?: Report; error?: string };
        if (!res.ok || !j.success || !j.data) throw new Error(j.error ?? `HTTP ${res.status}`);
        if (!cancelled) setReport(j.data);
      } catch (err) {
        if (!cancelled) toast.error(`Load failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days, toast]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate("/production")}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          Production
        </Button>
        <div className="flex items-center gap-2">
          <Lock className="h-5 w-5 text-[#9C6F1E]" />
          <h1 className="text-lg font-semibold text-[#1F1D1B]">Sequence unlocks</h1>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {DAY_OPTIONS.map((d) => (
            <Button
              key={d}
              size="sm"
              variant={d === days ? "default" : "outline"}
              onClick={() => setParams({ days: String(d) })}
            >
              {d}d
            </Button>
          ))}
        </div>
      </div>

      <p className="text-sm text-[#6B7280]">
        Every time someone completed a step while an earlier step was still open, and why.
        The lock stays self-service until this list is quiet; then it tightens to supervisors.
      </p>

      {loading && !report ? (
        <p className="text-sm text-[#8A8680]">Loading...</p>
      ) : report ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label={`Unlocks in ${report.days} days`} value={report.total} />
            <Tile label="Real skips" value={report.realSkips} tone="red" />
            <Tile label="Recording gaps" value={report.recordingGaps} tone="amber" />
            <Tile
              label="Other / sheet / unclassified"
              value={report.total - report.realSkips - report.recordingGaps}
            />
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <TallyTable
              title="By person"
              rows={report.byActor}
              keyLabel="Who"
              keyOf={(r) => `${r.actorName}${r.actorKind === "WORKER" ? " (floor)" : r.actorKind === "SYSTEM" ? " (system)" : ""}`}
            />
            <TallyTable
              title="By step"
              rows={report.byDepartment}
              keyLabel="Department released"
              keyOf={(r) => r.departmentCode}
            />
            <TallyTable
              title="By reason"
              rows={report.byReason}
              keyLabel="Reason"
              keyOf={(r) => REASON_LABEL[r.reasonCode] ?? r.reasonCode}
            />
          </div>

          <div className="rounded-lg border border-[#E2DDD8] bg-white">
            <div className="border-b border-[#E2DDD8] px-4 py-2 text-sm font-semibold text-[#1F1D1B]">
              Every unlock{report.rows.length < report.total ? ` (first ${report.rows.length} of ${report.total})` : ""}
            </div>
            {report.rows.length === 0 ? (
              <p className="px-4 py-3 text-sm text-[#8A8680]">
                No unlocks in the last {report.days} days.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-[#6B7280]">
                      <th className="px-4 py-2 font-normal">When</th>
                      <th className="px-2 py-2 font-normal">Who</th>
                      <th className="px-2 py-2 font-normal">PO</th>
                      <th className="px-2 py-2 font-normal">Step</th>
                      <th className="px-2 py-2 font-normal">Was waiting on</th>
                      <th className="px-2 py-2 font-normal">Kind</th>
                      <th className="px-4 py-2 font-normal">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((r) => (
                      <tr key={r.id} className="border-t border-[#F0ECE8] align-top">
                        <td className="whitespace-nowrap px-4 py-1.5 tabular-nums">{fmtAt(r.at)}</td>
                        <td className="px-2 py-1.5">
                          {r.actorName ?? ""}
                          {r.actorKind === "WORKER" ? (
                            <span className="ml-1 text-xs text-[#8A8680]">floor</span>
                          ) : r.actorKind === "SYSTEM" ? (
                            <span className="ml-1 text-xs text-[#8A8680]">system</span>
                          ) : null}
                        </td>
                        <td className="whitespace-nowrap px-2 py-1.5">{r.poNo ?? r.productionOrderId ?? ""}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 font-medium">{r.departmentCode ?? ""}</td>
                        <td className="px-2 py-1.5">{r.blockedBy ?? ""}</td>
                        <td className="whitespace-nowrap px-2 py-1.5">
                          <span
                            className={`rounded px-1.5 py-0.5 text-xs ${
                              r.reasonCode === "REAL_SKIP"
                                ? "bg-[#FBF2F0] text-[#9A3A2D]"
                                : r.recordingGap
                                  ? "bg-[#FAEFCB] text-[#7A5610]"
                                  : "bg-[#F3F1EE] text-[#4B4741]"
                            }`}
                          >
                            {REASON_LABEL[r.reasonCode] ?? r.reasonCode}
                          </span>
                        </td>
                        <td className="px-4 py-1.5 text-[#4B4741]">{r.reason ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
