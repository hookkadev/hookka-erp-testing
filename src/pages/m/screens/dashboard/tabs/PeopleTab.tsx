// Employees tab (key `people`) — phone port of the desktop Employees dashboard (EmployeesView +
// EmployeesInsights + AttendanceLogCard + DeptEfficiencyCard + DepartmentsView).
// Sub-tabs (?sub=): overview, time, efficiency, departments — same keys as desktop.
//
// Every number is the HOUSE metric the desktop reads (performance.byDay: earned
// production minutes / clocked working minutes), not attendance_records'
// efficiency_pct. The desktop calculations that live inside React components
// (not exported) are re-implemented below as pure functions, line for line:
// timeTotals, buildLog, rankPeople, deptEfficiency, deptLedger.
//
// Phone differences: charts are single-series bars (working hours / efficiency
// %); in YTD a bar is a MONTH and a tap opens it (tapBucket, same as Sales) —
// desktop draws daily points all year. Regular vs overtime is two tiles, not a
// donut. The attendance log shows the first LOG_ROWS rows; totals cover all.
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useCachedJson } from "@/lib/cached-fetch";
import {
  AMBER, GREEN, dayLabel, fmtN, inFocus, inPeriod, periodLabel, type Period,
} from "../../../../dashboards/dashboard-shared-lib";
import type { EmployeeSlice } from "../../../../dashboards/EmployeesInsights";
import { filterSlice } from "../../../../dashboards/employee-filter";
import { ListRow, MobileCard, StatusPill } from "../../../components";
import { PAYMENT_STATUS_MAP, resolveStatus } from "../../../config/helpers";
import { M, SEMANTIC } from "../../../theme";
import { tapBucket } from "../dashboard-m-lib";
import { useDashboardSub } from "../hooks";
import { MChartCard, MFocusChip, MKpi, MKpiGrid, MRankList, MSection, MState, MSubPills } from "../primitives";
import { DASHBOARD_FEED_URL, type DashboardTabProps } from "../types";

type Worker = EmployeeSlice["workers"][number] & {
  empNo: string | null; status: string | null; targetPct: number | null; hoursPerDay: number | null;
};
type Employee = Omit<EmployeeSlice, "workers"> & { workers: Worker[] };
type Feed = {
  success?: boolean;
  availability?: { employee?: { live: boolean; reason?: string; workers: number; attendanceRows: number; missing?: string[] } };
  meta?: { config?: { efficiencyTargetPct?: number; workingHoursPerDay?: number } };
  employee?: Employee;
};

// Desktop display bands (EmployeesInsights): not policy, the feed carries no threshold.
const WARN_LOW = 90;
const WARN_HIGH = 110;
const MIN_RANK_MINUTES = 60;
const WORKER_ROWS = 60;
const LOG_ROWS = 60;

const hrs = (min: number) => `${(min / 60).toLocaleString("en-MY", { maximumFractionDigits: 1 })}h`;
const pct1 = (v: number | null) => (v == null ? "—" : `${v.toFixed(1)}%`);
const ratio = (w: number, p: number) => (w > 0 ? (p / w) * 100 : null);
const hhmm = (t: string | null) => t?.match(/\d{2}:\d{2}/)?.[0] ?? "—";
// Minutes after the 08:00 shift start; 0 when on time or unparseable.
const lateMin = (t: string | null) => {
  const m = t?.match(/(\d{2}):(\d{2})/);
  return m ? Math.max(0, Number(m[1]) * 60 + Number(m[2]) - 480) : 0;
};
const tone = (v: number | null, floor: number) => (v == null ? M.muted : v >= floor ? GREEN : AMBER);

// ---- Pure calculations (ports of the desktop component maths) -------------

type Bucket = { date: string; iso: string; w: number; p: number };

