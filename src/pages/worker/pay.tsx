// ============================================================
// /worker/pay — Salary view (mobile)
//
// Answers ONE question for the worker: how much am I earning this month, and
// how is that number built up? Pick a MONTH (the in-progress month shows a live
// estimate; past months show the finalised payslip) and every line is itemised
// — full salary, absence (which days), overtime (which days), allowances,
// statutory deductions — so the worker can check exactly how the figure is
// reached.
//
// No date-range picker here: salary is viewed one whole month at a time.
// Attendance / efficiency by date range lives on /worker (Home); the per-day
// punch records live on /worker/history.
// ============================================================
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useT } from "@/lib/worker-i18n";
import { workerFetch } from "@/layouts/WorkerLayout";
import PayCard, { liveMonthCard, payslipCard } from "./pay-card";

// ---------- helpers ----------
function rm(sen: number | undefined): string {
  const n = sen ?? 0;
  return `RM ${(n / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
function fmtDay(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-MY", { day: "2-digit", month: "short" });
}
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
function monthLabel(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return period;
  return `${MONTH_NAMES[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

// ---------- types ----------
type PayData = {
  current: {
    period: string;
    workedDays: number;
    absentDays: number;
    otMinutes: number;
    fullSalarySen: number;
    absenceDeductionSen: number;
    shortHourDeductionSen: number;
    basicEarnedSen: number;
    otSen: number;
    efficiencyAllowanceSen: number;
    leadershipAllowanceSen: number;
    estimatedGrossSen: number;
    // Per-day detail behind the Absent / OT figures (optional — older backend
    // responses omit them; the UI then falls back to a plain, non-tappable row).
    absentDates?: string[];
    otDays?: Array<{ date: string; hours: number }>;
    lateDays?: Array<{ date: string; hours: number }>;
    payslipStatus?: string;
    // Per-day workers (no monthly basic): PayCard names the day rate instead.
    payMode?: "DAILY" | "MONTHLY";
    dailyRateSen?: number;
    advanceSen?: number;
    advanceDays?: Array<{ date: string; amountSen: number; note: string }>;
  };
  history: Array<{
    absentDays?: number;
    absenceDeductionSen?: number;
    otHours?: number;
    lateDays?: Array<{ date: string; hours: number }>;
    shortHourDeductionSen?: number;
    id: string;
    period: string;
    basicSen?: number;
    grossSen?: number;
    netSen?: number;
    allowancesSen?: number;
    overtimeSen?: number;
    epfEeSen?: number;
    socsoEeSen?: number;
    eisEeSen?: number;
    taxSen?: number;
    advanceDeductionSen?: number;
    advanceDays?: Array<{ date: string; amountSen: number; note: string }>;
    status?: string;
  }>;
};
type PayslipRow = PayData["history"][number];
type Translate = (key: string) => string;

type WorkerPayResponse =
  | { success: true; data: PayData }
  | { success: false; error?: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object";
}
function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asPayslipRow(v: unknown): PayslipRow | null {
  if (!isRecord(v)) return null;
  const id = asString(v.id);
  const period = asString(v.period);
  if (!id || !period) return null;
  return {
    id,
    period,
    basicSen: asNumber(v.basicSen) ?? undefined,
    grossSen: asNumber(v.grossSen) ?? undefined,
    netSen: asNumber(v.netSen) ?? undefined,
    allowancesSen: asNumber(v.allowancesSen) ?? undefined,
    overtimeSen: asNumber(v.overtimeSen) ?? undefined,
    absentDays: asNumber(v.absentDays) ?? 0,
    absenceDeductionSen: asNumber(v.absenceDeductionSen) ?? 0,
    otHours: asNumber(v.otHours) ?? 0,
    shortHourDeductionSen: asNumber(v.shortHourDeductionSen) ?? 0,
    lateDays: Array.isArray(v.lateDays)
      ? v.lateDays
          .filter(isRecord)
          .map((d) => ({ date: String(d.date ?? ""), hours: asNumber(d.hours) ?? 0 }))
          .filter((d) => d.date)
      : [],
    epfEeSen: asNumber(v.epfEeSen) ?? undefined,
    socsoEeSen: asNumber(v.socsoEeSen) ?? undefined,
    eisEeSen: asNumber(v.eisEeSen) ?? undefined,
    taxSen: asNumber(v.taxSen) ?? undefined,
    advanceDeductionSen: asNumber(v.advanceDeductionSen) ?? 0,
    advanceDays: Array.isArray(v.advanceDays)
      ? v.advanceDays
          .filter(isRecord)
          .map((d) => ({
            date: String(d.date ?? ""),
            amountSen: asNumber(d.amountSen) ?? 0,
            note: asString(d.note) ?? "",
          }))
          .filter((d) => d.date)
      : [],
    status: asString(v.status) ?? undefined,
  };
}

function asPayData(v: unknown): PayData | null {
  if (!isRecord(v) || !isRecord(v.current) || !Array.isArray(v.history)) return null;
  const period = asString(v.current.period);
  const workedDays = asNumber(v.current.workedDays);
  const absentDays = asNumber(v.current.absentDays) ?? 0;
  const otMinutes = asNumber(v.current.otMinutes);
  // fullSalarySen / absenceDeductionSen — tolerate an older backend that
  // predates them by falling back to 0.
  const fullSalarySen = asNumber(v.current.fullSalarySen) ?? 0;
  const absenceDeductionSen = asNumber(v.current.absenceDeductionSen) ?? 0;
  const shortHourDeductionSen = asNumber(v.current.shortHourDeductionSen) ?? 0;
  const basicEarnedSen = asNumber(v.current.basicEarnedSen);
  const otSen = asNumber(v.current.otSen);
  const efficiencyAllowanceSen = asNumber(v.current.efficiencyAllowanceSen) ?? 0;
  const leadershipAllowanceSen = asNumber(v.current.leadershipAllowanceSen) ?? 0;
  const estimatedGrossSen = asNumber(v.current.estimatedGrossSen);
  const absentDates = Array.isArray(v.current.absentDates)
    ? v.current.absentDates.filter((x): x is string => typeof x === "string")
    : [];
  const otDays = Array.isArray(v.current.otDays)
    ? v.current.otDays
        .map((o) =>
          isRecord(o) && typeof o.date === "string" && typeof o.hours === "number"
            ? { date: o.date, hours: o.hours }
            : null,
        )
        .filter((x): x is { date: string; hours: number } => !!x)
    : [];
  const lateDays = Array.isArray(v.current.lateDays)
    ? v.current.lateDays
        .map((o) =>
          isRecord(o) && typeof o.date === "string" && typeof o.hours === "number"
            ? { date: o.date, hours: o.hours }
            : null,
        )
        .filter((x): x is { date: string; hours: number } => !!x)
    : [];
  if (
    !period ||
    workedDays === null ||
    otMinutes === null ||
    basicEarnedSen === null ||
    otSen === null ||
    estimatedGrossSen === null
  )
    return null;
  return {
    current: {
      period,
      workedDays,
      absentDays,
      otMinutes,
      fullSalarySen,
      absenceDeductionSen,
      shortHourDeductionSen,
      basicEarnedSen,
      otSen,
      efficiencyAllowanceSen,
      leadershipAllowanceSen,
      estimatedGrossSen,
      absentDates,
      otDays,
      lateDays,
      payslipStatus: typeof v.current.payslipStatus === "string" ? v.current.payslipStatus : "NONE",
      payMode: v.current.payMode === "DAILY" ? "DAILY" : "MONTHLY",
      dailyRateSen: asNumber(v.current.dailyRateSen) ?? 0,
      advanceSen: asNumber(v.current.advanceSen) ?? 0,
      advanceDays: Array.isArray(v.current.advanceDays)
        ? v.current.advanceDays
            .filter(isRecord)
            .map((d) => ({
              date: String(d.date ?? ""),
              amountSen: asNumber(d.amountSen) ?? 0,
              note: asString(d.note) ?? "",
            }))
            .filter((d) => d.date)
        : [],
    },
    history: v.history
      .map(asPayslipRow)
      .filter((x): x is PayslipRow => !!x),
  };
}

function asWorkerPayResponse(v: unknown): WorkerPayResponse | null {
  if (!isRecord(v)) return null;
  if (v.success === true) {
    const data = asPayData(v.data);
    return data ? { success: true, data } : null;
  }
  if (v.success === false) return { success: false, error: asString(v.error) ?? undefined };
  return null;
}

// DEV-22: the worker's own approved penalties, one row per penalty line.
type WorkerPenalty = {
  id: string;
  penaltyNo: string;
  date: string;
  poNo: string;
  productName: string;
  reason: string;
  amountSen: number;
  payrollPeriod: string;
  deductedSen: number;
  status: "APPROVED" | "DEDUCTED";
};

function asWorkerPenalties(v: unknown): WorkerPenalty[] {
  if (!isRecord(v) || !Array.isArray(v.data)) return [];
  return v.data
    .filter(isRecord)
    .map((r) => ({
      id: asString(r.id) ?? "",
      penaltyNo: asString(r.penaltyNo) ?? "",
      date: asString(r.date) ?? "",
      poNo: asString(r.poNo) ?? "",
      productName: asString(r.productName) ?? "",
      reason: asString(r.reason) ?? "",
      amountSen: asNumber(r.amountSen) ?? 0,
      payrollPeriod: asString(r.payrollPeriod) ?? "",
      deductedSen: asNumber(r.deductedSen) ?? 0,
      status: r.status === "DEDUCTED" ? ("DEDUCTED" as const) : ("APPROVED" as const),
    }))
    .filter((p) => p.id);
}

// ============================================================
export default function WorkerPayPage() {
  const t = useT();
  const [pay, setPay] = useState<PayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<string | null>(null);
  const [penalties, setPenalties] = useState<WorkerPenalty[]>([]);

  const loadPay = useCallback(async () => {
    try {
      const res = await workerFetch("/api/worker/payslips");
      const j = asWorkerPayResponse(await res.json());
      if (j?.success) setPay(j.data);
    } catch {
      /* network error — leave pay null, the UI shows the error card */
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await loadPay();
      } finally {
        setLoading(false);
      }
    })();
  }, [loadPay]);

  // Penalties are a separate read: the pay card must render even if this fails.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await workerFetch("/api/worker/penalties");
        const list = asWorkerPenalties(await res.json());
        if (!cancelled) setPenalties(list);
      } catch {
        /* leave the list empty */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="pt-8 text-center text-[#5A5550]">{t("common.loading")}</div>
    );
  }
  if (!pay) {
    return (
      <div className="pt-8 text-center text-[#9A3A2D]">{t("common.error")}</div>
    );
  }

  // Salary is viewed one whole MONTH at a time (no date range — that lives on
  // Home, which is for efficiency). Options = the in-progress current month
  // (live estimate) + every finalised payslip, newest first. (Wei Siang
  // 2026-06-09: "Pay 只能选月份".)
  // A month whose only news is a scheduled penalty is still a month to pick.
  const months = Array.from(
    new Set([
      pay.current.period,
      ...pay.history.map((p) => p.period),
      ...penalties.map((p) => p.payrollPeriod).filter(Boolean),
    ]),
  ).sort((a, b) => (a < b ? 1 : -1));
  const selected = period ?? pay.current.period;
  const isCurrent = selected === pay.current.period;
  const slip = pay.history.find((p) => p.period === selected) ?? null;
  // One card for every worker and month: Net, Earnings, Deductions, Summary.
  // A month whose lines would not add up to payroll's figure keeps the old
  // card (see pay-card.tsx).
  const penaltySen = penalties
    .filter((p) => p.payrollPeriod === selected && p.status === "DEDUCTED")
    .reduce((s, p) => s + p.deductedSen, 0);
  const card = isCurrent
    ? liveMonthCard({ ...pay.current, periodLabel: monthLabel(selected) }, t)
    : slip
      ? payslipCard(
          slip,
          {
            periodLabel: monthLabel(selected),
            payMode: pay.current.payMode,
            dailyRateSen: pay.current.dailyRateSen,
            penaltySen,
          },
          t,
        )
      : null;

  return (
    <div className="space-y-4 pt-2">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">{t("pay.title")}</h1>
        <select
          aria-label="Month"
          value={selected}
          onChange={(e) => setPeriod(e.target.value)}
          className="h-9 shrink-0 rounded-lg border border-[#D8D2CC] bg-white px-3 text-sm font-semibold tabular-nums text-[#1F1D1B]"
        >
          {months.map((p) => (
            <option key={p} value={p}>
              {monthLabel(p)}
              {p === pay.current.period ? " · now" : ""}
            </option>
          ))}
        </select>
      </div>

      {card ? (
        <PayCard t={t} card={card}>
          {isCurrent && isFinalised(pay.current) && (
            <SavePayslipButton period={pay.current.period} />
          )}
        </PayCard>
      ) : isCurrent ? (
        <CurrentMonthBreakdown current={pay.current} t={t} />
      ) : slip ? (
        <FinalisedBreakdown slip={slip} t={t} />
      ) : (
        <div className="bg-white rounded-xl p-6 text-center text-sm text-[#8A8680] border border-[#D8D2CC]">
          —
        </div>
      )}

      {/* Penalties deducted (or to be deducted) in the SAME payroll month. */}
      {penalties.some((p) => p.payrollPeriod === selected) && (
        <PenaltyCard
          penalties={penalties.filter((p) => p.payrollPeriod === selected)}
          t={t}
        />
      )}
    </div>
  );
}

