// ============================================================
// PayCard — the My Pay card for every worker, every month.
//
// Reads top to bottom the way the sum is done:
//   Net pay (hero)
//   Earnings:   base pay − absent − late + OT + allowances = Gross
//   Deductions: EPF, SOCSO, EIS, tax, salary advance, penalties
//   Summary:    Gross − Deductions = Net
//
// Gross here is the payslip's Gross (absence and late are taken off inside
// Earnings), so the phone, the office screen and the PDF quote one number.
//
// Base pay is "Monthly salary" for a monthly worker. A per-day worker has no
// monthly basic, so theirs reads "Daily rate earnings (N days @ RM X/day)"
// instead of a confusing "Basic RM 0.00".
//
// The builders below return null when their lines do not add up to the
// figure they rebuild (the live estimate's Gross, or a payslip's stored Net);
// /worker/pay then keeps the old card for that month rather than show a sum
// that disagrees with payroll. All money is integer sen.
// ============================================================
import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { roundSen } from "@/lib/utils";

type Translate = (key: string) => string;
export type LateDay = { date: string; hours: number };
export type PayLine = { label: string; amountSen: number; chips?: string[] };
export type PayCardData = {
  /** e.g. "Oct 2026" */
  periodLabel: string;
  /** true while the month can still move (not approved). */
  isEstimate: boolean;
  /** Small line under the hero figure. */
  note?: string;
  /** Monthly salary, or days × day rate. Always shown. */
  base: PayLine;
  /** Taken off inside Earnings: absent days, late / short hours. */
  less: PayLine[];
  /** Added inside Earnings: OT, allowances. */
  plus: PayLine[];
  /** Taken off Gross: statutory, salary advance, penalties. */
  deductions: PayLine[];
};

const sum = (lines: PayLine[]) => lines.reduce((s, l) => s + l.amountSen, 0);

export function payTotals(d: Pick<PayCardData, "base" | "less" | "plus" | "deductions">) {
  const grossSen = d.base.amountSen - sum(d.less) + sum(d.plus);
  const totalDeductionsSen = sum(d.deductions);
  return { grossSen, totalDeductionsSen, netSen: grossSen - totalDeductionsSen };
}