/** Chart buckets inside the period: a day (monthly / range) or a month (YTD). */
function hourBuckets(byDay: EmployeeSlice["performance"]["byDay"], period: Period): Bucket[] {
  const ytd = period.mode === "ytd";
  const m = new Map<string, Bucket>();
  const days = byDay.filter((d) => inPeriod(period, d.date)).sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const d of days) {
    const iso = ytd ? d.date.slice(0, 7) : d.date;
    // A range can span months, so its label keeps the month.
    const date = ytd ? iso.slice(5) : period.mode === "range" ? d.date.slice(5) : d.date.slice(8);
    const cur = m.get(iso) ?? { date, iso, w: 0, p: 0 };
    cur.w += d.workingMinutes;
    cur.p += d.productionMinutes;
    m.set(iso, cur);
  }
  return [...m.values()];
}

// TimeAttendancePanels: clocked/overtime from attendance, tiles from the house metric.
function timeTotals(e: EmployeeSlice, period: Period) {
  const att = e.attendance.filter((r) => inFocus(period, r.date));
  const working = att.reduce((a, r) => a + r.workingMinutes, 0);
  const ot = att.reduce((a, r) => a + Math.min(r.overtimeMinutes, r.workingMinutes), 0);
  const days = e.performance.byDay.filter((d) => inFocus(period, d.date));
  const w = days.reduce((a, d) => a + d.workingMinutes, 0);
  const p = days.reduce((a, d) => a + d.productionMinutes, 0);
  const all = days.reduce((a, d) => a + (d.allDeptMinutes ?? d.workingMinutes), 0);
  return {
    working, ot, regular: working - ot, days: att.length,
    people: new Set(att.map((r) => r.employeeId ?? r.employeeName)).size,
    w, p, nonProd: Math.max(0, all - w),
  };
}

// AttendanceLogCard: latest recorded day per employee (or every day when perDay).
function buildLog(e: EmployeeSlice, period: Period, perDay: boolean) {
  const byId = new Set(e.workers.map((w) => w.id));
  const byName = new Map(e.workers.map((w) => [(w.name ?? "").trim().toLowerCase(), w.id]));
  const perf = new Map<string, { working: number; prod: number; all: number }>();
  for (const d of e.performance.byDay) {
    for (const x of d.workers ?? []) {
      perf.set(`${d.date}|${x.workerId}`, { working: x.workingMinutes, prod: x.productionMinutes, all: x.allDeptMinutes ?? x.workingMinutes });
    }
  }
  const byEmp = new Map<string, { last: EmployeeSlice["attendance"][number]; workerId: string | null; days: number }>();
  for (const r of e.attendance) {
    if (!r.date || !inFocus(period, r.date)) continue;
    const workerId = r.employeeId && byId.has(r.employeeId)
      ? r.employeeId
      : (byName.get((r.employeeName ?? "").trim().toLowerCase()) ?? null);
    const k = (workerId ?? r.employeeId ?? r.employeeName ?? "") + (perDay ? `|${r.date}` : "");
    const cur = byEmp.get(k);
    byEmp.set(k, { last: !cur || r.date >= (cur.last.date ?? "") ? r : cur.last, workerId, days: (cur?.days ?? 0) + 1 });
  }
  const rows = [...byEmp.entries()]
    .map(([key, { last, workerId, days }]) => {
      const p = workerId && last.date ? perf.get(`${last.date}|${workerId}`) : undefined;
      return {
        key, last, days,
        working: p?.working ?? null,
        prod: p?.prod ?? null,
        nonProd: p ? Math.max(0, p.all - p.working) : null,
        eff: p ? ratio(p.working, p.prod) : null,
      };
    })
    .sort((a, b) => perDay
      ? (b.last.date ?? "").localeCompare(a.last.date ?? "")
      : (a.last.employeeName ?? "").localeCompare(b.last.employeeName ?? ""));
  const sum = (f: (r: (typeof rows)[number]) => number | null) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
  const working = sum((r) => r.working);
  const prod = sum((r) => r.prod);
  return { rows, working, prod, nonProd: sum((r) => r.nonProd), days: sum((r) => r.days), eff: ratio(working, prod) };
}

