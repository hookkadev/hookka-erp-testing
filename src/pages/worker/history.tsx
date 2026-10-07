// ============================================================
// /worker/history — Daily attendance (mobile)
//
// Per-day punch records for one MONTH: working hours, production hours,
// efficiency, clock in/out, OT, late, and the department split. Moved here
// from the bottom of the Pay page (owner 2026-10-05) so it has its own tab
// right after Home.
// ============================================================
import { useEffect, useState } from "react";
import { useT } from "@/lib/worker-i18n";
import { workerFetch } from "@/layouts/WorkerLayout";

// ---------- helpers ----------
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
// The current month in Malaysia time, then the 11 before it, newest first.
function last12Months(): string[] {
  const now = new Date(Date.now() + 8 * 3600000);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(y, m - i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

// ---------- types ----------
type Translate = (key: string) => string;
type DeptHours = { name: string; category: string | null; hours: number };
type DailyRow = {
  date: string;
  workingMinutes: number;
  productionMinutes: number;
  /** DEV-31: the day's Working Hours rows by department (office-grid split). */
  deptHours: DeptHours[];
  /** Production Hours: the day's hours in production departments only. */
  prodDeptMinutes?: number;
};
type AttRow = {
  date: string;
  clockIn: string | null;
  clockOut: string | null;
  overtimeMinutes: number;
  lateMinutes: number;
};
type MonthHistory = { daily: DailyRow[]; attendance: AttRow[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object";
}
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asMonthHistory(v: unknown): MonthHistory | null {
  if (!isRecord(v) || !isRecord(v.data)) return null;
  const d = v.data;
  if (!Array.isArray(d.daily) || !Array.isArray(d.attendance)) return null;
  const daily = d.daily
    .map((r) =>
      isRecord(r) && typeof r.date === "string"
        ? {
            date: r.date,
            workingMinutes: asNumber(r.workingMinutes) ?? 0,
            productionMinutes: asNumber(r.productionMinutes) ?? 0,
            deptHours: (Array.isArray(r.deptHours) ? r.deptHours : [])
              .map((x) =>
                isRecord(x) && typeof x.name === "string"
                  ? {
                      name: x.name,
                      category: typeof x.category === "string" ? x.category : null,
                      hours: asNumber(x.hours) ?? 0,
                    }
                  : null,
              )
              .filter((x): x is DeptHours => !!x && x.hours > 0),
          }
        : null,
    )
    .filter((x): x is DailyRow => !!x);
  const attendance = d.attendance
    .map((r) =>
      isRecord(r) && typeof r.date === "string"
        ? {
            date: r.date,
            clockIn: typeof r.clockIn === "string" ? r.clockIn : null,
            clockOut: typeof r.clockOut === "string" ? r.clockOut : null,
            overtimeMinutes: asNumber(r.overtimeMinutes) ?? 0,
            lateMinutes: asNumber(r.lateMinutes) ?? 0,
          }
        : null,
    )
    .filter((x): x is AttRow => !!x);
  return { daily, attendance };
}

// ============================================================
export default function WorkerHistoryPage() {
  const t = useT();
  const [months] = useState(last12Months);
  const [period, setPeriod] = useState(months[0]);
  const [hist, setHist] = useState<MonthHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
      try {
        const [yy, mm] = period.split("-").map(Number);
        const last = new Date(yy, mm, 0).getDate();
        const res = await workerFetch(
          `/api/worker/history?from=${period}-01&to=${period}-${String(last).padStart(2, "0")}`,
        );
        const j = asMonthHistory(await res.json());
        if (!cancelled) {
          setHist(j);
          setError(!j);
        }
      } catch {
        if (!cancelled) {
          setHist(null);
          setError(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [period]);

  return (
    <div className="space-y-4 pt-2">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">{t("nav.history")}</h1>
        <select
          aria-label="Month"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="h-9 shrink-0 rounded-lg border border-[#D8D2CC] bg-white px-3 text-sm font-semibold tabular-nums text-[#1F1D1B]"
        >
          {months.map((p, i) => (
            <option key={p} value={p}>
              {monthLabel(p)}
              {i === 0 ? " · now" : ""}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="pt-8 text-center text-[#5A5550]">{t("common.loading")}</div>
      ) : error ? (
        <div className="pt-8 text-center text-[#9A3A2D]">{t("common.error")}</div>
      ) : hist && hist.daily.length > 0 ? (
        <DailyAttendanceCard hist={hist} t={t} />
      ) : (
        <div className="bg-white rounded-xl p-6 text-center text-sm text-[#8A8680] border border-[#D8D2CC]">
          —
        </div>
      )}
    </div>
  );
}

// Per-day table: Date / Working / Production / Std duration / Eff%, with the punch line
// (in → out · OT · Late) under any day that has a punch — identical facts to
// the office Working Hours + Attendance views.
function DailyAttendanceCard({ hist, t }: { hist: MonthHistory; t: Translate }) {
  const mins2hrs = (m: number) => (m / 60).toFixed(1);
  return (
    <div className="bg-white rounded-xl border border-[#D8D2CC] overflow-hidden">
      <div className="bg-[#1F2A3C] px-4 py-2.5">
        <p className="text-[11px] font-bold uppercase tracking-wider text-white">
          {t("pay.dailyAttendance")}
        </p>
      </div>
      <div className="px-4 pb-2">
        <div className="grid grid-cols-[auto_1fr_1fr_1fr_1fr] gap-2 py-2 text-[10px] font-semibold uppercase tracking-wide text-[#8A8680] border-b border-[#E5E0DB]">
          <span>{t("pay.colDate")}</span>
          <span className="text-right">{t("home.colWorkingHrs")}</span>
          <span className="text-right">{t("home.colProductionHrs")}</span>
          <span className="text-right">{t("home.colStdDuration")}</span>
          <span className="text-right">{t("home.efficiencyPct")}</span>
        </div>
        {hist.daily.map((r) => {
          // Same formula as the Home tiles: Standard Production Duration ÷
          // Production Hours (production departments only).
          const prodHrsMins = r.prodDeptMinutes ?? 0;
          const eff =
            prodHrsMins > 0
              ? Math.round((r.productionMinutes / prodHrsMins) * 100)
              : null;
          const effTone =
            eff == null
              ? "text-[#9CA3AF]"
              : eff >= 80
                ? "text-[#2A6B4A]"
                : eff >= 60
                  ? "text-[#9C6F1E]"
                  : "text-[#9A3A2D]";
          const att = hist.attendance.find(
            (a) => a.date === r.date && (a.clockIn || a.clockOut),
          );
          return (
            <div key={r.date} className="py-2.5 border-b border-[#F0ECE9] last:border-b-0">
              <div className="grid grid-cols-[auto_1fr_1fr_1fr_1fr] gap-2 text-sm items-center">
                <span className="font-medium text-[#1F1D1B]">{fmtDay(r.date)}</span>
                <span className="tabular-nums text-right font-semibold">
                  {mins2hrs(r.workingMinutes)}
                </span>
                <span className="tabular-nums text-right font-semibold">
                  {mins2hrs(prodHrsMins)}
                </span>
                <span className="tabular-nums text-right font-semibold text-[#3E6570]">
                  {mins2hrs(r.productionMinutes)}
                </span>
                <span className={`tabular-nums text-right font-semibold ${effTone}`}>
                  {eff == null ? "—" : `${eff}%`}
                </span>
              </div>
              {att && (
                <p className="mt-1 text-xs text-[#8A8680] tabular-nums">
                  {att.clockIn ?? "—"} → {att.clockOut ?? "—"}
                  {att.overtimeMinutes > 0 && (
                    <span className="text-[#3E6570] font-medium">
                      {" "}· OT {mins2hrs(att.overtimeMinutes)}h
                    </span>
                  )}
                  {(att.lateMinutes ?? 0) > 0 && (
                    <span className="text-[#9A3A2D] font-medium">
                      {" "}· {t("home.lateBy")} {att.lateMinutes}m
                    </span>
                  )}
                </p>
              )}
              {r.deptHours.length > 0 && (
                <p className="mt-0.5 text-xs text-[#6B5C32] tabular-nums">
                  {r.deptHours
                    .map(
                      (d) =>
                        `${d.name}${
                          d.category
                            ? ` · ${d.category.charAt(0)}${d.category.slice(1).toLowerCase()}`
                            : ""
                        } ${d.hours.toFixed(2)}h`,
                    )
                    .join("  ·  ")}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