// Same formatting as /worker/pay (copied, not imported: that page pulls in the
// whole worker layout).
function rm(sen: number): string {
  const sign = sen < 0 ? "−" : "";
  return `${sign}RM ${(Math.abs(sen) / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
function fmtDay(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-MY", { day: "2-digit", month: "short" });
}
function fmtDuration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}
const lateChips = (days: LateDay[] | undefined) =>
  (days ?? []).map((d) => `${fmtDay(d.date)} · ${fmtDuration(d.hours)}`);
const advanceChips = (days: Array<{ date: string; amountSen: number; note?: string }> | undefined) =>
  (days ?? []).map((d) => `${fmtDay(d.date)} · ${rm(d.amountSen)}${d.note ? ` · ${d.note}` : ""}`);
const isDone = (status: string | undefined) => status === "APPROVED" || status === "PAID";

function dailyBase(t: Translate, days: number, rateSen: number): PayLine {
  return {
    label: t("pay.dailyRateEarnings").replace("{n}", String(days)).replace("{rate}", rm(rateSen)),
    amountSen: roundSen(days * rateSen),
  };
}

// ---------- the in-progress month (live estimate) ----------
export type LiveMonth = {
  periodLabel: string;
  payMode?: "DAILY" | "MONTHLY";
  dailyRateSen?: number;
  workedDays: number;
  fullSalarySen: number;
  absentDays: number;
  absenceDeductionSen: number;
  absentDates?: string[];
  shortHourDeductionSen: number;
  lateDays?: LateDay[];
  otSen: number;
  otMinutes: number;
  otDays?: LateDay[];
  efficiencyAllowanceSen: number;
  leadershipAllowanceSen: number;
  estimatedGrossSen: number;
  advanceSen?: number;
  advanceDays?: Array<{ date: string; amountSen: number; note?: string }>;
  payslipStatus?: string;
};

export function liveMonthCard(c: LiveMonth, t: Translate): PayCardData | null {
  const daily = c.payMode === "DAILY";
  const card: PayCardData = {
    periodLabel: c.periodLabel,
    isEstimate: !isDone(c.payslipStatus),
    note: daily ? t("pay.dailyRateNote").replace("{rate}", rm(c.dailyRateSen ?? 0)) : undefined,
    base: daily
      ? dailyBase(t, c.workedDays, c.dailyRateSen ?? 0)
      : { label: t("pay.monthlySalary"), amountSen: c.fullSalarySen },
    less: [
      {
        label: t("pay.absentDeduction").replace("{n}", String(c.absentDays)),
        amountSen: c.absenceDeductionSen,
        chips: (c.absentDates ?? []).map(fmtDay),
      },
      { label: t("pay.lateShortDeduction"), amountSen: c.shortHourDeductionSen, chips: lateChips(c.lateDays) },
    ],
    plus: [
      {
        label: `${t("pay.ot")} · ${(c.otMinutes / 60).toFixed(1)}h`,
        amountSen: c.otSen,
        chips: (c.otDays ?? []).map((d) => `${fmtDay(d.date)} · ${fmtDuration(d.hours)}`),
      },
      { label: t("pay.efficiencyAllowance"), amountSen: c.efficiencyAllowanceSen },
      { label: t("pay.leadershipAllowance"), amountSen: c.leadershipAllowanceSen },
    ],
    deductions: [
      { label: t("pay.salaryAdvance"), amountSen: c.advanceSen ?? 0, chips: advanceChips(c.advanceDays) },
    ],
  };
  // The engine floors basic at 0 (absences can exceed a part month's salary);
  // the card's plain sum would then disagree, so keep the old card.
  return payTotals(card).grossSen === c.estimatedGrossSen ? card : null;
}

// ---------- a month with a stored payslip ----------
export type StoredPayslip = {
  status?: string;
  basicSen?: number;
  grossSen?: number;
  netSen?: number;
  overtimeSen?: number;
  otHours?: number;
  allowancesSen?: number;
  absentDays?: number;
  absenceDeductionSen?: number;
  shortHourDeductionSen?: number;
  lateDays?: LateDay[];
  advanceDeductionSen?: number;
  advanceDays?: Array<{ date: string; amountSen: number; note?: string }>;
  epfEeSen?: number;
  socsoEeSen?: number;
  eisEeSen?: number;
  taxSen?: number;
};

// A payslip stores Gross and Net but not the late charge (and, for a per-day
// worker, not the days or a basic). Both fall out of the sum it was built by:
//   Gross = base − absent − late + OT + allowance
// Monthly: base is the stored basic, so late is simply what is left over.
// Per-day: base is days × day rate with both days and late unknown. The late
// charge from today's late records is tried first, then 0 (months generated
// before per-day late docks existed on 2026-08-31 charged none); a 1 sen
// rounding gap is absorbed into the late line. Either way the card is only
// returned when its Net equals the stored Net.
export function payslipCard(
  slip: StoredPayslip,
  ctx: { periodLabel: string; payMode?: "DAILY" | "MONTHLY"; dailyRateSen?: number; penaltySen?: number },
  t: Translate,
): PayCardData | null {
  if (slip.grossSen == null || slip.netSen == null) return null;
  const absentSen = slip.absenceDeductionSen ?? 0;
  const plus: PayLine[] = [
    {
      label: `${t("pay.ot")}${slip.otHours ? ` · ${slip.otHours.toFixed(1)}h` : ""}`,
      amountSen: slip.overtimeSen ?? 0,
    },
    { label: t("pay.allowance"), amountSen: slip.allowancesSen ?? 0 },
  ];
  const deductions: PayLine[] = [
    { label: "EPF", amountSen: slip.epfEeSen ?? 0 },
    { label: "SOCSO", amountSen: slip.socsoEeSen ?? 0 },
    { label: "EIS", amountSen: slip.eisEeSen ?? 0 },
    { label: "Tax", amountSen: slip.taxSen ?? 0 },
    {
      label: t("pay.salaryAdvance"),
      amountSen: slip.advanceDeductionSen ?? 0,
      chips: advanceChips(slip.advanceDays),
    },
    { label: t("pay.penalties"), amountSen: ctx.penaltySen ?? 0 },
  ];
  // What base − absent − late must come to.
  const afterDocksSen = slip.grossSen - sum(plus);

  let base: PayLine | null = null;
  let lateSen = 0;
  let note: string | undefined;
  if (ctx.payMode === "DAILY") {
    const rateSen = ctx.dailyRateSen ?? 0;
    if (rateSen <= 0) return null;
    note = t("pay.dailyRateNote").replace("{rate}", rm(rateSen));
    for (const tryLateSen of [slip.shortHourDeductionSen ?? 0, 0]) {
      const days = Math.round((afterDocksSen + absentSen + tryLateSen) / rateSen);
      const late = days * rateSen - absentSen - afterDocksSen;
      if (days < 0 || late < 0 || Math.abs(late - tryLateSen) > 1) continue;
      base = dailyBase(t, days, rateSen);
      lateSen = late;
      break;
    }
    if (!base) return null;
  } else {
    base = { label: t("pay.monthlySalary"), amountSen: slip.basicSen ?? 0 };
    lateSen = base.amountSen - absentSen - afterDocksSen;
    if (lateSen < 0) return null;
  }

  const card: PayCardData = {
    periodLabel: ctx.periodLabel,
    isEstimate: !isDone(slip.status),
    note,
    base,
    less: [
      {
        label: t("pay.absentDeduction").replace("{n}", String(slip.absentDays ?? 0)),
        amountSen: absentSen,
      },
      {
        label: t("pay.lateShortDeduction"),
        amountSen: lateSen,
        chips: lateSen > 0 ? lateChips(slip.lateDays) : [],
      },
    ],
    plus,
    deductions,
  };
  return payTotals(card).netSen === slip.netSen ? card : null;
}

// ---------- the card ----------
export default function PayCard({
  t,
  card,
  children,
}: {
  t: Translate;
  card: PayCardData;
  /** Rendered under the hero, e.g. the Save-payslip button. */
  children?: ReactNode;
}) {
  const { grossSen, totalDeductionsSen, netSen } = payTotals(card);
  const shown = (lines: PayLine[]) => lines.filter((l) => l.amountSen !== 0);
  const less = shown(card.less);
  const plus = shown(card.plus);
  const deductions = shown(card.deductions);

  return (
    <div className="overflow-hidden rounded-2xl bg-[#1F1D1B] text-white">
      {/* ---- Hero: the one number the worker came for ---- */}
      <div className="px-4 pt-4 pb-5 sm:px-6 sm:pt-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-[#B0AAA3]">
            {t("pay.netPay")} · {card.periodLabel}
          </p>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              card.isEstimate
                ? "bg-[#41331A] text-[#E5BE80]"
                : "bg-[#1F3A2B] text-[#9FD3B0]"
            }`}
          >
            {card.isEstimate ? t("pay.estimate") : t("pay.final")}
          </span>
        </div>
        <p
          className={`mt-1 text-4xl font-bold tracking-tight tabular-nums sm:text-5xl ${
            netSen < 0 ? "text-[#F0A99C]" : ""
          }`}
        >
          {rm(netSen)}
        </p>
        {card.note && <p className="mt-1 text-xs text-[#8A8680]">{card.note}</p>}
        {children}
      </div>

      {/* ---- 1. Earnings ---- */}
      <Section title={t("pay.earnings")}>
        <Line line={card.base} value={rm(card.base.amountSen)} tone="plus" />
        {less.map((l) => (
          <Line key={l.label} line={l} value={`− ${rm(l.amountSen)}`} tone="minus" />
        ))}
        {plus.map((l) => (
          <Line key={l.label} line={l} value={rm(l.amountSen)} tone="plus" />
        ))}
        <Subtotal label={t("pay.gross")} value={rm(grossSen)} />
      </Section>

      {/* ---- 2. Deductions ---- */}
      <Section title={t("pay.deductions")}>
        {deductions.length === 0 && (
          <p className="text-sm text-[#8A8680]">{t("pay.noDeductions")}</p>
        )}
        {deductions.map((l) => (
          <Line key={l.label} line={l} value={`− ${rm(l.amountSen)}`} tone="minus" />
        ))}
        {deductions.length > 0 && (
          <Subtotal label={t("pay.totalDeductions")} value={`− ${rm(totalDeductionsSen)}`} minus />
        )}
      </Section>

      {/* ---- 3. Summary: the sum, written out ---- */}
      <div className="bg-white/[0.04] px-4 py-4 sm:px-6">
        <div className="space-y-1.5 text-sm">
          <Row label={t("pay.gross")} value={rm(grossSen)} />
          <Row label={t("pay.totalDeductions")} value={`− ${rm(totalDeductionsSen)}`} minus />
        </div>
        <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-white/10 pt-3">
          <span className="font-semibold">{t("pay.netPay")}</span>
          <span className="shrink-0 text-lg font-bold tabular-nums">{rm(netSen)}</span>
        </div>
      </div>
    </div>
  );
}