// EfficiencyPanels: per-person production / working, headcount workers with >= 1h clocked.
function rankPeople(e: EmployeeSlice, period: Period) {
  const byId = new Map(e.workers.map((w) => [w.id, w]));
  const m = new Map<string, { w: number; p: number }>();
  for (const d of e.performance.byDay) {
    if (!inFocus(period, d.date)) continue;
    for (const x of d.workers ?? []) {
      const cur = m.get(x.workerId) ?? { w: 0, p: 0 };
      cur.w += x.workingMinutes;
      cur.p += x.productionMinutes;
      m.set(x.workerId, cur);
    }
  }
  return [...m.entries()]
    .flatMap(([id, v]) => {
      const w = byId.get(id);
      if (!w || !w.countsToHeadcount || v.w < MIN_RANK_MINUTES) return [];
      return [{ key: id, name: w.name ?? "—", sub: [w.role, w.dept].filter(Boolean).join(" · "), avg: (v.p / v.w) * 100 }];
    })
    .sort((a, b) => b.avg - a.avg);
}

// DeptEfficiencyCard: the focused day, else the latest day in the period with clocked hours.
function deptEfficiency(e: EmployeeSlice, period: Period) {
  const latest = e.performance.byDay
    .filter((d) => d.workingMinutes > 0 && inPeriod(period, d.date))
    .reduce((mx, d) => (d.date > mx ? d.date : mx), "");
  const day = period.day ?? latest;
  const deptOf = new Map(e.workers.map((w) => [w.id, w.dept]));
  const m = new Map<string, { dept: string; people: Set<string>; working: number; prod: number }>();
  for (const d of e.performance.byDay) {
    if (d.date !== day) continue;
    for (const x of d.workers ?? []) {
      const k = deptOf.get(x.workerId) || "(no dept)";
      let row = m.get(k);
      if (!row) m.set(k, (row = { dept: k, people: new Set(), working: 0, prod: 0 }));
      row.people.add(x.workerId);
      row.working += x.workingMinutes;
      row.prod += x.productionMinutes;
    }
  }
  const rows = [...m.values()].sort((a, b) => a.dept.localeCompare(b.dept));
  const total = rows.reduce((a, r) => ({ w: a.w + r.working, p: a.p + r.prod, n: a.n + r.people.size }), { w: 0, p: 0, n: 0 });
  return { day, isLatest: !period.day, rows, total };
}

// DepartmentsView: headcount is current; hours, efficiency and days follow the period.
function deptLedger(e: EmployeeSlice, period: Period) {
  const m = new Map<string, { dept: string; headcount: number; working: number; prod: number; days: number }>();
  const get = (d: string | null) => {
    const k = d || "(no dept)";
    let row = m.get(k);
    if (!row) m.set(k, (row = { dept: k, headcount: 0, working: 0, prod: 0, days: 0 }));
    return row;
  };
  for (const w of e.workers) if (w.countsToHeadcount) get(w.dept).headcount++;
  const deptOf = new Map(e.workers.map((w) => [w.id, w.dept]));
  for (const d of e.performance.byDay) {
    if (!inPeriod(period, d.date)) continue;
    for (const x of d.workers ?? []) {
      const row = get(deptOf.get(x.workerId) ?? null);
      row.working += x.workingMinutes;
      row.prod += x.productionMinutes;
    }
  }
  for (const r of e.attendance) if (inPeriod(period, r.date)) get(r.dept).days += 1;
  const rows = [...m.values()].sort((a, b) => b.headcount - a.headcount || a.dept.localeCompare(b.dept));
  const total = rows.reduce(
    (a, r) => ({ headcount: a.headcount + r.headcount, working: a.working + r.working, prod: a.prod + r.prod, days: a.days + r.days }),
    { headcount: 0, working: 0, prod: 0, days: 0 },
  );
  return { rows, total };
}

// ---- Small building blocks ------------------------------------------------

function Note({ children, color }: { children: ReactNode; color?: string }) {
  return <div style={{ fontSize: 11.5, lineHeight: 1.45, color: color ?? M.muted, margin: "8px 4px 0" }}>{children}</div>;
}

function Rows({ children }: { children: ReactNode }) {
  return <MobileCard padded={false} radius={16} style={{ overflow: "hidden" }}>{children}</MobileCard>;
}

const Strong = ({ children, color }: { children: ReactNode; color?: string }) => (
  <span style={{ color: color ?? M.raisin, fontWeight: 700 }}>{children}</span>
);

