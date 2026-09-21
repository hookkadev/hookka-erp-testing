import { useMemo, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { Search } from "lucide-react";
import { TAUPE, RED, AMBER, MUTED, BORDER } from "./dashboard-shared-lib";

// Overdue / due-soon cards, extracted from SitiOpsView so the Daily (Lim) tab
// shows the identical cards rather than a second derivation. Both read
// production.overdueByDept / production.dueSoon3Days from the shared feed.
export type ProdOrderSummary = {
  poNo: string | null;
  customer: string | null;
  productName: string | null;
  currentDept: string | null;
  daysToDD: number | null;
  stagesDone: number;
  stagesTotal: number;
};

const DEPT_ALL_TAB: TabItem<string>[] = [{ key: "ALL", label: "All" }];

function urgencyPill(daysLeft: number | null) {
  if (daysLeft == null) return { label: "—", bg: "#F0ECE9", fg: "#6B5C32" };
  if (daysLeft <= 1) return { label: daysLeft <= 0 ? "Overdue/1 Day" : "1 Day", bg: "#FBE7E3", fg: "#9A3A2D" };
  return { label: `${daysLeft} Days`, bg: "#FAEFCB", fg: "#9C6F1E" };
}

export function OverdueByDeptCard({ overdueByDept }: { overdueByDept: { department: string; count: number }[] }) {
  const deptChartData = useMemo(() => [...overdueByDept].sort((a, b) => a.count - b.count), [overdueByDept]);
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Overdue by department</CardTitle>
      </CardHeader>
      <CardContent>
        <div style={{ width: "100%", height: Math.max(160, deptChartData.length * 34) }}>
          {deptChartData.length === 0 ? (
            <div className="flex items-center justify-center h-full text-xs text-[#6B7280]">No overdue orders.</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={deptChartData} layout="vertical" margin={{ top: 4, right: 20, bottom: 0, left: 4 }}>
                <XAxis type="number" tick={{ fontSize: 10, fill: MUTED }} axisLine={false} tickLine={false} allowDecimals={false} />
                <YAxis type="category" dataKey="department" width={90} tick={{ fontSize: 11, fill: "#1F1D1B" }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ background: "#FFFFFF", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12 }} />
                <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                  {deptChartData.map((d) => (
                    <Cell key={d.department} fill={d.count >= 10 ? RED : d.count >= 4 ? AMBER : TAUPE} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// The due-within-3-days early warning list, filterable by department and
// free-text search over PO/customer/product.
export function DueSoonWorklist({ orders }: { orders: ProdOrderSummary[] }) {
  const [deptFilter, setDeptFilter] = useState("ALL");
  const [search, setSearch] = useState("");

  const dueSoonDepts = useMemo(
    () => [...new Set(orders.map((o) => o.currentDept || "(no dept)"))].sort(),
    [orders],
  );
  const worklistTabs: TabItem<string>[] = useMemo(
    () => [...DEPT_ALL_TAB, ...dueSoonDepts.map((d) => ({ key: d, label: d }))],
    [dueSoonDepts],
  );
  const worklistRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders
      .filter((o) => deptFilter === "ALL" || (o.currentDept || "(no dept)") === deptFilter)
      .filter((o) => !q || [o.poNo, o.customer, o.productName].some((v) => (v ?? "").toLowerCase().includes(q)))
      .sort((a, b) => (a.daysToDD ?? 0) - (b.daysToDD ?? 0));
  }, [orders, deptFilter, search]);

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-3 flex-wrap">
        <CardTitle>Due within 3 Days — Early Warning Worklist</CardTitle>
        <div className="relative w-full max-w-[220px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#9CA3AF]" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search PO, customer, product…"
            className="h-8 pl-8 text-xs"
          />
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="px-4 pb-3">
          <Tabs tabs={worklistTabs} value={deptFilter} onChange={setDeptFilter} variant="pill" />
        </div>
        <div className="overflow-x-auto" style={{ maxHeight: 420, overflowY: "auto" }}>
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-t border-b border-[#E2DDD8] sticky top-0 bg-white">
                {["PO Number", "Customer", "Product Description", "Department", "Urgency / Days Left"].map((h) => (
                  <th key={h} className="text-left px-3 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280]">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {worklistRows.map((o, i) => {
                const pill = urgencyPill(o.daysToDD);
                return (
                  <tr key={o.poNo ?? i} className="border-b border-[#E2DDD8]">
                    <td className="px-3 py-2 font-mono text-[#1F1D1B] whitespace-nowrap">{o.poNo ?? "—"}</td>
                    <td className="px-3 py-2 text-[#1F1D1B]">{o.customer ?? "—"}</td>
                    <td className="px-3 py-2 text-[#6B7280]">{o.productName ?? "—"}</td>
                    <td className="px-3 py-2 text-[#6B7280] whitespace-nowrap">{o.currentDept ?? "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span
                        className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
                        style={{ background: pill.bg, color: pill.fg }}
                      >
                        {pill.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {worklistRows.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-[#6B7280]">Nothing matches this filter.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
