// DEV-31 "Today's departments" card — shared by the worker home screen and the
// dept-QR scan result. Data is GET /api/worker/today `deptDay` (also returned
// by POST /api/worker/dept-scan): live split while the punch is open, the saved
// Working Hours rows once punched out.

export type DeptDayRow = {
  departmentCode: string;
  name: string;
  category: string | null;
  hours: number;
};

export type DeptDay = {
  clockedIn: boolean;
  final: boolean;
  current: {
    departmentCode: string;
    name: string;
    category: string | null;
    since: string;
    scanned: boolean;
  } | null;
  rows: DeptDayRow[];
  hoursSoFar: number;
};

const catLabel = (c: string | null) =>
  c ? ` · ${c.charAt(0)}${c.slice(1).toLowerCase()}` : "";

const fmtHours = (h: number) => {
  const m = Math.round(h * 60);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

export function DeptDayCard({
  day,
  t,
}: {
  day: DeptDay | null | undefined;
  t: (id: string) => string;
}) {
  if (!day?.clockedIn) return null;
  // Punched out but no saved rows (the autofill is best-effort) → nothing to show.
  if (day.final && day.rows.length === 0) return null;
  const cur = day.current;
  const isCur = (r: DeptDayRow) =>
    !day.final &&
    !!cur &&
    r.departmentCode === cur.departmentCode &&
    (r.category ?? null) === (cur.category ?? null);

  return (
    <div className="bg-white rounded-xl p-4 border border-[#D8D2CC] space-y-3">
      {day.final ? (
        <p className="text-xs text-[#8A8680] font-medium">{t("dept.savedTitle")}</p>
      ) : (
        cur && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[#8A8680]">
              {t("dept.youAreIn")}
            </p>
            <p className="text-lg font-extrabold text-[#6B5C32] leading-tight">
              {cur.name}
              {catLabel(cur.category)}
            </p>
            <p className="text-xs text-[#5A5550]">
              {t("dept.since")} {cur.since} (
              {cur.scanned ? t("dept.scanned") : t("dept.homeDefault")})
            </p>
          </div>
        )
      )}

      {day.rows.length > 0 && (
        <div className={`space-y-1.5 ${day.final ? "" : "border-t border-[#EAE6DF] pt-2"}`}>
          {day.rows.map((r) => (
            <div
              key={`${r.departmentCode}|${r.category ?? ""}`}
              className={`flex justify-between gap-2 text-sm tabular-nums ${
                isCur(r) ? "font-bold text-[#1F1D1B]" : "text-[#3D3A36]"
              }`}
            >
              <span className="min-w-0 truncate">
                {r.name}
                {catLabel(r.category)}
              </span>
              <span>{fmtHours(r.hours)}</span>
            </div>
          ))}
        </div>
      )}

      {!day.final && (
        <>
          {/* Hours worked only — no "of 9h" target or progress bar (owner
              2026-10-01: it reads as pressure to hit 9h). */}
          <div className="flex justify-between text-xs text-[#5A5550] tabular-nums border-t border-[#EAE6DF] pt-2">
            <span>{t("dept.soFar")}</span>
            <span className="font-semibold">{fmtHours(day.hoursSoFar)}</span>
          </div>
          <p className="text-[11px] text-[#8A8680]">
            {cur?.scanned ? t("dept.liveNote") : t("dept.scanHint")}
          </p>
        </>
      )}
    </div>
  );
}