const selectStyle: CSSProperties = {
  display: "block", width: "100%", minHeight: 44, marginTop: 4, padding: "0 12px", borderRadius: 12,
  border: `1px solid ${M.border}`, background: M.paper, color: M.raisin, fontSize: 16,
};
const labelStyle: CSSProperties = { display: "block", fontSize: 11, fontWeight: 600, color: M.muted };

type Shared = { period: Period; setPeriod: (p: Period) => void; target: number };

/** Pool efficiency per bucket vs target (desktop "Daily efficiency"). */
function EfficiencyTrend({ employee, period, setPeriod, target }: Shared & { employee: EmployeeSlice }) {
  const { chart, total, below } = useMemo(() => {
    const clocked = employee.performance.byDay.filter((d) => d.workingMinutes > 0);
    const daily = clocked.filter((d) => inPeriod(period, d.date));
    const eff = (w: number, p: number) => Math.round((p / w) * 1000) / 10;
    return {
      chart: hourBuckets(clocked, period).map((b) => ({ ...b, value: eff(b.w, b.p) })),
      total: daily.length,
      below: daily.filter((d) => eff(d.workingMinutes, d.productionMinutes) < target).length,
    };
  }, [employee.performance.byDay, period, target]);
  const selected = chart.find((d) => d.iso === period.day) ?? null;

  return (
    <MChartCard
      title={period.mode === "ytd" ? "Efficiency by month" : "Daily efficiency"}
      subtitle={
        selected
          ? `${dayLabel(selected.iso)} · ${selected.value}% vs ${target}% target`
          : `Production ÷ working vs ${target}% target · ${below} of ${total} days below · tap a bar to ${period.mode === "ytd" ? "open that month" : "focus that day"}`
      }
      data={chart.map((d) => ({ key: d.date, value: d.value }))}
      selectedKey={selected?.date ?? null}
      onSelect={(k) => setPeriod(tapBucket(period, chart, k))}
      formatAxis={(v) => `${v}%`}
      emptyText="No clocked hours in range."
      footer={period.day ? <MFocusChip label={dayLabel(period.day)} onClear={() => setPeriod({ ...period, day: undefined })} /> : undefined}
    />
  );
}

// ---- Sub-tabs -------------------------------------------------------------

function OverviewSub({ employee, period, setPeriod, targetPct, hoursPerDay }: Omit<Shared, "target"> & {
  employee: Employee; targetPct: number | undefined; hoursPerDay: number | undefined;
}) {
  const headcountWorkers = useMemo(() => employee.workers.filter((w) => w.countsToHeadcount), [employee.workers]);
  // Workers have no date: headcount / target / hours-per-day stay book-wide, only the hours follow the period.
  const chart = useMemo(() => hourBuckets(employee.performance.byDay, period), [employee.performance.byDay, period]);
  const working = chart.reduce((a, d) => a + d.w, 0);
  const production = chart.reduce((a, d) => a + d.p, 0);
  const selected = chart.find((d) => d.iso === period.day) ?? null;
  const shown = headcountWorkers.slice(0, WORKER_ROWS);

  return (
    <>
      <MKpiGrid>
        <MKpi label="Headcount" value={fmtN(headcountWorkers.length)} sub="Active, excl. test accounts" />
        <MKpi label="Efficiency" value={pct1(ratio(working, production))} tone="#3E6570" sub="Prod ÷ working · earned, not measured" />
        <MKpi label="Efficiency target" value={targetPct != null ? `${targetPct}%` : "—"} tone={GREEN} />
        <MKpi label="Working hours / day" value={hoursPerDay != null ? `${hoursPerDay}h` : "—"} tone={AMBER} />
        <MKpi label="Working hours" value={hrs(working)} sub={periodLabel({ ...period, day: undefined })} />
        <MKpi label="Production hours" value={hrs(production)} tone="#3E6570" sub={periodLabel({ ...period, day: undefined })} />
      </MKpiGrid>

      <MSection title="Working vs production hours">
        <MChartCard
          title={period.mode === "ytd" ? "Working hours by month" : "Working hours by day"}
          subtitle={
            selected
              ? `${dayLabel(selected.iso)} · worked ${hrs(selected.w)} · production ${hrs(selected.p)} · ${pct1(ratio(selected.w, selected.p))}`
              : `Bars are clocked working hours; production ${hrs(production)} of ${hrs(working)} · tap a bar to ${period.mode === "ytd" ? "open that month" : "focus that day"}`
          }
          data={chart.map((d) => ({ key: d.date, value: Math.round((d.w / 60) * 10) / 10 }))}
          selectedKey={selected?.date ?? null}
          onSelect={(k) => setPeriod(tapBucket(period, chart, k))}
          formatAxis={(v) => `${v}h`}
          emptyText="No clocked hours in range."
          footer={period.day ? <MFocusChip label={dayLabel(period.day)} onClear={() => setPeriod({ ...period, day: undefined })} /> : undefined}
        />
      </MSection>

      <MSection title="Workers" hint={`${fmtN(shown.length)} of ${fmtN(headcountWorkers.length)} shown`}>
        {shown.length === 0 ? (
          <MobileCard><MState kind="empty" text="No workers." /></MobileCard>
        ) : (
          <Rows>
            {shown.map((w) => {
              const st = resolveStatus(w.status, PAYMENT_STATUS_MAP);
              return (
                <ListRow
                  key={w.id}
                  code={w.empNo ?? "—"}
                  title={w.name ?? "—"}
                  subLine={[w.dept, w.role].filter(Boolean).join(" · ") || "—"}
                  meta={[
                    { label: "Target %", value: w.targetPct ?? "—" },
                    { label: "Hours/day", value: w.hoursPerDay ?? "—" },
                  ]}
                  pill={w.status ? <StatusPill style={st.style} label={st.label} size="sm" /> : undefined}
                />
              );
            })}
          </Rows>
        )}
      </MSection>
    </>
  );
}

