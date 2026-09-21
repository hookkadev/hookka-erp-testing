// Service tab — phone port of the desktop ServiceView and its three panels
// (ServicePerformancePanel, ServiceIssuesPanel, ServiceApprovalsPanel). Same
// `service` slice of the shared dashboard feed, same pure maths
// (api/lib/service-issue-stats.ts), phone layout. Sub-tab lives in `?sub=`.
//
// Changed vs desktop: two-series charts are split into two single-series cards
// (MChartCard is single-series), the "Top 3 causes" line chart is one small bar
// card per cause, and long case lists show 50 rows until "Show all" is tapped.
//
// Approvals is a REAL write path. Endpoints, bodies, the approve confirm step,
// the reject-needs-a-reason rule and the cache invalidation are the desktop
// panel's, unchanged; only the result message moved from a toast to inline
// (there is no ToastProvider under /m).
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useCachedJson, invalidateCache } from "@/lib/cached-fetch";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  AMBER, GREEN, RED, TEAL, dayLabel, fmtN, inFocus, inPeriod, periodLabel, previousPeriod, type Period,
} from "../../../../dashboards/dashboard-shared-lib";
import {
  NONE_KEY, agingSplit, avgClose, byCause, byPrevention, byUnit, causeKeys, causeLabel, causeTrend,
  closeTrend, openedVsClosed, preventionNotDone, topProducts, type TallyRow,
} from "../../../../../api/lib/service-issue-stats";
import { ListRow, MobileCard, StatusPill } from "../../../components";
import { resolveStatus, SERVICE_CASE_STATUS_MAP } from "../../../config/helpers";
import { M, M_ACCENT, M_DELTA, titleCaseStatus } from "../../../theme";
import { tapBucket } from "../dashboard-m-lib";
import { useDashboardSub } from "../hooks";
import { MChartCard, MFocusChip, MKpi, MKpiGrid, MRankList, MSection, MState, MSubPills, type MRankItem } from "../primitives";
import { DASHBOARD_FEED_URL, type DashboardTabProps } from "../types";

// Mirrors ServiceView's Feed/ServiceCase. Newer fields are optional: a payload
// cached before they shipped must still render.
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
  causes?: string[];
  unit?: string | null;
  prevention?: string | null;
  products?: string[];
  preventionOwner?: string | null;
  preventionAction?: string;
};
type Feed = {
  success?: boolean;
  availability?: { service?: { live: boolean; reason?: string } };
  service?: { overdueAfterDays: number; cases: ServiceCase[] } | null;
};

const OPEN = new Set(["OPEN", "IN_PROGRESS"]);
const APPROVAL_COLOUR: Record<string, string> = { PENDING: AMBER, APPROVED: GREEN, REJECTED: RED };
const ROW_CAP = 50;
// MChartCard's Y axis allows fractional ticks; case counts are whole numbers.
const wholeAxis = (v: number) => (Number.isInteger(v) ? String(v) : "");

function Note({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 12, color: M.muted, margin: "0 4px 10px", lineHeight: 1.45 }}>{children}</div>;
}

