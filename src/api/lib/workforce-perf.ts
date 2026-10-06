// ---------------------------------------------------------------------------
// workforce-perf.ts — the per-day, per-worker production vs working minutes
// behind Dashboard Experimental > People > Efficiency.
//
// Moved out of routes/dashboard-prototype.ts unchanged so the Department
// efficiency KPI (DEV-36) runs the SAME code as the screen it is read against:
// a KPI that can disagree with the dashboard is a KPI nobody believes.
//
//   buildPerfDays    — the rows → per-day totals + per-worker split (verbatim
//                      from the route; see the comments inside).
//   poolEfficiencyPct — the page's figure for a period: the day totals for
//                      everyone, or the summed workers of a department set
//                      (employee-filter.ts filterSlice + overallEfficiencyPct
//                      in dashboard-shared-lib.ts), days with no working
//                      minutes skipped.
// ---------------------------------------------------------------------------

export const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const dayKey = (v: unknown): string | null => {
  if (!v) return null;
  const s = typeof v === "string" ? v : new Date(v as string).toISOString();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
};

export type PerfWheRow = {
  workerId: string | null;
  date: string | null;
  departmentCode: string | null;
  hours: number | string | null;
};
export type PerfJcRow = {
  id: string;
  departmentCode: string | null;
  pic1Id: string | null;
  pic2Id: string | null;
  completedDate: string | null;
  estMinutes: number | string | null;
  actualMinutes: number | string | null;
  wipQty: number | string | null;
};
export type PerfPicRow = { jobCardId: string; pic1Id: string | null; pic2Id: string | null };

type Minutes = { workingMinutes: number; productionMinutes: number; allDeptMinutes: number };
export type PerfDay = { date: string } & Minutes & { workers: Array<{ workerId: string } & Minutes> };

