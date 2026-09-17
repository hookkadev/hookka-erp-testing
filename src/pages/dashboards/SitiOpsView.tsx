import { useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { useCachedJson } from "@/lib/cached-fetch";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Clock, Factory, CalendarClock, PackageX, DollarSign } from "lucide-react";
import { TAUPE, MUTED, BORDER, fmtN } from "./dashboard-shared-lib";
import { Kpi, LiveBadge } from "./dashboard-shared";

// Siti's report checklist (handed over on paper, 2026-09-17) — a draft tab so
// progress against her list is visible in one place rather than scattered
// across follow-up conversations. Everything here reads the SAME cached
// GET /api/dashboard/prototype feed every other tab reads; the `production`
// and `inventory` slices below carry a few new fields added specifically for
// this list (see dashboard-prototype.ts's "Siti's list" section) — no new
// endpoint. Production Cost is the one item on her list with no wired data
// source yet (needs cost_ledger); it renders as an explicit gap, not a
// guessed number.
type OverdueOrDueSoon = {
  poNo: string | null;
  customer: string | null;
  productName: string | null;
  currentDept: string | null;
  daysToDD: number | null;
};

type Feed = {
  success?: boolean;
  availability?: {
    production?: { live: boolean; reason?: string };
    inventory?: { live: boolean; reason?: string };
  };
  production?: {
    orders: OverdueOrDueSoon[];
    overdueByDept: { department: string; count: number }[];
    dueSoon3Days: OverdueOrDueSoon[];
    dailyOutput: { date: string; orders: number; units: number }[];
    planVsActual: {
      rows: { poNo: string | null; productName: string | null; plan: string; actual: string; varianceDays: number }[];
      onTime: number;
      late: number;
      withBothDates: number;
      completedTotal: number;
    };
  };
  inventory?: {
    materialShortage: { code: string | null; description: string | null; group: string | null; balanceQty: number }[];
  };
};