/** Edge-to-edge row card; shows ROW_CAP rows until the user asks for all. */
function CappedCard<T>({ rows, row, empty }: { rows: T[]; row: (r: T) => ReactNode; empty: ReactNode }) {
  const [all, setAll] = useState(false);
  if (rows.length === 0) return <MobileCard>{empty}</MobileCard>;
  return (
    <MobileCard padded={false} radius={16} style={{ overflow: "hidden" }}>
      {(all ? rows : rows.slice(0, ROW_CAP)).map(row)}
      {rows.length > ROW_CAP && !all ? (
        <button
          type="button"
          onClick={() => setAll(true)}
          style={{ width: "100%", minHeight: 44, border: "none", background: "transparent", color: M.taupe, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
        >
          Show all {fmtN(rows.length)}
        </button>
      ) : null}
    </MobileCard>
  );
}

function CasePill({ c }: { c: ServiceCase }) {
  const st = resolveStatus(c.status, SERVICE_CASE_STATUS_MAP);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <StatusPill style={st.style} label={st.label} size="sm" />
      {c.approvalStatus ? (
        <span style={{ fontSize: 11.5, fontWeight: 600, color: APPROVAL_COLOUR[c.approvalStatus] ?? M.muted }}>
          Approval: {titleCaseStatus(c.approvalStatus)}
        </span>
      ) : null}
    </div>
  );
}

const age = (c: ServiceCase) => (c.ageDays == null ? "—" : `${c.ageDays} d`);

// ---- Opened vs closed (Report + Performance share it) --------------------

type FlowPoint = { iso: string; date: string; opened: number; closed: number };

function useFlow(cases: ServiceCase[], period: Period): FlowPoint[] {
  return useMemo(() => {
    const ytd = period.mode === "ytd";
    return openedVsClosed(cases, (d) => inPeriod(period, d), (d) => (ytd ? d.slice(0, 7) : d)).map((r) => ({
      iso: r.bucket, date: ytd ? r.bucket : r.bucket.slice(5), opened: r.opened, closed: r.closed,
    }));
  }, [cases, period]);
}

function FlowCharts({ flow, period, setPeriod, openedTitle }: {
  flow: FlowPoint[]; period: Period; setPeriod: (p: Period) => void; openedTitle: string;
}) {
  const ytd = period.mode === "ytd";
  const by = ytd ? "by month" : "by day";
  const selectedKey = flow.find((d) => d.iso === period.day)?.date ?? null;
  const onSelect = (k: string) => setPeriod(tapBucket(period, flow, k));
  const sum = (k: "opened" | "closed") => fmtN(flow.reduce((n, d) => n + d[k], 0));
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <MChartCard
        title={`${openedTitle} ${by}`}
        subtitle={`${periodLabel(period)} · ${sum("opened")} in period · tap a bar to ${ytd ? "open that month" : "focus that day"}`}
        data={flow.map((d) => ({ key: d.date, value: d.opened }))}
        selectedKey={selectedKey}
        onSelect={onSelect}
        formatAxis={wholeAxis}
        emptyText="No service cases in this period."
        footer={period.day ? <MFocusChip label={dayLabel(period.day)} onClear={() => setPeriod({ ...period, day: undefined })} /> : undefined}
      />
      <MChartCard
        title={`Closed ${by}`}
        subtitle={`${sum("closed")} closed in period, by closing date`}
        data={flow.map((d) => ({ key: d.date, value: d.closed }))}
        selectedKey={selectedKey}
        onSelect={onSelect}
        formatAxis={wholeAxis}
        height={150}
        emptyText="No service cases in this period."
      />
    </div>
  );
}

// ---- Report (sub "overview") ---------------------------------------------

