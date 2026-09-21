import { useMemo, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { useCachedJson } from "@/lib/cached-fetch";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AlertTriangle, CircleDot, Wrench, CheckCircle2, XCircle, FilePlus2, Search } from "lucide-react";
import {
  TAUPE, TEAL, RED, AMBER, GREEN, MUTED, BORDER, CHART_GOLD, fmtN,
  inPeriod, inFocus, dayLabel, periodLabel, type Period, type ServiceSub,
} from "./dashboard-shared-lib";
import { Kpi, LiveBadge } from "./dashboard-shared";
import { ServiceApprovalsPanel } from "./ServiceApprovalsPanel";
import { ServiceIssuesPanel } from "./ServiceIssuesPanel";
import { causeKeys, causeLabel } from "../../api/lib/service-issue-stats";

// "Service (Zamri)" tab: service-case report, overdue tracking, and the
// approvals queue. Reads the `service` slice of the same cached
// GET /api/dashboard/prototype feed (built in api/lib/dashboard-service-slice.ts).
// The slice is OPTIONAL: a feed cached before this tab shipped, or a caller
// without service-cases:read, has no `service` key and must not crash the tab.
type ServiceCase = {
  id: string;
  caseNo: string | null;
  customer: string | null;
  status: string;
  createdDate: string;
  closedDate: string | null;
  issue: string;
  approvalKind: string | null;
  approvalStatus: string | null;
  ageDays: number | null;
  daysOverdue: number;
  // Added with the Top issues sub-tab — absent on a feed cached before it shipped.
  causes?: string[];
  unit?: string | null;
  prevention?: string | null;
  products?: string[];
};
type Feed = {
  success?: boolean;
  availability?: { service?: { live: boolean; reason?: string } };
  service?: { overdueAfterDays: number; cases: ServiceCase[] } | null;
};

const STATUS_STYLE: Record<string, { bg: string; fg: string }> = {
  OPEN: { bg: "#FAEFCB", fg: "#9C6F1E" },
  IN_PROGRESS: { bg: "#E6F0F3", fg: "#3E6570" },
  CLOSED: { bg: "#EEF3E4", fg: "#4F7C3A" },
  CANCELLED: { bg: "#F0ECE9", fg: "#6B7280" },
};
const statusLabel = (s: string) => s.replace("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

function StatusPill({ status }: { status: string }) {
  const st = STATUS_STYLE[status] ?? STATUS_STYLE.CANCELLED;
  return (
    <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: st.bg, color: st.fg }}>
      {statusLabel(status)}
    </span>
  );
}

const APPROVAL_STYLE: Record<string, string> = { PENDING: "#9C6F1E", APPROVED: "#4F7C3A", REJECTED: "#9A3A2D" };