function TimeSub({ employee, period, setPeriod, target, perDay }: Shared & { employee: EmployeeSlice; perDay: boolean }) {
  const t = useMemo(() => timeTotals(employee, period), [employee, period]);
  const log = useMemo(() => buildLog(employee, period, perDay), [employee, period, perDay]);
  const share = (v: number) => (t.working > 0 ? `${pct1((v / t.working) * 100)} of clocked` : undefined);
  const who = log.rows[0]?.last.employeeName ?? "";

  return (
    <>
      <MSection title="Time & attendance" hint={periodLabel(period)}>
        <MKpiGrid>
          <MKpi label="Clocked" value={hrs(t.working)} sub={`${fmtN(t.people)} employees combined`} />
          <MKpi label="Total days worked" value={fmtN(t.days)} />
          <MKpi label="Regular" value={hrs(t.regular)} tone={M.taupe} sub={share(t.regular)} />
          <MKpi label="Overtime" value={hrs(t.ot)} tone={AMBER} sub={share(t.ot)} />
          <MKpi label="Production time" value={hrs(t.w)} sub="clocked in production depts" />
          <MKpi label="Prod hours" value={hrs(t.p)} tone="#3E6570" sub="earned standard time" />
          <div style={{ gridColumn: "1 / -1" }}>
            <MKpi label="Non-prod hours" value={hrs(t.nonProd)} sub="all-dept clocked − production-dept clocked" />
          </div>
        </MKpiGrid>
        <Note>Leave / absent is not shown: the attendance table only records days worked.</Note>
      </MSection>

      <MSection title="Efficiency trend">
        <EfficiencyTrend employee={employee} period={period} setPeriod={setPeriod} target={target} />
      </MSection>

      <MSection
        title="Attendance log"
        hint={perDay ? `${fmtN(log.days)} days · ${who}` : `${fmtN(log.rows.length)} employees · latest day each`}
      >
        {log.rows.length === 0 ? (
          <MobileCard><MState kind="empty" text="No attendance recorded in this period." /></MobileCard>
        ) : (
          <>
            <Rows>
              {log.rows.slice(0, LOG_ROWS).map((r) => {
                const late = lateMin(r.last.clockIn);
                return (
                  <ListRow
                    key={r.key}
                    code={`${r.last.date ? dayLabel(r.last.date) : "—"} · ${hhmm(r.last.clockIn)}–${hhmm(r.last.clockOut)}`}
                    title={r.last.employeeName ?? "—"}
                    subLine={`Prod time ${r.working == null ? "—" : hrs(r.working)} · Prod ${r.prod == null ? "—" : hrs(r.prod)} · Non-prod ${r.nonProd == null ? "—" : hrs(r.nonProd)}`}
                    meta={[
                      { label: "Efficiency", value: <Strong color={tone(r.eff, 90)}>{pct1(r.eff)}</Strong> },
                      perDay ? undefined : { label: "Total days", value: fmtN(r.days) },
                    ]}
                    pill={<StatusPill style={late ? SEMANTIC.WARNING : SEMANTIC.SUCCESS} label={late ? `Late ${late}m` : "On time"} size="sm" />}
                  />
                );
              })}
              <ListRow
                code={perDay ? `Total (${fmtN(log.days)} days)` : `All ${fmtN(log.rows.length)} rows`}
                title={`Prod time ${hrs(log.working)}`}
                subLine={`Prod ${hrs(log.prod)} · Non-prod ${hrs(log.nonProd)}`}
                meta={[
                  { label: "Efficiency", value: pct1(log.eff) },
                  perDay ? undefined : { label: "Total days", value: fmtN(log.days) },
                ]}
              />
            </Rows>
            <Note>
              {log.rows.length > LOG_ROWS ? `First ${LOG_ROWS} of ${fmtN(log.rows.length)} rows shown; the total covers all. ` : ""}
              {'"—" means no work-hour entry exists for that person on that day.'}
            </Note>
          </>
        )}
      </MSection>
    </>
  );
}