function Report({ cases, threshold, period, setPeriod, search, setSearch, causeFilter, clearCause }: {
  cases: ServiceCase[]; threshold: number; period: Period; setPeriod: (p: Period) => void;
  search: string; setSearch: (s: string) => void; causeFilter: string | null; clearCause: () => void;
}) {
  const logged = useMemo(() => cases.filter((c) => inFocus(period, c.createdDate)), [cases, period]);
  const flow = useFlow(cases, period);
  const overdueNow = useMemo(() => cases.filter((c) => c.daysOverdue > 0).length, [cases]);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return logged
      .filter((c) => !causeFilter || causeKeys(c).includes(causeFilter))
      .filter((c) => !q || [c.caseNo, c.customer, c.issue].some((v) => (v ?? "").toLowerCase().includes(q)))
      .sort((a, b) => (a.createdDate < b.createdDate ? 1 : -1));
  }, [logged, search, causeFilter]);
  const count = (st: string) => fmtN(logged.filter((c) => c.status === st).length);

  return (
    <>
      <MKpiGrid>
        <MKpi label="New cases" value={fmtN(logged.length)} sub={`logged, ${periodLabel(period)}`} tone={M.taupe} />
        <MKpi label="Open" value={count("OPEN")} sub="of those logged" tone={AMBER} />
        <MKpi label="In progress" value={count("IN_PROGRESS")} sub="of those logged" tone={TEAL} />
        <MKpi label="Closed" value={count("CLOSED")} sub="of those logged" tone={GREEN} />
        <MKpi label="Cancelled" value={count("CANCELLED")} sub="of those logged" />
        <MKpi label="Overdue now" value={fmtN(overdueNow)} sub={`open > ${threshold} days, all time`} tone={RED} />
      </MKpiGrid>

      <MSection title="Cases logged vs closed">
        <FlowCharts flow={flow} period={period} setPeriod={setPeriod} openedTitle="New cases" />
      </MSection>

      <MSection title="Service cases logged" hint={`${fmtN(rows.length)} cases`}>
        <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
          {causeFilter ? <div><MFocusChip label={causeLabel(causeFilter)} onClear={clearCause} /></div> : null}
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search case, customer, issue…"
            aria-label="Search service cases"
            style={{
              width: "100%", boxSizing: "border-box", minHeight: 44, padding: "0 12px", borderRadius: 12,
              border: `1px solid ${M.border}`, background: M.card, color: M.raisin, fontSize: 16, fontFamily: "inherit", outline: "none",
            }}
          />
        </div>
        <CappedCard
          rows={rows}
          empty={<MState kind="empty" text="No cases match." />}
          row={(c) => (
            <ListRow
              key={c.id}
              code={c.caseNo ?? "—"}
              title={c.customer ?? "—"}
              subLine={c.issue || "—"}
              pill={<CasePill c={c} />}
              meta={[{ label: "Logged", value: dayLabel(c.createdDate) }, { label: "Age", value: age(c) }]}
            />
          )}
        />
      </MSection>
    </>
  );
}

// ---- Top issues (sub "issues"; cause-only inside Performance) -------------

const tallyItems = (rows: TallyRow[], total: number, onPick: ((key: string) => void) | null): MRankItem[] =>
  total === 0 ? [] : rows.map((r) => ({
    key: r.key,
    label: r.label,
    value: r.count,
    valueLabel: fmtN(r.count),
    sub: `${r.pct}% of cases · ${fmtN(r.open)} open · avg close ${r.avgCloseDays === null ? "—" : `${r.avgCloseDays} d`}`,
    onClick: onPick ? () => onPick(r.key) : undefined,
  }));

function Issues({ cases, period, onPickCause, causeOnly }: {
  cases: ServiceCase[]; period: Period; onPickCause: ((key: string) => void) | null; causeOnly: boolean;
}) {
  const ytd = period.mode === "ytd";
  const causes = useMemo(() => byCause(cases), [cases]);
  const units = useMemo(() => byUnit(cases), [cases]);
  const prevention = useMemo(() => byPrevention(cases), [cases]);
  const products = useMemo(() => topProducts(cases, 10), [cases]);
  const top3 = useMemo(() => causes.filter((r) => r.key !== NONE_KEY && r.count > 0).slice(0, 3), [causes]);
  const trend = useMemo(
    () => causeTrend(cases, top3.map((r) => r.key), (d) => (ytd ? d.slice(0, 7) : d.slice(5))),
    [cases, top3, ytd],
  );
  const unanalysed = causes.find((r) => r.key === NONE_KEY)?.count ?? 0;
  const empty = "No service cases in this period.";

  return (
    <>
      <MSection title="Issues by root cause" hint={`${fmtN(cases.length)} cases`}>
        <Note>
          Cases logged in the selected period. A case with several root causes counts once under each, so rows can add up to
          more than the total. Avg close = average days from logged to closed, closed cases only.
          {onPickCause ? " Tap a row to list those cases." : ""}
        </Note>
        {cases.length > 0 ? (
          <div style={{ fontSize: 12, fontWeight: 600, color: unanalysed ? AMBER : GREEN, margin: "0 4px 10px" }}>
            {unanalysed
              ? `${fmtN(unanalysed)} of ${fmtN(cases.length)} cases (${Math.round((unanalysed / cases.length) * 100)}%) have no root cause recorded yet.`
              : "Every case in this period has a root cause recorded."}
          </div>
        ) : null}
        <MRankList items={tallyItems(causes, cases.length, onPickCause)} valueHeading="Cases" emptyText={empty} />
      </MSection>

      {causeOnly ? null : (
        <>
          <MSection title="By responsible unit">
            <MRankList items={tallyItems(units, cases.length, null)} valueHeading="Cases" emptyText={empty} />
          </MSection>
          <MSection title="Prevention status">
            <MRankList items={tallyItems(prevention, cases.length, null)} valueHeading="Cases" emptyText={empty} />
          </MSection>
          <MSection title="Most affected products" hint="top 10">
            <Note>Cases that list the product as affected; a product counts once per case.</Note>
            <MRankList
              items={products.map((p) => ({ key: p.label, label: p.label, value: p.count, valueLabel: fmtN(p.count) }))}
              valueHeading="Cases"
              emptyText="No affected products recorded in this period."
            />
          </MSection>
        </>
      )}

      <MSection title="Top 3 causes" hint={ytd ? "by month" : "by day"}>
        {top3.length === 0 ? (
          <MobileCard><MState kind="empty" text="No analysed cases in this period." /></MobileCard>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {top3.map((r) => (
              <MChartCard
                key={r.key}
                title={causeLabel(r.key)}
                subtitle={`${fmtN(r.count)} cases · ${r.pct}% of cases`}
                data={trend.map((t) => ({ key: String(t.bucket), value: Number(t[r.key]) }))}
                formatAxis={wholeAxis}
                height={120}
              />
            ))}
          </div>
        )}
      </MSection>
    </>
  );
}

