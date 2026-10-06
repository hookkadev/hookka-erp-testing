// ============================================================
// DailyPayCard — My Pay card for a per-day (payMode = DAILY) worker.
//
// A daily worker has no fixed monthly basic, so the monthly card's
// "Basic: RM 0.00" read like a mistake. This card never shows that row; the
// earnings line itself says where the money comes from:
// "Daily rate earnings (N days @ RM X/day)".
//
// Reads top to bottom the way the sum is done:
//   Net pay (hero) → Earnings → Deductions → Summary (Gross − Deductions = Net)
//
// Presentational: every figure comes in as a prop, all money in integer sen.
// /worker/pay renders it for a DAILY worker: the current month from the live
// estimate, a past month via dailyCardFromPayslip.
// ============================================================
import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { roundSen } from "@/lib/utils";

export type PayLine = { label: string; amountSen: number };
export type LateDay = { date: string; hours: number };
type Translate = (key: string) => string;

export type DailyPayCardProps = {
  t: Translate;
  /** e.g. "Oct 2026" */
  periodLabel: string;
  /** true while the month is still moving (not yet approved). */
  isEstimate: boolean;
  ratePerDaySen: number;
  /** May be fractional (half days). */
  daysWorked: number;
  /** OT, allowances, anything earned on top of the daily rate. */
  otherEarnings?: PayLine[];
  /** Late clock-in / short-hours dock, with the days behind it. */
  lateShortSen: number;
  lateDays?: LateDay[];
  advanceSen: number;
  /** Unpaid leave, EPF, SOCSO, EIS, tax, penalties … */
  otherDeductions?: PayLine[];
  /** Rendered under the hero, e.g. the Save-payslip button. */
  children?: ReactNode;
};

// Gross is days × rate BEFORE any docking: the late/short dock arrives only as
// lateShortSen. Feeding in a days figure that already has the dock taken off
// would count it twice.
export function computeDailyPay(p: {
  ratePerDaySen: number;
  daysWorked: number;
  otherEarnings?: PayLine[];
  lateShortSen: number;
  advanceSen: number;
  otherDeductions?: PayLine[];
}) {
  const dailyEarningsSen = roundSen(p.ratePerDaySen * p.daysWorked);
  const grossSen =
    dailyEarningsSen + (p.otherEarnings ?? []).reduce((s, l) => s + l.amountSen, 0);
  const totalDeductionsSen =
    p.lateShortSen +
    p.advanceSen +
    (p.otherDeductions ?? []).reduce((s, l) => s + l.amountSen, 0);
  return {
    dailyEarningsSen,
    grossSen,
    totalDeductionsSen,
    netSen: grossSen - totalDeductionsSen,
  };
}

