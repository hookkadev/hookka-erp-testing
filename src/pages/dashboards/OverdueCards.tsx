import { Fragment, useMemo, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { Search } from "lucide-react";
import { RED, AMBER, BORDER, fmtN } from "./dashboard-shared-lib";
import { deptName } from "./ops-floor-lib";

// Due-soon worklist (Operations > Overview). Reads production.dueSoon3Days
// from the shared feed. The per-department overdue counts moved into the
// Department Status board (DashboardWidgets.tsx → DeptBacklogCard).
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

// Urgency lanes. The feed only sends daysToDD 0–3 (dashboard-prototype.ts
// filters 0 <= daysToDD <= 3). Red for today / tomorrow, amber for 2–3 days —
// the same split the urgency pill has always used.
const LANES = [
  { d: 0, label: "Due today", tone: RED },
  { d: 1, label: "Tomorrow", tone: RED },
  { d: 2, label: "In 2 days", tone: AMBER },
  { d: 3, label: "In 3 days", tone: AMBER },
] as const;
const laneLabel = (d: number | null) => LANES.find((l) => l.d === d)?.label ?? "No date";

function urgencyPill(daysLeft: number | null) {
  if (daysLeft == null) return { label: "—", bg: "#F0ECE9", fg: "#6B5C32" };
  if (daysLeft <= 1) return { label: daysLeft <= 0 ? "Today" : "1 Day", bg: "#FBE7E3", fg: "#9A3A2D" };
  return { label: `${daysLeft} Days`, bg: "#FAEFCB", fg: "#9C6F1E" };
}

// The due-within-3-days early warning list: lane tiles (click to narrow),
// filterable by department and free-text search over PO/customer/product.
export function DueSoonWorklist({ orders }: { orders: ProdOrderSummary[] }) {
  const [deptFilter, setDeptFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [lane, setLane] = useState<number | null>(null);

  const dueSoonDepts = useMemo(
    () => [...new Set(orders.map((o) => o.currentDept || "(no dept)"))].sort(),
    [orders],
  );
  const worklistTabs: TabItem<string>[] = useMemo(
    () => [...DEPT_ALL_TAB, ...dueSoonDepts.map((d) => ({ key: d, label: deptName(d) }))],
    [dueSoonDepts],
  );
  // Dept + search narrow everything; the lane tiles count that slice, and
  // a selected lane narrows only the table.
  const baseRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders
      .filter((o) => deptFilter === "ALL" || (o.currentDept || "(no dept)") === deptFilter)
      .filter((o) => !q || [o.poNo, o.customer, o.productName].some((v) => (v ?? "").toLowerCase().includes(q)))
      .sort((a, b) => (a.daysToDD ?? 0) - (b.daysToDD ?? 0));
  }, [orders, deptFilter, search]);
  const laneCounts = useMemo(() => {
    const m = new Map<number | null, number>();
    for (const o of baseRows) m.set(o.daysToDD, (m.get(o.daysToDD) ?? 0) + 1);
    return m;
  }, [baseRows]);
  const worklistRows = lane == null ? baseRows : baseRows.filter((o) => o.daysToDD === lane);

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-3 flex-wrap">
        <CardTitle>Due within 3 Days — Early Warning Worklist</CardTitle>
        <div className="relative w-full max-w-[220px] max-md:max-w-none">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#9CA3AF]" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search PO, customer, product…"
            className="h-8 max-md:h-10 pl-8 text-xs max-md:text-sm"
          />
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid grid-cols-4 gap-2 px-4 pb-3">
          {LANES.map((l) => {
            const n = laneCounts.get(l.d) ?? 0;
            const on = lane === l.d;
            return (
              <button
                key={l.d}
                type="button"
                aria-pressed={on}
                onClick={() => setLane(on ? null : l.d)}
                className={`min-w-0 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                  on ? "border-[#C9BFAF] bg-[#F7F4EF]" : "border-[#E2DDD8] bg-white hover:bg-[#FBFAF8]"
                }`}
                style={{ borderTop: `3px solid ${n ? l.tone : BORDER}` }}
              >
                <span className="block text-xl font-bold leading-tight text-[#1F1D1B]">{fmtN(n)}</span>
                <span className="block truncate text-[10.5px] text-[#6B7280]">{l.label}</span>
              </button>
            );
          })}
        </div>
        <div className="px-4 pb-3">
          <Tabs tabs={worklistTabs} value={deptFilter} onChange={setDeptFilter} variant="pill" scrollable />
        </div>
        <div className="overflow-x-auto" style={{ maxHeight: 420, overflowY: "auto" }}>
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="*:sticky *:top-0 *:z-10 *:bg-white *:shadow-[inset_0_1px_0_#E2DDD8,inset_0_-1px_0_#E2DDD8]">
                {["PO Number", "Customer", "Product Description", "Department", "Urgency / Days Left"].map((h) => (
                  <th key={h} className="text-left px-3 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280]">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {worklistRows.map((o, i) => {
                const pill = urgencyPill(o.daysToDD);
                const laneStart = i === 0 || worklistRows[i - 1].daysToDD !== o.daysToDD;
                return (
                  <Fragment key={o.poNo ?? i}>
                    {laneStart && (
                      <tr className="border-b border-[#E2DDD8] bg-[#FBFAF8]">
                        <td colSpan={5} className="px-3 py-1.5 text-[11px] font-semibold text-[#5A5550]">
                          {laneLabel(o.daysToDD)} · {fmtN(laneCounts.get(o.daysToDD) ?? 0)}
                        </td>
                      </tr>
                    )}
                    <tr className="border-b border-[#E2DDD8]">
                      <td className="px-3 py-2 font-mono text-[#1F1D1B] whitespace-nowrap">{o.poNo ?? "—"}</td>
                      <td className="px-3 py-2 text-[#1F1D1B]">{o.customer ?? "—"}</td>
                      <td className="px-3 py-2 text-[#6B7280]">{o.productName ?? "—"}</td>
                      <td className="px-3 py-2 text-[#6B7280] whitespace-nowrap">{o.currentDept ? deptName(o.currentDept) : "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
                          style={{ background: pill.bg, color: pill.fg }}
                        >
                          {pill.label}
                        </span>
                      </td>
                    </tr>
                  </Fragment>
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