// ---- Performance ----------------------------------------------------------

function closeDelta(cur: number | null, prev: number | null) {
  if (cur === null || prev === null) return null;
  const d = Math.round((cur - prev) * 10) / 10;
  // Fewer days to close is better.
  return { text: `${d > 0 ? "+" : ""}${d} d vs previous period (${prev} d)`, good: d === 0 ? null : d < 0 };
}

function Performance({ cases, threshold, period, setPeriod }: {
  cases: ServiceCase[]; threshold: number; period: Period; setPeriod: (p: Period) => void;
}) {
  const ytd = period.mode === "ytd";
  const closedNow = useMemo(() => cases.filter((c) => c.status === "CLOSED" && inFocus(period, c.closedDate)), [cases, period]);
  // Same month list as the desktop panel: first case month .. selected month.
  const closedPrev = useMemo(() => {
    if (period.day || !period.month) return [];
    const first = cases.reduce((m, c) => (c.createdDate < m ? c.createdDate : m), period.month + "-01").slice(0, 7);
    const months: string[] = [];
    for (let y = Number(first.slice(0, 4)), m = Number(first.slice(5)); `${y}-${String(m).padStart(2, "0")}` <= period.month; m === 12 ? (y++, (m = 1)) : m++) {
      months.push(`${y}-${String(m).padStart(2, "0")}`);
    }
    const prev = previousPeriod(period, months);
    return prev ? cases.filter((c) => c.status === "CLOSED" && inPeriod(prev, c.closedDate)) : [];
  }, [cases, period]);
  const closeNow = avgClose(closedNow);
  const closePrev = avgClose(closedPrev);
  const dl = closeDelta(closeNow.avg, closePrev.n ? closePrev.avg : null);
  const trend = useMemo(
    () => closeTrend(cases.filter((c) => c.status === "CLOSED" && inPeriod(period, c.closedDate)), (d) => (ytd ? d.slice(0, 7) : d)),
    [cases, period, ytd],
  );
  const open = useMemo(() => cases.filter((c) => OPEN.has(c.status)), [cases]);
  const openedInFocus = useMemo(() => cases.filter((c) => inFocus(period, c.createdDate)), [cases, period]);
  const flow = useFlow(cases, period);
  const aging = useMemo(() => agingSplit(open, threshold), [open, threshold]);
  const agingMax = Math.max(1, ...aging.map((a) => a.count));
  const prevention = useMemo(() => byPrevention(openedInFocus), [openedInFocus]);
  const notDone = useMemo(() => preventionNotDone(openedInFocus), [openedInFocus]);
  const win = period.day ? "that day" : periodLabel(period);
  const wide: CSSProperties = { gridColumn: "1 / -1" };

  return (
    <>
      <MKpiGrid>
        <div style={wide}>
          <MKpi
            label="Avg case closing"
            value={closeNow.avg === null ? "—" : `${closeNow.avg} d`}
            tone={dl?.good == null ? undefined : dl.good ? M_DELTA.up : M_DELTA.down}
            sub={`${fmtN(closeNow.n)} closed · ${dl ? dl.text : "no previous-period comparison"}`}
          />
        </div>
        <MKpi label="Opened in period" value={fmtN(openedInFocus.length)} sub={win} tone={M.taupe} />
        <MKpi label="Closed in period" value={fmtN(closedNow.length)} sub={win} tone={GREEN} />
        <div style={wide}>
          <MKpi
            label="Open cases now"
            value={fmtN(open.length)}
            tone={AMBER}
            sub={`${fmtN(open.filter((c) => c.daysOverdue > 0).length)} overdue (> ${threshold} d)`}
          />
        </div>
      </MKpiGrid>

      <MSection title="Average case closing">
        <Note>
          Average whole days from the case being logged to it being closed, over cases closed in {win}
          {period.day ? " (no previous-period comparison for a single day)" : ""}. The trend groups by closing {ytd ? "month" : "day"}.
        </Note>
        <MChartCard
          title={`Avg days to close ${ytd ? "by month" : "by day"}`}
          subtitle={`${fmtN(trend.reduce((n, t) => n + t.closed, 0))} cases closed in ${periodLabel({ ...period, day: undefined })}`}
          data={trend.map((t) => ({ key: ytd ? t.bucket : t.bucket.slice(5), value: t.avg ?? 0 }))}
          formatAxis={(v) => `${v} d`}
          emptyText="No cases closed in this period."
        />
      </MSection>

      <MSection title="Opened vs closed">
        <Note>
          Open = status Open or In progress, right now (not limited to the period). Opened = logged in the period, Closed = closed
          in the period. Age = whole days since logged; overdue threshold is {threshold} days.
        </Note>
        <FlowCharts flow={flow} period={period} setPeriod={setPeriod} openedTitle="Opened" />
      </MSection>

      <MSection title="Aging of open cases" hint={`${fmtN(open.length)} open now`}>
        <MobileCard radius={16}>
          {aging.map((a, i) => (
            <div key={a.label} style={{ display: "grid", gridTemplateColumns: "84px 1fr 36px", gap: 8, alignItems: "center", padding: "7px 0", fontSize: 13 }}>
              <span style={{ color: M.raisin }}>{a.label}</span>
              <span style={{ height: 10, borderRadius: 3, background: M.divider, overflow: "hidden" }}>
                <span style={{ display: "block", height: "100%", width: `${(a.count / agingMax) * 100}%`, background: i === 0 ? GREEN : i === 1 ? AMBER : RED }} />
              </span>
              <span style={{ textAlign: "right", fontWeight: 700, color: M.raisin, fontVariantNumeric: "tabular-nums" }}>{fmtN(a.count)}</span>
            </div>
          ))}
        </MobileCard>
      </MSection>

      <Issues cases={openedInFocus} period={period} onPickCause={null} causeOnly />

      <MSection title="Prevention">
        <Note>
          Cases logged in {win}. The list below is prevention not yet done (Planned, In progress, or none recorded on a case that
          has a root cause or is closed), oldest first. Days open = age while open, else days to close. Cancelled cases are left
          out. No prevention due date is recorded on service cases, so overdue-prevention cannot be shown.
        </Note>
        <MRankList items={tallyItems(prevention, openedInFocus.length, null)} valueHeading="Cases" emptyText="No service cases in this period." />
      </MSection>

      <MSection title="Prevention not done" hint={`${fmtN(notDone.length)} cases`}>
        <CappedCard
          rows={notDone}
          empty={<MState kind="empty" text="No cases with outstanding prevention in this period." />}
          row={(c) => (
            <ListRow
              key={c.id}
              code={c.caseNo ?? c.id}
              title={c.customer ?? "—"}
              subLine={c.causes?.length ? c.causes.map(causeLabel).join(", ") : "Root cause not yet analysed"}
              pill={
                <div style={{ fontSize: 12, color: TEAL }}>
                  {c.prevention === "IN_PROGRESS" ? "In progress" : c.prevention === "PENDING" ? "Planned" : "None recorded"}
                  {c.preventionOwner ? ` · ${c.preventionOwner}` : ""}
                  {c.preventionAction ? <div style={{ color: M.muted, marginTop: 2 }}>{c.preventionAction}</div> : null}
                </div>
              }
              meta={[{ label: "Days open", value: c.daysOpen ?? "—" }]}
            />
          )}
        />
      </MSection>
    </>
  );
}