export function ServiceView({
  period, sub, onPeriodChange, onSubChange,
}: { period: Period; sub: ServiceSub; onPeriodChange: (p: Period) => void; onSubChange: (s: ServiceSub) => void }) {
  const { data, loading, error } = useCachedJson<Feed>("/api/dashboard/prototype");
  const [search, setSearch] = useState("");
  // Root-cause key clicked on Top issues; narrows the Report's case list only.
  const [causeFilter, setCauseFilter] = useState<string | null>(null);

  const slice = data?.service ?? null;
  const cases = useMemo(() => slice?.cases ?? [], [slice]);
  const threshold = slice?.overdueAfterDays ?? 3;

  // Cases logged inside the focused window (a clicked day narrows it).
  const logged = useMemo(() => cases.filter((c) => inFocus(period, c.createdDate)), [cases, period]);
  const count = (st: string) => logged.filter((c) => c.status === st).length;

  // Monthly/range: a bar per day. YTD: a bar per month (click opens the month).
  const chart = useMemo(() => {
    const ytd = period.mode === "ytd";
    const m = new Map<string, { iso: string; date: string; New: number; Closed: number }>();
    const bump = (iso: string, k: "New" | "Closed") => {
      const key = ytd ? iso.slice(0, 7) : iso;
      const cur = m.get(key) ?? { iso: key, date: ytd ? key : key.slice(5), New: 0, Closed: 0 };
      cur[k] += 1;
      m.set(key, cur);
    };
    for (const c of cases) {
      if (inPeriod(period, c.createdDate)) bump(c.createdDate, "New");
      if (c.status === "CLOSED" && c.closedDate && inPeriod(period, c.closedDate)) bump(c.closedDate, "Closed");
    }
    return [...m.values()].sort((a, b) => (a.iso < b.iso ? -1 : 1));
  }, [cases, period]);

  const pick = (e: { activeLabel?: unknown } | null) => {
    const hit = chart.find((d) => d.date === e?.activeLabel);
    if (!hit) return;
    if (period.mode === "ytd") onPeriodChange({ mode: "monthly", month: hit.iso });
    else onPeriodChange({ ...period, day: period.day === hit.iso ? undefined : hit.iso });
  };
  const dayLine = period.day && period.mode !== "ytd" ? period.day.slice(5) : null;

  const listRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return logged
      .filter((c) => !causeFilter || causeKeys(c).includes(causeFilter))
      .filter((c) => !q || [c.caseNo, c.customer, c.issue].some((v) => (v ?? "").toLowerCase().includes(q)))
      .sort((a, b) => (a.createdDate < b.createdDate ? 1 : -1));
  }, [logged, search, causeFilter]);

  // Overdue is a live backlog, not a period slice: a case stuck for 20 days is
  // overdue whichever month is selected.
  const overdue = useMemo(
    () => cases.filter((c) => c.daysOverdue > 0).sort((a, b) => b.daysOverdue - a.daysOverdue),
    [cases],
  );
  const pendingApprovals = cases.filter((c) => c.approvalStatus === "PENDING").length;

  if (loading) return <div className="py-16 text-center text-sm text-[#6B7280]">Loading…</div>;
  if (error || !data?.success) {
    return (
      <Card className="border-[#F0D9AE] bg-[#FDF3E4]">
        <CardContent className="p-4 text-sm text-[#B5701A]">Couldn't load Service: {error ?? "unknown error"}</CardContent>
      </Card>
    );
  }
  if (!slice) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-[#6B7280]">
          Service data isn't available: {data.availability?.service?.reason ?? "the feed has no service section yet (try again in a minute)."}
        </CardContent>
      </Card>
    );
  }

  const ageNote = `Age = whole days since the case was logged (created date), while it is still Open or In progress. Overdue = more than ${threshold} days.`;

  return (
    <div className="space-y-5 max-md:space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Service (Zamri)</h2>
        <LiveBadge live={data.availability?.service?.live ?? false} />
        {period.day && (
          <button
            type="button"
            onClick={() => onPeriodChange({ ...period, day: undefined })}
            className="text-xs rounded-md border border-[#E5E0D8] bg-[#F7F5F3] px-2 py-0.5 text-[#6B5C32] hover:bg-white"
          >
            Showing: {dayLabel(period.day)} — click to go back
          </button>
        )}
      </div>

      {sub === "overview" && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
            <Kpi label="New cases" value={fmtN(logged.length)} sub={`logged, ${periodLabel(period)}`} icon={FilePlus2} iconBgClass="bg-[#F0ECE9]" iconColorClass="text-[#6B5C32]" />
            <Kpi label="Open" value={fmtN(count("OPEN"))} sub="of those logged" icon={CircleDot} iconBgClass="bg-[#FAEFCB]" iconColorClass="text-[#9C6F1E]" valueColorClass="text-[#9C6F1E]" />
            <Kpi label="In progress" value={fmtN(count("IN_PROGRESS"))} sub="of those logged" icon={Wrench} iconBgClass="bg-[#E6F0F3]" iconColorClass="text-[#3E6570]" valueColorClass="text-[#3E6570]" />
            <Kpi label="Closed" value={fmtN(count("CLOSED"))} sub="of those logged" icon={CheckCircle2} iconBgClass="bg-[#EEF3E4]" iconColorClass="text-[#4F7C3A]" valueColorClass="text-[#4F7C3A]" />
            <Kpi label="Cancelled" value={fmtN(count("CANCELLED"))} sub="of those logged" icon={XCircle} iconBgClass="bg-[#F0ECE9]" iconColorClass="text-[#6B7280]" />
            <Kpi label="Overdue now" value={fmtN(overdue.length)} sub={`open > ${threshold} days, all time`} icon={AlertTriangle} iconBgClass="bg-[#FBE7E3]" iconColorClass="text-[#9A3A2D]" valueColorClass="text-[#9A3A2D]" />
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Cases logged vs closed — {period.mode === "ytd" ? "by month" : "by day"}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="select-none [&_*]:outline-none" style={{ width: "100%", height: 220 }}>
                {chart.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-xs text-[#6B7280]">No service cases in this period.</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chart} margin={{ top: 8, right: 12, bottom: 0, left: -8 }} onClick={pick} style={{ cursor: "pointer" }}>
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: MUTED }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: MUTED }} axisLine={false} tickLine={false} allowDecimals={false} />
                      <Tooltip contentStyle={{ background: "#FFFFFF", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12 }} />
                      {dayLine && <ReferenceLine x={dayLine} stroke={RED} strokeDasharray="3 3" />}
                      <Bar dataKey="New" fill={TAUPE} radius={[3, 3, 0, 0]} />
                      <Bar dataKey="Closed" fill={CHART_GOLD} radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between gap-3 flex-wrap">
              <CardTitle>Service cases logged ({fmtN(listRows.length)})</CardTitle>
              {causeFilter && (
                <button
                  type="button"
                  onClick={() => setCauseFilter(null)}
                  className="text-xs rounded-md border border-[#E5E0D8] bg-[#F7F5F3] px-2 py-0.5 text-[#6B5C32] hover:bg-white"
                >
                  Showing: {causeLabel(causeFilter)} — click to go back
                </button>
              )}
              <div className="relative w-full max-w-[220px]">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#9CA3AF]" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search case, customer, issue…" className="h-8 pl-8 text-xs" />
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto" style={{ maxHeight: 420, overflowY: "auto" }}>
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="border-t border-b border-[#E2DDD8] sticky top-0 bg-white">
                      {["Case", "Customer", "Issue", "Logged", "Status", "Approval"].map((h) => (
                        <th key={h} className="text-left px-3 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280]">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {listRows.map((c) => (
                      <tr key={c.id} className="border-b border-[#E2DDD8]">
                        <td className="px-3 py-2 font-mono text-[#1F1D1B] whitespace-nowrap">{c.caseNo ?? "—"}</td>
                        <td className="px-3 py-2 text-[#1F1D1B]">{c.customer ?? "—"}</td>
                        <td className="px-3 py-2 text-[#6B7280] max-w-[320px] truncate">{c.issue || "—"}</td>
                        <td className="px-3 py-2 text-[#6B7280] whitespace-nowrap">{dayLabel(c.createdDate)}</td>
                        <td className="px-3 py-2 whitespace-nowrap"><StatusPill status={c.status} /></td>
                        <td className="px-3 py-2 whitespace-nowrap text-[11.5px] font-semibold" style={{ color: APPROVAL_STYLE[c.approvalStatus ?? ""] ?? MUTED }}>
                          {c.approvalStatus ? statusLabel(c.approvalStatus) : "—"}
                        </td>
                      </tr>
                    ))}
                    {listRows.length === 0 && (
                      <tr><td colSpan={6} className="px-4 py-6 text-center text-[#6B7280]">No cases match.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {sub === "overdue" && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Kpi label="Overdue cases" value={fmtN(overdue.length)} sub={`open > ${threshold} days`} icon={AlertTriangle} iconBgClass="bg-[#FBE7E3]" iconColorClass="text-[#9A3A2D]" valueColorClass="text-[#9A3A2D]" />
            <Kpi label="Worst" value={overdue[0] ? `${overdue[0].daysOverdue} d` : "—"} sub={overdue[0]?.caseNo ?? undefined} icon={Wrench} iconBgClass="bg-[#FAEFCB]" iconColorClass="text-[#9C6F1E]" valueColorClass="text-[#9C6F1E]" />
            <Kpi label="Pending approvals" value={fmtN(pendingApprovals)} sub="cases waiting for a decision" icon={CircleDot} iconBgClass="bg-[#E6F0F3]" iconColorClass="text-[#3E6570]" valueColorClass="text-[#3E6570]" />
          </div>
          <Card>
            <CardHeader className="pb-1">
              <CardTitle>Overdue service cases, worst first</CardTitle>
              <p className="text-xs text-[#6B7280]">{ageNote} A live backlog: the period picker does not filter it.</p>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto" style={{ maxHeight: 520, overflowY: "auto" }}>
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="border-t border-b border-[#E2DDD8] sticky top-0 bg-white">
                      {["Case", "Customer", "Issue", "Logged", "Status", "Age", "Days overdue"].map((h) => (
                        <th key={h} className="text-left px-3 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280]">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {overdue.map((c) => (
                      <tr key={c.id} className="border-b border-[#E2DDD8]">
                        <td className="px-3 py-2 font-mono text-[#1F1D1B] whitespace-nowrap">{c.caseNo ?? "—"}</td>
                        <td className="px-3 py-2 text-[#1F1D1B]">{c.customer ?? "—"}</td>
                        <td className="px-3 py-2 text-[#6B7280] max-w-[300px] truncate">{c.issue || "—"}</td>
                        <td className="px-3 py-2 text-[#6B7280] whitespace-nowrap">{dayLabel(c.createdDate)}</td>
                        <td className="px-3 py-2 whitespace-nowrap"><StatusPill status={c.status} /></td>
                        <td className="px-3 py-2 tabular-nums text-[#6B7280]">{c.ageDays} d</td>
                        <td className="px-3 py-2 tabular-nums font-semibold" style={{ color: c.daysOverdue >= 7 ? RED : c.daysOverdue >= 3 ? AMBER : TEAL }}>
                          +{c.daysOverdue} d
                        </td>
                      </tr>
                    ))}
                    {overdue.length === 0 && (
                      <tr><td colSpan={7} className="px-4 py-6 text-center" style={{ color: GREEN }}>No overdue service cases.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {sub === "approvals" && <ServiceApprovalsPanel />}

      {sub === "issues" && (
        <ServiceIssuesPanel
          cases={logged}
          period={period}
          onPickCause={(k) => { setCauseFilter(k); onSubChange("overview"); }}
        />
      )}
    </div>
  );
}