function EfficiencySub({ employee, period, setPeriod, target, onPickEmployee }: Shared & {
  employee: EmployeeSlice; onPickEmployee: (workerId: string) => void;
}) {
  const dept = useMemo(() => deptEfficiency(employee, period), [employee, period]);
  const people = useMemo(() => rankPeople(employee, period), [employee, period]);
  const flagged = useMemo(
    () => people.filter((p) => p.avg < WARN_LOW || p.avg > WARN_HIGH).sort((a, b) => a.avg - b.avg),
    [people],
  );
  const rankItem = (p: (typeof people)[number]) => ({
    key: p.key,
    label: p.name,
    sub: [`Rank ${people.indexOf(p) + 1} of ${people.length}`, p.sub].filter(Boolean).join(" · "),
    value: p.avg,
    valueLabel: pct1(p.avg),
    onClick: () => onPickEmployee(p.key),
  });

  return (
    <>
      <MSection title="Efficiency by department" hint={dept.day ? dayLabel(dept.day) : undefined}>
        {dept.rows.length === 0 ? (
          <MobileCard>
            <MState kind="empty" text={dept.day ? "No per-worker hours for this day." : "No clocked hours in this period."} />
          </MobileCard>
        ) : (
          <Rows>
            {dept.rows.map((r) => (
              <ListRow
                key={r.dept}
                code={`${fmtN(r.people.size)} ${r.people.size === 1 ? "person" : "people"}`}
                title={r.dept}
                subLine={`Production time ${hrs(r.working)} · Prod ${hrs(r.prod)}`}
                meta={[{ label: "Efficiency", value: <Strong color={tone(ratio(r.working, r.prod), target)}>{pct1(ratio(r.working, r.prod))}</Strong> }]}
              />
            ))}
            <ListRow
              code={`${fmtN(dept.total.n)} people`}
              title="Factory"
              subLine={`Production time ${hrs(dept.total.w)} · Prod ${hrs(dept.total.p)}`}
              meta={[{ label: "Efficiency", value: <Strong color={tone(ratio(dept.total.w, dept.total.p), target)}>{pct1(ratio(dept.total.w, dept.total.p))}</Strong> }]}
            />
          </Rows>
        )}
        <Note>
          {dept.day && dept.isLatest ? "Latest day with clocked hours in the period. " : ""}
          Efficiency = prod hours ÷ production time (clocked), against the {target}% target.
        </Note>
      </MSection>

      <MSection title="Efficiency trend">
        <EfficiencyTrend employee={employee} period={period} setPeriod={setPeriod} target={target} />
      </MSection>

      <MSection title="Top 5 performers" hint={`${fmtN(people.length)} ranked · ${periodLabel(period)}`}>
        <MRankList items={people.slice(0, 5).map(rankItem)} valueHeading="Efficiency" emptyText="Nobody clocked enough hours in range." />
        <Note>Production ÷ working per person, headcount only, at least 1h clocked. Tap a row to filter to that person.</Note>
      </MSection>

      <MSection title="Bottom 5 · needs attention">
        <MRankList items={people.slice(-5).reverse().map(rankItem)} valueHeading="Efficiency" emptyText="Nobody clocked enough hours in range." />
      </MSection>

      <MSection title="Time audit warnings" hint={`${fmtN(flagged.length)} flagged`}>
        {flagged.length === 0 ? (
          <MobileCard><MState kind="empty" text={`Nobody is outside the ${WARN_LOW}–${WARN_HIGH}% band.`} /></MobileCard>
        ) : (
          <Rows>
            {flagged.map((p) => {
              const over = p.avg > WARN_HIGH;
              return (
                <ListRow
                  key={p.key}
                  code={p.sub || "—"}
                  title={p.name}
                  meta={[{ label: "Actual", value: pct1(p.avg) }, { label: "Target", value: `${target}%` }]}
                  pill={<StatusPill style={over ? SEMANTIC.DANGER : SEMANTIC.WARNING} label={over ? "Over-reporting" : "Needs Attention"} size="sm" />}
                  onClick={() => onPickEmployee(p.key)}
                />
              );
            })}
          </Rows>
        )}
        <Note>
          Flags under {WARN_LOW}% (under-performance) and over {WARN_HIGH}% (over-reporting) against the {target}% baseline.
          The bands are display choices, not policy.
        </Note>
      </MSection>
    </>
  );
}