// ---- Overdue --------------------------------------------------------------

function Overdue({ cases, threshold }: { cases: ServiceCase[]; threshold: number }) {
  // A live backlog, not a period slice: a case stuck for 20 days is overdue
  // whichever month is selected.
  const overdue = useMemo(
    () => cases.filter((c) => c.daysOverdue > 0).sort((a, b) => b.daysOverdue - a.daysOverdue),
    [cases],
  );
  const pending = cases.filter((c) => c.approvalStatus === "PENDING").length;

  return (
    <>
      <MKpiGrid>
        <MKpi label="Overdue cases" value={fmtN(overdue.length)} sub={`open > ${threshold} days`} tone={RED} />
        <MKpi label="Worst" value={overdue[0] ? `${overdue[0].daysOverdue} d` : "—"} sub={overdue[0]?.caseNo ?? undefined} tone={AMBER} />
        <div style={{ gridColumn: "1 / -1" }}>
          <MKpi label="Pending approvals" value={fmtN(pending)} sub="cases waiting for a decision" tone={TEAL} />
        </div>
      </MKpiGrid>

      <MSection title="Overdue cases, worst first" hint={`${fmtN(overdue.length)} cases`}>
        <Note>
          Age = whole days since the case was logged (created date), while it is still Open or In progress. Overdue = more
          than {threshold} days. A live backlog: the period picker does not filter it.
        </Note>
        <CappedCard
          rows={overdue}
          empty={<div style={{ padding: "20px 0", textAlign: "center", fontSize: 13, color: GREEN }}>No overdue service cases.</div>}
          row={(c) => (
            <ListRow
              key={c.id}
              code={c.caseNo ?? "—"}
              title={c.customer ?? "—"}
              subLine={`${c.issue || "—"} · logged ${dayLabel(c.createdDate)}`}
              pill={<CasePill c={c} />}
              meta={[
                { label: "Age", value: age(c) },
                {
                  label: "Overdue",
                  value: <span style={{ color: c.daysOverdue >= 7 ? RED : c.daysOverdue >= 3 ? AMBER : TEAL }}>+{c.daysOverdue} d</span>,
                },
              ]}
            />
          )}
        />
      </MSection>
    </>
  );
}

