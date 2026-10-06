// ---------------------------------------------------------------------------
// My KPI on the worker phone app's Me page (DEV-36).
//
// A floor worker can hold the Production time efficiency KPI, scored on one or
// more departments. This shows this month's figure, the target and the points,
// read from GET /api/worker/kpi (the same card builder the office KPI page
// uses). Nothing is shown when the worker holds no KPI.
// ---------------------------------------------------------------------------
import { useEffect, useState } from "react";
import { useT } from "@/lib/worker-i18n";
import { workerFetch } from "@/layouts/WorkerLayout";

type KpiLine = {
  key: string;
  label: string;
  unit: string;
  actual: number | null;
  target: number;
  weight: number;
  points: number | null;
  departments: string[];
};
type KpiData = { period: string; score: number | null; lines: KpiLine[] };

const pct = (v: number | null) => (v === null || !Number.isFinite(v) ? "—" : `${v}%`);

export default function MyKpiCard() {
  const t = useT();
  const [data, setData] = useState<KpiData | null>(null);

  useEffect(() => {
    let alive = true;
    workerFetch("/api/worker/kpi")
      .then((r) => r.json())
      .then((j: { success?: boolean; data?: KpiData }) => {
        if (alive && j.success && j.data) setData(j.data);
      })
      .catch(() => {
        /* no card is the same as no KPI */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!data || data.lines.length === 0) return null;

  return (
    <div className="bg-white rounded-xl p-4 border border-[#D8D2CC] space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">{t("kpi.title")}</p>
        <p className="text-xs text-[#8A8680]">{data.period}</p>
      </div>
      {data.lines.map((l) => (
        <div key={l.key} className="space-y-1.5">
          <p className="text-sm font-medium">
            {l.key === "production_efficiency" ? t("kpi.efficiency") : l.label}
          </p>
          <p className="text-xs text-[#8A8680]">
            {t("kpi.departments")}: {l.departments.length ? l.departments.join(", ") : t("kpi.overall")}
          </p>
          {l.actual === null ? (
            <p className="text-sm text-[#8A8680]">{t("kpi.noData")}</p>
          ) : (
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-[#F7F5F2] py-2">
                <p className="text-lg font-bold tabular-nums">{pct(l.actual)}</p>
                <p className="text-[11px] text-[#8A8680]">{t("kpi.efficiencyShort")}</p>
              </div>
              <div className="rounded-lg bg-[#F7F5F2] py-2">
                <p className="text-lg font-bold tabular-nums">{pct(l.target)}</p>
                <p className="text-[11px] text-[#8A8680]">{t("kpi.target")}</p>
              </div>
              <div className="rounded-lg bg-[#F7F5F2] py-2">
                <p className="text-lg font-bold tabular-nums">
                  {l.points ?? "—"}
                  <span className="text-xs font-normal text-[#8A8680]"> / {l.weight}</span>
                </p>
                <p className="text-[11px] text-[#8A8680]">{t("kpi.points")}</p>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
