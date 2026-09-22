import { useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { TAUPE, TEAL, AMBER, GREEN, MUTED, BORDER, CHART_GOLD, fmtN, type Period } from "./dashboard-shared-lib";
import {
  NONE_KEY, byCause, topCauses, byUnit, byPrevention, topProducts, causeTrend, causeLabel,
  type IssueCase, type TallyRow,
} from "../../api/lib/service-issue-stats";

// "Top issues" sub-tab of the Service tab: which root cause / unit /
// product is most common. Cases arrive already filtered to the period picker.
// Definitions live in api/lib/service-issue-stats.ts (shared with the tests).
// Every field is optional on old cached feeds — a case without them is simply
// "not yet analysed".

export function TallyList({
  rows, total, onPick, empty,
}: { rows: TallyRow[]; total: number; onPick?: (key: string) => void; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (total === 0) return <div className="py-6 text-center text-xs text-[#6B7280]">{empty}</div>;
  return (
    <div className="select-none [&_*]:outline-none max-md:overflow-x-auto">
      <div className="max-md:min-w-[440px] grid grid-cols-[minmax(110px,1.2fr)_2fr_44px_50px_44px_60px] gap-2 px-1 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[#6B7280]">
        <span>Issue</span><span /><span className="text-right">Cases</span><span className="text-right">% cases</span>
        <span className="text-right">Open</span><span className="text-right">Avg close</span>
      </div>
      {rows.map((r) => {
        const none = r.key === NONE_KEY;
        const colour = none ? AMBER : TAUPE;
        return (
          <div
            key={r.key}
            role={onPick ? "button" : undefined}
            onClick={onPick ? () => onPick(r.key) : undefined}
            className={`max-md:min-w-[440px] grid grid-cols-[minmax(110px,1.2fr)_2fr_44px_50px_44px_60px] gap-2 items-center px-1 py-1.5 max-md:py-2.5 border-t border-[#E2DDD8] text-[12.5px] ${onPick ? "cursor-pointer hover:bg-[#F7F5F3]" : ""}`}
          >
            <span className="truncate font-medium" style={{ color: none ? AMBER : "#1F1D1B" }}>{r.label}</span>
            <span className="h-3 rounded-sm bg-[#F0ECE9]">
              <span className="block h-3 rounded-sm" style={{ width: `${(r.count / max) * 100}%`, background: colour }} />
            </span>
            <span className="text-right tabular-nums font-semibold text-[#1F1D1B]">{fmtN(r.count)}</span>
            <span className="text-right tabular-nums text-[#6B7280]">{r.pct}%</span>
            <span className="text-right tabular-nums text-[#6B7280]">{fmtN(r.open)}</span>
            <span className="text-right tabular-nums text-[#6B7280]">{r.avgCloseDays === null ? "—" : `${r.avgCloseDays} d`}</span>
          </div>
        );
      })}
    </div>
  );
}

const TREND_COLOURS = [TAUPE, TEAL, CHART_GOLD];

export function ServiceIssuesPanel({
  cases, period, onPickCause, causeOnly,
}: { cases: IssueCase[]; period: Period; onPickCause: (key: string) => void; causeOnly?: boolean }) {
  const causes = useMemo(() => byCause(cases), [cases]);
  const units = useMemo(() => byUnit(cases), [cases]);
  const prevention = useMemo(() => byPrevention(cases), [cases]);
  const products = useMemo(() => topProducts(cases, 10), [cases]);
  const top3 = useMemo(() => topCauses(causes, 3), [causes]);
  const ytd = period.mode === "ytd";
  const trend = useMemo(
    () => causeTrend(cases, top3.map((r) => r.key), (d) => (ytd ? d.slice(0, 7) : d.slice(5))),
    [cases, top3, ytd],
  );
  const unanalysed = causes.find((r) => r.key === NONE_KEY)?.count ?? 0;
  const maxProd = Math.max(1, ...products.map((p) => p.count));

  return (
    <div className="space-y-5 max-md:space-y-4">
      <Card>
        <CardHeader className="pb-1">
          <CardTitle>Issues by root cause ({fmtN(cases.length)} cases)</CardTitle>
          <p className="text-xs text-[#6B7280]">
            Cases logged in the selected period. A case with several root causes counts once under each, so rows can add up to
            more than the total. Avg close = average days from logged to closed, closed cases only. Click a row to list those cases.
          </p>
          {cases.length > 0 && (
            <p className="text-xs font-semibold" style={{ color: unanalysed ? AMBER : GREEN }}>
              {unanalysed
                ? `${fmtN(unanalysed)} of ${fmtN(cases.length)} cases (${Math.round((unanalysed / cases.length) * 100)}%) have no root cause recorded yet.`
                : "Every case in this period has a root cause recorded."}
            </p>
          )}
        </CardHeader>
        <CardContent>
          <TallyList rows={causes} total={cases.length} onPick={onPickCause} empty="No service cases in this period." />
        </CardContent>
      </Card>

      {!causeOnly && <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 max-md:gap-4">
        <Card>
          <CardHeader className="pb-1"><CardTitle>By responsible unit</CardTitle></CardHeader>
          <CardContent><TallyList rows={units} total={cases.length} empty="No service cases in this period." /></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardTitle>Prevention status</CardTitle></CardHeader>
          <CardContent><TallyList rows={prevention} total={cases.length} empty="No service cases in this period." /></CardContent>
        </Card>
      </div>}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 max-md:gap-4">
        {!causeOnly && <Card>
          <CardHeader className="pb-1">
            <CardTitle>Most affected products (top 10)</CardTitle>
            <p className="text-xs text-[#6B7280]">Cases that list the product as affected; a product counts once per case.</p>
          </CardHeader>
          <CardContent>
            {products.length === 0 ? (
              <div className="py-6 text-center text-xs text-[#6B7280]">No affected products recorded in this period.</div>
            ) : (
              products.map((p) => (
                <div key={p.label} className="grid grid-cols-[minmax(120px,2fr)_1.2fr_36px] gap-2 items-center py-1.5 border-t border-[#E2DDD8] text-[12.5px]">
                  <span className="truncate text-[#1F1D1B]" title={p.label}>{p.label}</span>
                  <span className="h-3 rounded-sm bg-[#F0ECE9]">
                    <span className="block h-3 rounded-sm" style={{ width: `${(p.count / maxProd) * 100}%`, background: TAUPE }} />
                  </span>
                  <span className="text-right tabular-nums font-semibold">{fmtN(p.count)}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>}

        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Top 3 causes — {ytd ? "by month" : "by day"}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="select-none [&_*]:outline-none" style={{ width: "100%", height: 240 }}>
              {top3.length === 0 ? (
                <div className="flex items-center justify-center h-full text-xs text-[#6B7280]">No analysed cases in this period.</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trend} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
                    <XAxis dataKey="bucket" tick={{ fontSize: 10, fill: MUTED }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: MUTED }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip contentStyle={{ background: "#FFFFFF", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {top3.map((r, i) => (
                      <Line key={r.key} type="monotone" dataKey={r.key} name={causeLabel(r.key)} stroke={TREND_COLOURS[i]} strokeWidth={2} dot={{ r: 2 }} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