// ---- Approvals (write path — see the header comment) ----------------------

type Pending = {
  id: string;
  caseNo: string | null;
  customerName: string | null;
  issue: string;
  caseStatus: string;
  kind: "EXCHANGE" | "GENERAL" | null;
  requestedAt: string | null;
  note: string | null;
};

const APPROVALS_URL = "/api/service-cases/approvals";
const KIND_LABEL = { EXCHANGE: "1-to-1 exchange", GENERAL: "Case approval" } as const;

const actionButton = (primary: boolean, disabled: boolean): CSSProperties => ({
  width: "100%", minHeight: 44, borderRadius: 12, fontSize: 14, fontWeight: 700, fontFamily: "inherit",
  border: `1px solid ${primary ? M.taupe : M.border}`, background: primary ? M.taupe : M.card, color: primary ? "#fff" : M.raisin,
  opacity: disabled ? 0.5 : 1, cursor: disabled ? "default" : "pointer", WebkitTapHighlightColor: "transparent",
});

function Banner({ ok, children }: { ok: boolean; children: ReactNode }) {
  const c = ok ? M_ACCENT.moss : M_ACCENT.danger;
  return (
    <div role={ok ? "status" : "alert"} style={{ padding: "10px 12px", borderRadius: 12, background: c.bg, color: c.fg, fontSize: 13, fontWeight: 600 }}>
      {children}
    </div>
  );
}