// DEV-22 — every approved penalty in the month: when, which order, why, how
// much, and whether it has actually come off an approved payslip yet.
function PenaltyCard({ penalties, t }: { penalties: WorkerPenalty[]; t: Translate }) {
  const total = penalties.reduce((s, p) => s + p.amountSen, 0);
  return (
    <div className="bg-white rounded-xl border border-[#D8D2CC] overflow-hidden">
      <div className="bg-[#4A2520] px-4 py-2.5 flex items-center justify-between">
        <p className="text-[11px] font-bold uppercase tracking-wider text-white">
          {t("pay.penalties")}
        </p>
        <p className="text-sm font-bold text-[#F0A99C] tabular-nums">− {rm(total)}</p>
      </div>
      <div className="divide-y divide-[#F0ECE9]">
        {penalties.map((p) => (
          <div key={p.id} className="px-4 py-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold text-[#1F1D1B]">{fmtDay(p.date)} · {p.penaltyNo}</p>
                {p.poNo && (
                  <p className="text-xs text-[#8A8680]">
                    {t("pay.penaltyOrder")}: {p.poNo}{p.productName ? ` · ${p.productName}` : ""}
                  </p>
                )}
              </div>
              <p className="shrink-0 font-bold tabular-nums text-[#9A3A2D]">− {rm(p.amountSen)}</p>
            </div>
            <p className="mt-1 text-xs text-[#5A5550]">
              {t("pay.penaltyReason")}: {p.reason}
            </p>
            <div className="mt-1.5 flex items-center justify-between text-[11px]">
              <span className="text-[#8A8680]">
                {t("pay.penaltyPayrollMonth")}: {monthLabel(p.payrollPeriod)}
              </span>
              <span
                className={`rounded px-1.5 py-0.5 font-semibold ${
                  p.status === "DEDUCTED"
                    ? "bg-[#EEF3E4] text-[#4F7C3A]"
                    : "bg-[#FBF1DC] text-[#9C6F1E]"
                }`}
              >
                {p.status === "DEDUCTED"
                  ? `${t("pay.penaltyDeducted")} ${rm(p.deductedSen)}`
                  : t("pay.penaltyApproved")}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// A month is only a DOCUMENT once the office has approved it. Until then the
// figures move as attendance comes in, so the phone shows them as an estimate
// and offers nothing to save — a worker holding a mid-month PDF that later
// changed is exactly the argument this whole screen exists to prevent
// (owner 2026-08-01: 只有 approved 才能 print).
function isFinalised(c: PayData["current"]): boolean {
  return c.payslipStatus === "APPROVED" || c.payslipStatus === "PAID";
}

function SavePayslipButton({ period }: { period: string }) {
  const t = useT();
  const [payslipBusy, setPayslipBusy] = useState(false);
  const openPayslip = async () => {
    // Fetch the DATA and render with the same generatePayslipHTML the office
    // prints — one document, two entry points. Opening the API URL directly
    // would have downloaded JSON.
    setPayslipBusy(true);
    try {
      const res = await workerFetch(`/api/worker/payslip/${encodeURIComponent(period)}`);
      const body = (await res.json()) as { success?: boolean; error?: string; data?: unknown };
      if (!res.ok || !body.success || !body.data) {
        alert(body.error || "Could not open the payslip.");
        return;
      }
      const { generatePayslipHTML } = await import("@/lib/generate-payslip-pdf");
      const html = generatePayslipHTML(
        body.data as Parameters<typeof generatePayslipHTML>[0],
      );
      const w = window.open("", "_blank");
      if (!w) {
        alert(t("pay.allowPopups"));
        return;
      }
      w.document.write(html);
      w.document.close();
      w.focus();
    } catch {
      alert(t("common.serverUnreachable"));
    } finally {
      setPayslipBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={openPayslip}
      disabled={payslipBusy}
      className="mt-3 w-full rounded-lg bg-white/10 py-2.5 text-sm font-semibold text-white active:bg-white/20 disabled:opacity-50"
    >
      {payslipBusy ? t("pay.opening") : t("pay.savePdf")}
    </button>
  );
}

// The old cards below are the fallback for a month PayCard cannot rebuild.
// Current (in-progress) month — a LIVE estimate. Every line is itemised so the
// worker can see how the gross is built; Absent / OT rows tap open to the dates.
function CurrentMonthBreakdown({
  current: c,
  t,
}: {
  current: PayData["current"];
  t: Translate;
}) {
  const otHours = (c.otMinutes / 60).toFixed(1);
  const absentChips = (c.absentDates ?? []).map((d) => ({
    key: d,
    text: fmtDay(d),
  }));
  const otChips = (c.otDays ?? []).map((d) => ({
    key: d.date,
    text: `${fmtDay(d.date)} · ${
      Number.isInteger(d.hours) ? d.hours : d.hours.toFixed(1)
    }h`,
  }));
  // Days behind the Late / short-hours deduction (each docked day + hours), so
  // that figure taps open to "which days" just like Absent / OT.
  const lateChips = (c.lateDays ?? []).map((d) => ({
    key: d.date,
    text: `${fmtDay(d.date)} · ${
      Number.isInteger(d.hours) ? d.hours : d.hours.toFixed(1)
    }h`,
  }));
  const finalised = isFinalised(c);
  return (
    <div className="bg-[#1F1D1B] text-white rounded-xl p-4">
      <p className="text-[11px] text-[#B0AAA3]">
        {finalised ? "FINAL" : t("pay.estimate")}
      </p>
      <p className="text-4xl font-bold tracking-tight mt-1">
        {rm(c.estimatedGrossSen)}
      </p>
      {finalised && <SavePayslipButton period={c.period} />}

      <div className="mt-4 pt-4 border-t border-white/10 space-y-2 text-sm">
        <Row label={t("pay.fullSalary")} value={rm(c.fullSalarySen)} />
        {c.absentDays > 0 && (
          <DetailRow
            label={t("pay.absentDeduction").replace("{n}", String(c.absentDays))}
            value={`− ${rm(c.absenceDeductionSen)}`}
            muted
            chips={absentChips}
            tone="red"
          />
        )}
        {/* Late clock-in / short-hour dock — only when one applies. Sits between
            the absence line and Basic so the running total reads correctly:
            Full salary − Absent − Late/short = Basic. */}
        {c.shortHourDeductionSen > 0 && (
          <DetailRow
            label={t("pay.lateShortDeduction")}
            value={`− ${rm(c.shortHourDeductionSen)}`}
            muted
            chips={lateChips}
            tone="red"
          />
        )}
        <Row label={t("pay.basicEarned")} value={rm(c.basicEarnedSen)} />
        <DetailRow
          label={`${t("pay.ot")} · ${otHours}h`}
          value={rm(c.otSen)}
          chips={otChips}
          tone="amber"
        />
        {/* Efficiency allowance is ALWAYS listed (even RM 0.00) so the breakdown
            is complete — RM150 when the worker hits their monthly target. */}
        <Row
          label={t("pay.efficiencyAllowance")}
          value={rm(c.efficiencyAllowanceSen)}
        />
        {/* Leadership allowance — same "always listed" rule, no threshold. */}
        <Row
          label={t("pay.leadershipAllowance")}
          value={rm(c.leadershipAllowanceSen)}
        />
        <div className="pt-2 mt-2 border-t border-white/10">
          <Row label={t("pay.gross")} value={rm(c.estimatedGrossSen)} bold />
        </div>
      </div>
    </div>
  );
}

// A finalised (generated) payslip for a past month — the locked-in figures.
function FinalisedBreakdown({ slip, t }: { slip: PayslipRow; t: Translate }) {
  return (
    <div className="bg-[#1F1D1B] text-white rounded-xl p-4">
      <p className="text-[11px] text-[#B0AAA3]">{t("pay.netPay")}</p>
      <p className="text-4xl font-bold tracking-tight mt-1">
        {rm(slip.netSen ?? slip.grossSen)}
      </p>

      <div className="mt-4 pt-4 border-t border-white/10 space-y-2 text-sm">
        {/* The "why is it this number" half. A finished month used to show a
            bare Net — the moment a worker most wants to check it (owner
            2026-08-02). Same chips as the in-progress month, so the two views
            read the same way. */}
        {slip.absenceDeductionSen ? (
          <Row
            label={t("pay.absentDeduction").replace("{n}", String(slip.absentDays ?? 0))}
            value={`− ${rm(slip.absenceDeductionSen)}`}
            muted
          />
        ) : null}
        {slip.shortHourDeductionSen ? (
          <DetailRow
            label={t("pay.lateShortDeduction")}
            value={`− ${rm(slip.shortHourDeductionSen)}`}
            chips={(slip.lateDays ?? []).map((d) => ({
              key: d.date,
              text: `${fmtDay(d.date)} · ${
                Number.isInteger(d.hours) ? d.hours : d.hours.toFixed(1)
              }h`,
            }))}
            tone="amber"
          />
        ) : null}
        <Row label={t("pay.basicEarned")} value={rm(slip.basicSen)} />
        {slip.allowancesSen ? (
          // Combined efficiency + leadership allowance (payslip's single
          // allowancesSen bucket — see generate-payslip-pdf.ts), so this row
          // uses the generic label, not the efficiency-only one above.
          <Row label={t("pay.allowance")} value={rm(slip.allowancesSen)} />
        ) : null}
        {slip.overtimeSen ? (
          <Row
            label={`${t("pay.ot")}${slip.otHours ? ` · ${slip.otHours.toFixed(1)}h` : ""}`}
            value={rm(slip.overtimeSen)}
          />
        ) : null}
        <div className="pt-2 mt-2 border-t border-white/10">
          <Row label={t("pay.gross")} value={rm(slip.grossSen)} bold />
        </div>
        {slip.epfEeSen ? (
          <Row label="EPF" value={`− ${rm(slip.epfEeSen)}`} muted />
        ) : null}
        {slip.socsoEeSen ? (
          <Row label="SOCSO" value={`− ${rm(slip.socsoEeSen)}`} muted />
        ) : null}
        {slip.eisEeSen ? (
          <Row label="EIS" value={`− ${rm(slip.eisEeSen)}`} muted />
        ) : null}
        {slip.taxSen ? (
          <Row label="Tax" value={`− ${rm(slip.taxSen)}`} muted />
        ) : null}
        {/* Cash already collected during the month. Net is net of it, so
            without this line Net sat below Gross with no reason shown. */}
        {slip.advanceDeductionSen ? (
          <DetailRow
            label={t("pay.salaryAdvance")}
            value={`− ${rm(slip.advanceDeductionSen)}`}
            chips={(slip.advanceDays ?? []).map((d, i) => ({
              key: `${d.date}-${i}`,
              text: `${fmtDay(d.date)} · ${rm(d.amountSen)}${d.note ? ` · ${d.note}` : ""}`,
            }))}
            tone="red"
          />
        ) : null}
        <div className="pt-2 mt-2 border-t border-white/10">
          <Row label="Net" value={rm(slip.netSen)} bold />
        </div>
      </div>
    </div>
  );
}

// ---------- tiny UI helpers ----------
function Row({
  label,
  value,
  bold,
  muted,
}: {
  label: string;
  value: string;
  bold?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between ${
        muted ? "text-[#8A8680]" : ""
      }`}
    >
      <span>{label}</span>
      <span className={bold ? "font-bold" : ""}>{value}</span>
    </div>
  );
}

// A pay row whose figure can be tapped to reveal the specific dates behind it
// (which days were absent / had OT, with hours). Falls back to a plain,
// non-tappable row when there is no detail (e.g. an older backend response).
function DetailRow({
  label,
  value,
  muted,
  chips,
  tone,
}: {
  label: string;
  value: string;
  muted?: boolean;
  chips: Array<{ key: string; text: string }>;
  tone: "red" | "amber";
}) {
  const [open, setOpen] = useState(false);
  const has = chips.length > 0;
  const palette =
    tone === "red"
      ? "bg-[#4A2520] text-[#F0A99C]"
      : "bg-[#41331A] text-[#E5BE80]";
  return (
    <div>
      <button
        type="button"
        disabled={!has}
        onClick={() => setOpen((o) => !o)}
        className={`w-full flex items-center justify-between text-left ${
          muted ? "text-[#8A8680]" : ""
        }`}
      >
        <span className="flex items-center gap-1">
          {label}
          {has &&
            (open ? (
              <ChevronUp className="h-3 w-3 opacity-60" />
            ) : (
              <ChevronDown className="h-3 w-3 opacity-60" />
            ))}
        </span>
        <span>{value}</span>
      </button>
      {open && has && (
        <div className="flex flex-wrap gap-1.5 mt-2 mb-1">
          {chips.map((c) => (
            <span
              key={c.key}
              className={`inline-flex max-w-full items-center break-words rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums ${palette}`}
            >
              {c.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