export function SitiOpsView() {
  const { data, loading, error } = useCachedJson<Feed>("/api/dashboard/prototype");

  const production = data?.production;
  const inventory = data?.inventory;
  const prodLive = data?.availability?.production?.live ?? false;
  const invLive = data?.availability?.inventory?.live ?? false;

  const totalOverdue = useMemo(
    () => (production?.overdueByDept ?? []).reduce((a, d) => a + d.count, 0),
    [production?.overdueByDept],
  );

  const outputChartData = useMemo(
    () => (production?.dailyOutput ?? []).map((d) => ({ date: d.date.slice(5), Units: d.units, Orders: d.orders })),
    [production?.dailyOutput],
  );

  if (loading) {
    return <div className="py-16 text-center text-sm text-[#6B7280]">Loading…</div>;
  }
  if (error || !data?.success) {
    return (
      <Card className="border-[#F0D9AE] bg-[#FDF3E4]">
        <CardContent className="p-4 text-sm text-[#B5701A]">
          Couldn't load Operations: {error ?? "unknown error"}
        </CardContent>
      </Card>
    );
  }

  const pva = production?.planVsActual;

  return (
    <div className="space-y-6 max-md:space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Operations (Siti's list)</h2>
        <LiveBadge live={prodLive && invLive} />
      </div>
      <p className="text-xs text-[#6B7280]">
        Draft — tracking the report checklist handed over on paper. Real data below is wired up;
        the last card (Production Cost) is not built yet, flagged rather than guessed.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        <Kpi
          label="Overdue (all depts)"
          value={fmtN(totalOverdue)}
          sub="past the customer date, still open"
          icon={AlertTriangle}
          iconBgClass="bg-[#FBE7E3]"
          iconColorClass="text-[#9A3A2D]"
          valueColorClass="text-[#9A3A2D]"
        />
        <Kpi
          label="Due within 3 days"
          value={fmtN((production?.dueSoon3Days ?? []).length)}
          sub="not yet overdue"
          icon={Clock}
          iconBgClass="bg-[#FAEFCB]"
          iconColorClass="text-[#9C6F1E]"
          valueColorClass="text-[#9C6F1E]"
        />
        <Kpi
          label="Plan vs Actual — On Time"
          value={pva ? `${pva.onTime} / ${pva.withBothDates}` : "—"}
          sub={pva ? `of ${pva.completedTotal} completed orders judged` : undefined}
          icon={CalendarClock}
          iconBgClass="bg-[#EEF3E4]"
          iconColorClass="text-[#4F7C3A]"
        />
        <Kpi
          label="Material Shortage"
          value={fmtN((inventory?.materialShortage ?? []).length)}
          sub="active items at zero/negative stock"
          icon={PackageX}
          iconBgClass="bg-[#F0ECE9]"
          iconColorClass="text-[#6B5C32]"
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Overdue by department</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-t border-b border-[#E2DDD8]">
                <th className="text-left px-4 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280]">Department</th>
                <th className="text-right px-4 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280]">Overdue orders</th>
              </tr>
            </thead>
            <tbody>
              {(production?.overdueByDept ?? []).map((d) => (
                <tr key={d.department} className="border-b border-[#E2DDD8]">
                  <td className="px-4 py-2 text-[#1F1D1B]">{d.department}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-[#9A3A2D] font-semibold">{fmtN(d.count)}</td>
                </tr>
              ))}
              {(production?.overdueByDept ?? []).length === 0 && (
                <tr><td colSpan={2} className="px-4 py-6 text-center text-[#6B7280]">No overdue orders.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Due within 3 days (early warning)</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto" style={{ maxHeight: 340, overflowY: "auto" }}>
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-t border-b border-[#E2DDD8] sticky top-0 bg-white">
                  {["PO No", "Customer", "Product", "Dept", "Days Left"].map((h) => (
                    <th key={h} className="text-left px-4 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280]">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(production?.dueSoon3Days ?? []).map((o, i) => (
                  <tr key={o.poNo ?? i} className="border-b border-[#E2DDD8]">
                    <td className="px-4 py-2 font-mono text-[#1F1D1B]">{o.poNo ?? "—"}</td>
                    <td className="px-4 py-2 text-[#1F1D1B]">{o.customer ?? "—"}</td>
                    <td className="px-4 py-2 text-[#6B7280]">{o.productName ?? "—"}</td>
                    <td className="px-4 py-2 text-[#6B7280]">{o.currentDept ?? "—"}</td>
                    <td className="px-4 py-2 tabular-nums text-[#9C6F1E] font-semibold">{o.daysToDD}</td>
                  </tr>
                ))}
                {(production?.dueSoon3Days ?? []).length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-[#6B7280]">Nothing due in the next 3 days.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Daily Production Output</CardTitle>
        </CardHeader>
        <CardContent>
          <div style={{ width: "100%", height: 220 }}>
            {outputChartData.length === 0 ? (
              <div className="flex items-center justify-center h-full text-xs text-[#6B7280]">
                No completions in range.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={outputChartData} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: MUTED }} axisLine={{ stroke: BORDER }} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: MUTED }} axisLine={false} tickLine={false} width={32} />
                  <Tooltip contentStyle={{ background: "#FFFFFF", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="Units" fill={TAUPE} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
          <p className="mt-2 text-xs text-[#6B7280]">
            Units completed each day, by production order completion date — whole book, not scoped to the period picker above.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Production Plan vs Actual</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto" style={{ maxHeight: 340, overflowY: "auto" }}>
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-t border-b border-[#E2DDD8] sticky top-0 bg-white">
                  {["PO No", "Product", "Plan (target)", "Actual (completed)", "Variance"].map((h) => (
                    <th key={h} className="text-left px-4 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280]">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(pva?.rows ?? []).slice(0, 100).map((r, i) => (
                  <tr key={r.poNo ?? i} className="border-b border-[#E2DDD8]">
                    <td className="px-4 py-2 font-mono text-[#1F1D1B]">{r.poNo ?? "—"}</td>
                    <td className="px-4 py-2 text-[#6B7280]">{r.productName ?? "—"}</td>
                    <td className="px-4 py-2 tabular-nums text-[#6B7280]">{r.plan}</td>
                    <td className="px-4 py-2 tabular-nums text-[#6B7280]">{r.actual}</td>
                    <td className={`px-4 py-2 tabular-nums font-semibold ${r.varianceDays > 0 ? "text-[#9A3A2D]" : "text-[#4F7C3A]"}`}>
                      {r.varianceDays > 0 ? `+${r.varianceDays}d late` : r.varianceDays === 0 ? "on time" : `${-r.varianceDays}d early`}
                    </td>
                  </tr>
                ))}
                {(pva?.rows ?? []).length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-[#6B7280]">No completed order carries both a target and a completion date.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {pva && (
            <p className="px-4 pb-3 pt-2 text-xs text-[#6B7280]">
              {pva.withBothDates} of {pva.completedTotal} completed orders carry both dates and could be judged;
              the rest are missing one or the other and are not counted as on-time by default.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Material Shortage</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto" style={{ maxHeight: 340, overflowY: "auto" }}>
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-t border-b border-[#E2DDD8] sticky top-0 bg-white">
                  {["Code", "Description", "Group", "Balance Qty"].map((h) => (
                    <th key={h} className="text-left px-4 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280]">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(inventory?.materialShortage ?? []).map((m, i) => (
                  <tr key={m.code ?? i} className="border-b border-[#E2DDD8]">
                    <td className="px-4 py-2 font-mono text-[#1F1D1B]">{m.code ?? "—"}</td>
                    <td className="px-4 py-2 text-[#6B7280]">{m.description ?? "—"}</td>
                    <td className="px-4 py-2 text-[#6B7280]">{m.group ?? "—"}</td>
                    <td className="px-4 py-2 tabular-nums text-[#9A3A2D] font-semibold">{m.balanceQty}</td>
                  </tr>
                ))}
                {(inventory?.materialShortage ?? []).length === 0 && (
                  <tr><td colSpan={4} className="px-4 py-6 text-center text-[#6B7280]">Nothing at zero or negative stock.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="px-4 pb-3 pt-2 text-xs text-[#6B7280]">
            Proxy, not a real reorder-point check: <span className="font-mono">min_stock</span> is 0 on every raw
            material row, so this lists active items sitting at zero/negative balance instead.
          </p>
        </CardContent>
      </Card>

      <Card className="border-[#E5E0D8] bg-[#F7F5F3]">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <DollarSign className="h-4 w-4 text-[#6B7280]" /> Production Cost
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-[#6B7280]">
            Not built yet. This needs <span className="font-mono">cost_ledger</span> data, which nothing in this
            route reads today — everything above comes from data the page already loads. Flagged here rather than
            filled with a guessed number.
          </p>
        </CardContent>
      </Card>

      <p className="text-xs text-[#6B7280] flex items-center gap-1.5">
        <Factory className="h-3.5 w-3.5" /> Efficiency and Attendance are on Siti's list too, but already covered —
        <Badge className="mx-1 bg-[#F0ECE9] text-[#6B5C32] border-[#F0ECE9]">Employees</Badge> tab, in review on a separate branch.
      </p>
    </div>
  );
}