function Approvals() {
  // ttl 0: an approval queue must never be served stale.
  const { data, loading, error, refresh } = useCachedJson<{ success?: boolean; data?: Pending[] }>(APPROVALS_URL, 0);
  const { confirm } = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  // Inline stand-in for the desktop toast. A decided row leaves the list, so
  // success shows above the list; a failure shows inside the row it belongs to.
  const [done, setDone] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; text: string } | null>(null);

  const rows = data?.data ?? [];

  async function decide(row: Pending, decision: "approve" | "reject") {
    const label = row.caseNo ?? row.id;
    if (decision === "approve") {
      const ok = await confirm({
        title: "Approve",
        message: `Approve ${row.kind ? KIND_LABEL[row.kind].toLowerCase() : "request"} for case ${label}? This lets it proceed.`,
        confirmLabel: "Approve",
      });
      if (!ok) return;
    }
    setBusy(row.id);
    setDone(null);
    setFailed(null);
    try {
      const res = await fetch(`/api/service-cases/${encodeURIComponent(row.id)}/approval/${decision}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(decision === "reject" ? { note: reason.trim() } : {}),
      });
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || !body.success) throw new Error(body.error ?? `Request failed (${res.status})`);
      setDone(decision === "approve" ? `Approved ${label}` : `Rejected ${label}`);
      setRejecting(null);
      setReason("");
      invalidateCache(APPROVALS_URL);
      invalidateCache(DASHBOARD_FEED_URL);
      refresh();
    } catch (e) {
      setFailed({ id: row.id, text: e instanceof Error ? e.message : "Could not save the decision" });
    } finally {
      setBusy(null);
    }
  }

  const inFlight = busy !== null;

  return (
    <MSection title="Pending approvals" hint={loading || error ? undefined : `${fmtN(rows.length)} waiting`}>
      <Note>Service cases waiting for an approve / reject decision. A live queue: the period picker does not filter it.</Note>
      <div style={{ display: "grid", gap: 10 }}>
        {done ? <Banner ok>{done}</Banner> : null}
        {loading ? (
          <MState kind="loading" />
        ) : error ? (
          <MState kind="error" text={`Couldn't load approvals: ${error}`} />
        ) : rows.length === 0 ? (
          <MobileCard><MState kind="empty" text="Nothing is waiting for approval." /></MobileCard>
        ) : (
          rows.map((r) => (
            <MobileCard key={r.id} radius={16}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ color: M.taupe, fontSize: 12, fontWeight: 700, fontVariantNumeric: "tabular-nums", letterSpacing: 0.2 }}>
                  {r.caseNo ?? r.id}
                </span>
                <span style={{ padding: "1px 8px", borderRadius: 9999, fontSize: 11, fontWeight: 600, background: M_ACCENT.warning.bg, color: M_ACCENT.warning.fg }}>
                  {r.kind ? KIND_LABEL[r.kind] : "Approval"}
                </span>
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: M.raisin, marginTop: 2 }}>{r.customerName ?? "—"}</div>
              {r.issue ? <div style={{ fontSize: 12.5, color: M.muted, marginTop: 3 }}>{r.issue}</div> : null}
              {r.note ? <div style={{ fontSize: 12.5, color: M.muted, marginTop: 3, fontStyle: "italic" }}>Note: {r.note}</div> : null}
              {r.requestedAt ? <div style={{ fontSize: 11, color: M.muted, marginTop: 3 }}>Requested {r.requestedAt.slice(0, 10)}</div> : null}

              <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
                {failed?.id === r.id ? <Banner ok={false}>{failed.text}</Banner> : null}
                <button type="button" disabled={inFlight} onClick={() => decide(r, "approve")} style={actionButton(true, inFlight)}>
                  {busy === r.id ? "Saving…" : "Approve"}
                </button>
                <button
                  type="button"
                  disabled={inFlight}
                  onClick={() => { setRejecting(rejecting === r.id ? null : r.id); setReason(""); }}
                  style={actionButton(false, inFlight)}
                >
                  {rejecting === r.id ? "Cancel reject" : "Reject"}
                </button>
                {rejecting === r.id ? (
                  <>
                    <textarea
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Reason for rejecting (required)"
                      aria-label={`Reason for rejecting ${r.caseNo ?? r.id}`}
                      rows={3}
                      disabled={inFlight}
                      style={{
                        width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 12, resize: "vertical",
                        border: `1px solid ${M.border}`, background: M.paper, color: M.raisin, fontSize: 16, fontFamily: "inherit", outline: "none",
                      }}
                    />
                    <button
                      type="button"
                      disabled={!reason.trim() || inFlight}
                      onClick={() => decide(r, "reject")}
                      style={{ ...actionButton(false, !reason.trim() || inFlight), color: RED, borderColor: RED }}
                    >
                      Confirm reject
                    </button>
                  </>
                ) : null}
              </div>
            </MobileCard>
          ))
        )}
      </div>
    </MSection>
  );
}