// ---------- pieces ----------
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-white/10 px-4 py-4 sm:px-6">
      <h3 className="mb-3 text-[11px] font-bold uppercase tracking-wider text-[#B0AAA3]">
        {title}
      </h3>
      <div className="space-y-2.5 text-sm">{children}</div>
    </section>
  );
}

function Row({ label, value, minus }: { label: string; value: string; minus?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="min-w-0 break-words text-[#E8E4E0]">{label}</span>
      <span className={`shrink-0 font-medium tabular-nums ${minus ? "text-[#F0A99C]" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function Subtotal({ label, value, minus }: { label: string; value: string; minus?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-dashed border-white/10 pt-2.5">
      <span className="font-semibold">{label}</span>
      <span className={`shrink-0 font-bold tabular-nums ${minus ? "text-[#F0A99C]" : ""}`}>
        {value}
      </span>
    </div>
  );
}

// A pay line. With chips (which days were absent / late / had OT, when an
// advance was taken) it taps open to show them; otherwise it is a plain row.
function Line({ line, value, tone }: { line: PayLine; value: string; tone: "plus" | "minus" }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const chips = line.chips ?? [];
  const valueTone = tone === "plus" ? "text-[#9FD3B0]" : "text-[#F0A99C]";
  if (chips.length === 0) {
    return (
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0 break-words text-[#E8E4E0]">{line.label}</span>
        <span className={`shrink-0 font-medium tabular-nums ${valueTone}`}>{value}</span>
      </div>
    );
  }
  const chipTone =
    tone === "minus" ? "bg-[#4A2520] text-[#F0A99C]" : "bg-[#41331A] text-[#E5BE80]";
  return (
    <div className={`-mx-2 rounded-xl px-2 py-2 ${tone === "minus" ? "bg-[#4A2520]/40" : "bg-white/[0.04]"}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start justify-between gap-3 text-left"
      >
        <span className="min-w-0 break-words text-[#E8E4E0]">{line.label}</span>
        <span className={`flex shrink-0 items-center gap-1 font-medium tabular-nums ${valueTone}`}>
          {value}
          <ChevronDown
            aria-hidden
            className={`h-4 w-4 text-[#B0AAA3] transition-transform motion-reduce:transition-none ${
              open ? "rotate-180" : ""
            }`}
          />
        </span>
      </button>
      <div
        id={panelId}
        className={`grid transition-[grid-template-rows] duration-200 motion-reduce:transition-none ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <ul inert={!open} aria-label={line.label} className="flex flex-wrap gap-1.5 overflow-hidden">
          {chips.map((c, i) => (
            <li
              key={`${c}-${i}`}
              className={`mt-2 inline-flex max-w-full items-center break-words rounded-full px-2.5 py-1 text-[11px] font-medium tabular-nums ${chipTone}`}
            >
              {c}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