export function buildPerfDays(input: {
  whe: readonly PerfWheRow[];
  jobCards: readonly PerfJcRow[];
  pics: readonly PerfPicRow[];
  productionDepts: Set<string>;
}): { perfDays: PerfDay[]; perfCards: number; perfMeasuredCards: number } {
  const { productionDepts } = input;

  // FAB_CUT stores the per-SET total on the card (wipQty = piece count), every
  // other department stores per-PIECE minutes. Multiplying FAB_CUT by wipQty
  // triple-counts it. Same rule as src/lib/job-card-minutes.ts.
  const jcMinutesTotal = (perUnit: number, dept: string | null, wipQty: number): number =>
    (dept ?? "") === "FAB_CUT" ? perUnit : perUnit * Math.max(1, wipQty || 1);

  const picsByJc = new Map<string, Array<{ pic1: string | null; pic2: string | null }>>();
  for (const p of input.pics) {
    const arr = picsByJc.get(p.jobCardId) ?? [];
    arr.push({ pic1: p.pic1Id, pic2: p.pic2Id });
    picsByJc.set(p.jobCardId, arr);
  }

  // date -> { working, production, allDept } and date -> worker -> { same }.
  // `workingMinutes` stays PRODUCTION-DEPARTMENT-ONLY clocked time (unchanged
  // meaning — it is "Prod Hours" downstream). `allDeptMinutes` is new: EVERY
  // clocked hour that day regardless of department. The difference between
  // the two is time clocked OUTSIDE a production department — MEASURED
  // 2026-08-27 (WANNA HLAING, 2026-08-17): 9.0h all-dept (8.9h under R_AND_D
  // + 0.1h under FOAM) vs 0.1h production-dept-only. Without allDeptMinutes
  // there was no way to show that 8.9h anywhere; "Non-Prod Hours" was instead
  // computed as clocked-minus-earned, which is a DIFFERENT quantity (a
  // shortfall against standard time, not "time spent elsewhere that day") and
  // read as 0h for her precisely because her earned credit (3.33h) exceeded
  // her tiny production-dept clock time.
  const perfByDay = new Map<string, { date: string } & Minutes>();
  const perfByDayWorker = new Map<string, Map<string, Minutes>>();
  const perfDay = (d: string) => {
    let e = perfByDay.get(d);
    if (!e) perfByDay.set(d, (e = { date: d, workingMinutes: 0, productionMinutes: 0, allDeptMinutes: 0 }));
    if (!perfByDayWorker.has(d)) perfByDayWorker.set(d, new Map());
    return e;
  };
  const perfWorker = (d: string, w: string) => {
    const m = perfByDayWorker.get(d)!;
    let e = m.get(w);
    if (!e) m.set(w, (e = { workingMinutes: 0, productionMinutes: 0, allDeptMinutes: 0 }));
    return e;
  };

  for (const r of input.whe) {
    const d = dayKey(r.date);
    if (!d) continue;
    const mins = Math.round(num(r.hours) * 60);
    const dayEntry = perfDay(d);
    dayEntry.allDeptMinutes += mins;
    if (r.workerId) perfWorker(d, r.workerId).allDeptMinutes += mins;
    if (!productionDepts.has(r.departmentCode ?? "")) continue;
    dayEntry.workingMinutes += mins;
    if (r.workerId) perfWorker(d, r.workerId).workingMinutes += mins;
  }

  let perfCards = 0;
  let perfMeasuredCards = 0;
  for (const jc of input.jobCards) {
    const d = dayKey(jc.completedDate);
    if (!d) continue;
    perfCards++;
    const actual = jc.actualMinutes == null ? null : num(jc.actualMinutes);
    // A populated actual that EQUALS the standard is a copied estimate, not a
    // measurement — the repo's established provenance test.
    if (actual !== null && actual > 0 && actual !== num(jc.estMinutes)) perfMeasuredCards++;

    const wipQty = num(jc.wipQty);
    // Day total credits the card ONCE, regardless of how many workers are on it.
    perfDay(d).productionMinutes += jcMinutesTotal(
      actual ?? num(jc.estMinutes), jc.departmentCode, wipQty,
    );

    // Per-worker share is keyed on est ?? actual (note the order — it differs
    // from the day total on purpose; mirrors department-performance.ts).
    const jcMins = num(jc.estMinutes) || (actual ?? 0);
    const pieces = picsByJc.get(jc.id) ?? [];
    const perWorker = new Map<string, number>();
    if (pieces.length > 0) {
      const perPiece = (jc.departmentCode ?? "") === "FAB_CUT"
        ? jcMinutesTotal(jcMins, jc.departmentCode, wipQty) / Math.max(1, pieces.length)
        : jcMins;
      for (const s of pieces) {
        const picCount = (s.pic1 ? 1 : 0) + (s.pic2 ? 1 : 0);
        const share = perPiece / Math.max(1, picCount);
        if (s.pic1) perWorker.set(s.pic1, (perWorker.get(s.pic1) ?? 0) + share);
        if (s.pic2) perWorker.set(s.pic2, (perWorker.get(s.pic2) ?? 0) + share);
      }
    } else {
      const picCount = (jc.pic1Id ? 1 : 0) + (jc.pic2Id ? 1 : 0);
      const share = jcMinutesTotal(jcMins, jc.departmentCode, wipQty) / Math.max(1, picCount);
      if (jc.pic1Id) perWorker.set(jc.pic1Id, share);
      if (jc.pic2Id) perWorker.set(jc.pic2Id, share);
    }
    for (const [wid, raw] of perWorker) {
      perfWorker(d, wid).productionMinutes += Math.round(raw);
    }
  }

  const perfDays = [...perfByDay.values()]
    .map((e) => ({
      ...e,
      workers: [...(perfByDayWorker.get(e.date) ?? new Map<string, Minutes>()).entries()]
        .map(([workerId, v]) => ({ workerId, ...v })),
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  return { perfDays, perfCards, perfMeasuredCards };
}

/**
 * The Efficiency tab's figure for the days `inPeriod` accepts. `workerIds`
 * null = everyone (the day totals, as the page shows with no department
 * picked); a set = those workers' summed minutes (the page with a department
 * picked). Days with no working minutes are skipped. Returns the minutes too,
 * so a caller can say what the figure was built from.
 */
export function poolEfficiencyPct(
  perfDays: readonly PerfDay[],
  workerIds: ReadonlySet<string> | null,
  inPeriod: (date: string) => boolean,
): { pct: number | null; workingMinutes: number; productionMinutes: number; days: number } {
  let w = 0;
  let prod = 0;
  let days = 0;
  for (const d of perfDays) {
    if (!inPeriod(d.date)) continue;
    let dw = d.workingMinutes;
    let dp = d.productionMinutes;
    if (workerIds) {
      const ws = d.workers.filter((x) => workerIds.has(x.workerId));
      if (!ws.length) continue;
      dw = ws.reduce((a, x) => a + x.workingMinutes, 0);
      dp = ws.reduce((a, x) => a + x.productionMinutes, 0);
    }
    if (dw <= 0) continue;
    w += dw;
    prod += dp;
    days += 1;
  }
  return { pct: w > 0 ? (prod / w) * 100 : null, workingMinutes: w, productionMinutes: prod, days };
}