function DepartmentsSub({ employee, period }: { employee: EmployeeSlice; period: Period }) {
  const { rows, total } = useMemo(() => deptLedger(employee, period), [employee, period]);
  const scope = periodLabel({ ...period, day: undefined });

  return (
    <>
      <MKpiGrid>
        <MKpi label="Departments" value={fmtN(rows.length)} sub={scope} />
        <MKpi label="Headcount" value={fmtN(total.headcount)} sub="current" />
        <MKpi label="Working hours" value={hrs(total.working)} />
        <MKpi label="Prod hours" value={hrs(total.prod)} tone="#3E6570" />
        <MKpi label="Factory efficiency" value={pct1(ratio(total.working, total.prod))} tone={M.taupe} />
        <MKpi label="Days worked" value={fmtN(total.days)} />
      </MKpiGrid>

      <MSection title="Department ledger" hint={scope}>
        {rows.length === 0 ? (
          <MobileCard><MState kind="empty" text="No departments." /></MobileCard>
        ) : (
          <Rows>
            {rows.map((r) => (
              <ListRow
                key={r.dept}
                code={`Headcount ${fmtN(r.headcount)}`}
                title={r.dept}
                subLine={`Working ${hrs(r.working)} · Prod ${hrs(r.prod)}`}
                meta={[
                  { label: "Efficiency", value: pct1(ratio(r.working, r.prod)) },
                  { label: "Days worked", value: fmtN(r.days) },
                ]}
              />
            ))}
          </Rows>
        )}
        <Note>
          Headcount is current; hours and efficiency follow the period. Revenue and labor cost per department are not
          shown: there is no per-department revenue source, and labor cost needs a payroll aggregate in the feed.
        </Note>
      </MSection>
    </>
  );
}

// ---- Tab ------------------------------------------------------------------