// ---- Tab ------------------------------------------------------------------

export function ServiceTab({ period, setPeriod }: DashboardTabProps) {
  const { sub, setSub, subs } = useDashboardSub("service");
  const { data, loading, error } = useCachedJson<Feed>(DASHBOARD_FEED_URL);
  const [search, setSearch] = useState("");
  // Root-cause key tapped on Top issues; narrows the Report's case list only.
  const [causeFilter, setCauseFilter] = useState<string | null>(null);

  const slice = data?.service ?? null;
  const cases = useMemo(() => slice?.cases ?? [], [slice]);
  const logged = useMemo(() => cases.filter((c) => inFocus(period, c.createdDate)), [cases, period]);
  const threshold = slice?.overdueAfterDays ?? 3;

  let body: ReactNode;
  if (loading) body = <MState kind="loading" />;
  else if (error || !data?.success) body = <MState kind="error" text={`Couldn't load Service: ${error ?? "unknown error"}`} />;
  else if (!slice) {
    body = (
      <MobileCard>
        <MState
          kind="empty"
          text={`Service data isn't available: ${data.availability?.service?.reason ?? "the feed has no service section yet (try again in a minute)."}`}
        />
      </MobileCard>
    );
  } else {
    body = (
      <>
        {sub === "overdue" || sub === "approvals" ? null : (
          <div style={{ fontSize: 12.5, color: M.muted, margin: "0 4px 10px" }}>
            {periodLabel(period)} · {data.availability?.service?.live ? "live data" : "not live"}
          </div>
        )}
        {sub === "overview" && (
          <Report
            cases={cases} threshold={threshold} period={period} setPeriod={setPeriod}
            search={search} setSearch={setSearch} causeFilter={causeFilter} clearCause={() => setCauseFilter(null)}
          />
        )}
        {sub === "performance" && <Performance cases={cases} threshold={threshold} period={period} setPeriod={setPeriod} />}
        {sub === "overdue" && <Overdue cases={cases} threshold={threshold} />}
        {sub === "approvals" && <Approvals />}
        {sub === "issues" && (
          <>
            {period.day ? (
              <div style={{ marginBottom: 2 }}>
                <MFocusChip label={dayLabel(period.day)} onClear={() => setPeriod({ ...period, day: undefined })} />
              </div>
            ) : null}
            <Issues cases={logged} period={period} onPickCause={(k) => { setCauseFilter(k); setSub("overview"); }} causeOnly={false} />
          </>
        )}
      </>
    );
  }

  return (
    <>
      <MSubPills subs={subs} active={sub} onChange={setSub} />
      <div style={{ padding: "12px 14px 0" }}>{body}</div>
    </>
  );
}