// A finished month for a per-day worker, rebuilt from its stored payslip. The
// payslip keeps basic 0 and no day count, but its pay before the late dock is a
// whole number of days at the day rate, which gives the days back:
//   gross − OT − allowance + late = days × rate.
// "late" is the charge from today's late records; a month generated before
// per-day late docks existed (Aug 2026) charged none, so 0 is tried too. A
// 1 sen gap is allowed for rounding, and the shown late absorbs it so every
// line still adds up to the stored Gross and Net. No fit (a day rate that
// changed since, a penalty in Net) keeps the old card.
export type StoredPayslip = {
  grossSen?: number;
  netSen?: number;
  overtimeSen?: number;
  otHours?: number;
  allowancesSen?: number;
  shortHourDeductionSen?: number;
  lateDays?: LateDay[];
  advanceDeductionSen?: number;
  epfEeSen?: number;
  socsoEeSen?: number;
  eisEeSen?: number;
  taxSen?: number;
};
export function dailyCardFromPayslip(slip: StoredPayslip, rateSen: number, t: Translate) {
  if (rateSen <= 0 || slip.grossSen == null || slip.netSen == null) return null;
  const extrasSen = (slip.overtimeSen ?? 0) + (slip.allowancesSen ?? 0);
  const baseSen = slip.grossSen - extrasSen;
  for (const tryLateSen of [slip.shortHourDeductionSen ?? 0, 0]) {
    const days = Math.round((baseSen + tryLateSen) / rateSen);
    const lateSen = days * rateSen - baseSen;
    if (days < 0 || lateSen < 0 || Math.abs(lateSen - tryLateSen) > 1) continue;
    const props = {
      ratePerDaySen: rateSen,
      daysWorked: days,
      otherEarnings: [
        {
          label: `${t("pay.ot")}${slip.otHours ? ` · ${slip.otHours.toFixed(1)}h` : ""}`,
          amountSen: slip.overtimeSen ?? 0,
        },
        { label: t("pay.allowance"), amountSen: slip.allowancesSen ?? 0 },
      ],
      lateShortSen: lateSen,
      lateDays: lateSen > 0 ? slip.lateDays : [],
      advanceSen: slip.advanceDeductionSen ?? 0,
      otherDeductions: [
        { label: "EPF", amountSen: slip.epfEeSen ?? 0 },
        { label: "SOCSO", amountSen: slip.socsoEeSen ?? 0 },
        { label: "EIS", amountSen: slip.eisEeSen ?? 0 },
        { label: "Tax", amountSen: slip.taxSen ?? 0 },
      ],
    };
    if (computeDailyPay(props).netSen === slip.netSen) return props;
  }
  return null;
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

export default function DailyPayCard(props: DailyPayCardProps) {
  const {
    t,
    periodLabel,
    isEstimate,
    ratePerDaySen,
    daysWorked,
    otherEarnings = [],
    lateShortSen,
    lateDays = [],
    advanceSen,
    otherDeductions = [],
    children,
  } = props;
  const { dailyEarningsSen, grossSen, totalDeductionsSen, netSen } =
    computeDailyPay(props);
  const extraEarnings = otherEarnings.filter((l) => l.amountSen > 0);
  const extraDeductions = otherDeductions.filter((l) => l.amountSen > 0);
  const hasDeductions = totalDeductionsSen > 0;

  return (
    <div className="overflow-hidden rounded-2xl bg-[#1F1D1B] text-white">
      {/* ---- Hero: the one number the worker came for ---- */}
      <div className="px-4 pt-4 pb-5 sm:px-6 sm:pt-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-[#B0AAA3]">
            {t("pay.netPay")} · {periodLabel}
          </p>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              isEstimate
                ? "bg-[#41331A] text-[#E5BE80]"
                : "bg-[#1F3A2B] text-[#9FD3B0]"
            }`}
          >
            {isEstimate ? t("pay.estimate") : t("pay.final")}
          </span>
        </div>
        <p
          className={`mt-1 text-4xl font-bold tracking-tight tabular-nums sm:text-5xl ${
            netSen < 0 ? "text-[#F0A99C]" : ""
          }`}
        >
          {rm(netSen)}
        </p>
        <p className="mt-1 text-xs text-[#8A8680]">
          {t("pay.dailyRateNote").replace("{rate}", rm(ratePerDaySen))}
        </p>
        {children}
      </div>

      {/* ---- 1. Earnings ---- */}
      <Section title={t("pay.earnings")}>
        <Line
          label={t("pay.dailyRateEarnings")
            .replace("{n}", String(daysWorked))
            .replace("{rate}", rm(ratePerDaySen))}
          value={rm(dailyEarningsSen)}
          tone="plus"
        />
        {extraEarnings.map((l) => (
          <Line key={l.label} label={l.label} value={rm(l.amountSen)} tone="plus" />
        ))}
        <Subtotal label={t("pay.gross")} value={rm(grossSen)} />
      </Section>

      {/* ---- 2. Deductions ---- */}
      <Section title={t("pay.deductions")}>
        {!hasDeductions && (
          <p className="text-sm text-[#8A8680]">{t("pay.noDeductions")}</p>
        )}
        {lateShortSen > 0 && (
          <LateShortRow
            label={t("pay.lateShortDeduction")}
            daysLabel={t("common.days")}
            amountSen={lateShortSen}
            days={lateDays}
          />
        )}
        {advanceSen > 0 && (
          <Line label={t("pay.salaryAdvance")} value={`− ${rm(advanceSen)}`} tone="minus" />
        )}
        {extraDeductions.map((l) => (
          <Line key={l.label} label={l.label} value={`− ${rm(l.amountSen)}`} tone="minus" />
        ))}
        {hasDeductions && (
          <Subtotal
            label={t("pay.totalDeductions")}
            value={`− ${rm(totalDeductionsSen)}`}
            minus
          />
        )}
      </Section>

      {/* ---- 3. Summary: the sum, written out ---- */}
      <div className="bg-white/[0.04] px-4 py-4 sm:px-6">
        <div className="space-y-1.5 text-sm">
          <Line label={t("pay.gross")} value={rm(grossSen)} />
          <Line
            label={t("pay.totalDeductions")}
            value={`− ${rm(totalDeductionsSen)}`}
            tone="minus"
          />
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

function Line({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "plus" | "minus";
}) {
  const valueTone =
    tone === "plus" ? "text-[#9FD3B0]" : tone === "minus" ? "text-[#F0A99C]" : "";
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="min-w-0 break-words text-[#E8E4E0]">{label}</span>
      <span className={`shrink-0 font-medium tabular-nums ${valueTone}`}>{value}</span>
    </div>
  );
}

function Subtotal({ label, value, minus }: { label: string; value: string; minus?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-dashed border-white/10 pt-2.5">
      <span className="font-semibold">{label}</span>
      <span
        className={`shrink-0 font-bold tabular-nums ${minus ? "text-[#F0A99C]" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

// Late / short hours: tap to see WHICH days and how long. Plain row when the
// days are not known.
function LateShortRow({
  label,
  daysLabel,
  amountSen,
  days,
}: {
  label: string;
  daysLabel: string;
  amountSen: number;
  days: LateDay[];
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const has = days.length > 0;
  return (
    <div className="-mx-2 rounded-xl bg-[#4A2520]/40 px-2 py-2">
      <button
        type="button"
        disabled={!has}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start justify-between gap-3 text-left disabled:cursor-default"
      >
        <span className="min-w-0 break-words text-[#E8E4E0]">
          {label}
          {has && (
            <span className="ml-1.5 text-xs text-[#B0AAA3]">
              · {days.length} {daysLabel}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1 font-medium tabular-nums text-[#F0A99C]">
          − {rm(amountSen)}
          {has && (
            <ChevronDown
              aria-hidden
              className={`h-4 w-4 text-[#B0AAA3] transition-transform motion-reduce:transition-none ${
                open ? "rotate-180" : ""
              }`}
            />
          )}
        </span>
      </button>
      {has && (
        <div
          id={panelId}
          className={`grid transition-[grid-template-rows] duration-200 motion-reduce:transition-none ${
            open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          }`}
        >
          <ul
            inert={!open}
            aria-label={label}
            className="flex flex-wrap gap-1.5 overflow-hidden"
          >
            {days.map((d) => (
              <li
                key={d.date}
                className="mt-2 inline-flex items-center gap-1 rounded-full bg-[#4A2520] px-2.5 py-1 text-[11px] font-medium tabular-nums text-[#F0A99C]"
              >
                <span className="text-[#E8E4E0]">{fmtDay(d.date)}</span>
                <span className="opacity-60">·</span>
                {fmtDuration(d.hours)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