function PeopleBody({ employee, sub, period, setPeriod, targetPct, hoursPerDay }: Omit<Shared, "target"> & {
  employee: Employee; sub: string; targetPct: number | undefined; hoursPerDay: number | undefined;
}) {
  // Desktop falls back to 100 when the feed carries no configured target.
  const target = targetPct ?? 100;
  // Department / employee filter, shared by Time & attendance and Efficiency.
  const [dept, setDept] = useState("");
  const [emp, setEmp] = useState("");
  const headcountWorkers = useMemo(
    () => employee.workers.filter((w) => w.countsToHeadcount).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    [employee.workers],
  );
  const depts = useMemo(
    () => [...new Set(headcountWorkers.map((w) => w.dept).filter((d): d is string => !!d))].sort(),
    [headcountWorkers],
  );
  const empOptions = useMemo(() => headcountWorkers.filter((w) => !dept || w.dept === dept), [headcountWorkers, dept]);
  const filtered = useMemo(() => filterSlice(employee, dept, emp), [employee, dept, emp]);
  const shownCount = emp ? 1 : empOptions.length;

  const filterBar = (
    <MobileCard radius={16} style={{ display: "grid", gap: 10 }}>
      <label style={labelStyle}>
        Department
        <select style={selectStyle} value={dept} onChange={(e) => { setDept(e.target.value); setEmp(""); }}>
          <option value="">All departments</option>
          {depts.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </label>
      <label style={labelStyle}>
        Employee
        <select style={selectStyle} value={emp} onChange={(e) => setEmp(e.target.value)}>
          <option value="">All employees</option>
          {empOptions.map((w) => <option key={w.id} value={w.id}>{w.name ?? w.empNo ?? w.id}</option>)}
        </select>
      </label>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span style={{ fontSize: 12, color: M.muted }}>
          {fmtN(shownCount)} employee{shownCount === 1 ? "" : "s"} · {dept || "all departments"}
        </span>
        <button
          type="button"
          onClick={() => { setDept(""); setEmp(""); }}
          disabled={!dept && !emp}
          style={{
            minHeight: 44, padding: "0 16px", borderRadius: 12, border: `1px solid ${M.border}`, background: M.card,
            color: M.taupe, fontSize: 13, fontWeight: 600, cursor: "pointer", opacity: !dept && !emp ? 0.5 : 1,
            WebkitTapHighlightColor: "transparent",
          }}
        >
          Reset
        </button>
      </div>
    </MobileCard>
  );

  if (sub === "time") {
    return <>{filterBar}<TimeSub employee={filtered} period={period} setPeriod={setPeriod} target={target} perDay={!!emp} /></>;
  }
  if (sub === "efficiency") {
    return <>{filterBar}<EfficiencySub employee={filtered} period={period} setPeriod={setPeriod} target={target} onPickEmployee={setEmp} /></>;
  }
  if (sub === "departments") return <DepartmentsSub employee={employee} period={period} />;
  return <OverviewSub employee={employee} period={period} setPeriod={setPeriod} targetPct={targetPct} hoursPerDay={hoursPerDay} />;
}

export function PeopleTab({ period, setPeriod }: DashboardTabProps) {
  const { sub, setSub, subs } = useDashboardSub("people");
  const { data, loading, error } = useCachedJson<Feed>(DASHBOARD_FEED_URL);

  if (loading) return <MState kind="loading" />;
  if (error || !data?.success) return <MState kind="error" text={`Couldn't load Employees:${error ?? "unknown error"}`} />;

  const avail = data.availability?.employee;
  const employee = data.employee;
  const config = data.meta?.config;
  const missing = avail?.missing ?? [];

  return (
    <div>
      <MSubPills subs={subs} active={sub} onChange={setSub} />
      <div style={{ padding: "12px 14px 0" }}>
        {!employee ? (
          <MobileCard>
            <MState kind="empty" text={avail?.reason ?? "Workforce data is not available for your account."} />
          </MobileCard>
        ) : (
          <>
            {(avail && !avail.live) || missing.length > 0 ? (
              <div style={{ marginBottom: 10 }}>
                {avail && !avail.live ? <Note color={AMBER}>Workforce feed is not live{avail.reason ? `: ${avail.reason}` : "."}</Note> : null}
                {missing.length > 0 ? <Note color={AMBER}>Not available yet: {missing.join(", ")}.</Note> : null}
              </div>
            ) : null}
            <PeopleBody
              employee={employee}
              sub={sub}
              period={period}
              setPeriod={setPeriod}
              targetPct={config?.efficiencyTargetPct}
              hoursPerDay={config?.workingHoursPerDay}
            />
          </>
        )}
      </div>
    </div>
  );
}
