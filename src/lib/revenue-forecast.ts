// Last verified: 2026-09-21 against src/pages/dashboards/SalesOrdersView.tsx
// (Sales forecast card) and src/api/lib/dashboard-finance.ts (the other caller).
//
// The dashboard's revenue forecast, extracted so the Sales tab and the Finance
// tab share ONE piece of maths instead of two forks. The rule:
//
//   * TARGET for a month = the plain average of the 3 months before it (null
//     until 3 prior months exist). A month is "hit" when actual >= target.
//   * PROJECTION = the average of the last 3 known months, carried forward flat
//     for `project` months. No externally-set target exists in this book, so
//     none is invented.
//
// Pure — money stays in sen and is only averaged, never rounded here (callers
// round at the edge, as the Sales card does for chart values).
export const FORECAST_WINDOW = 3;

export type ForecastActual = { ym: string; sen: number; targetSen: number | null; hit: boolean | null };
export type ForecastProjected = { ym: string; sen: number };

export function nextMonth(ym: string): string {
  let [y, m] = ym.split("-").map(Number);
  m += 1;
  if (m > 12) { m = 1; y += 1; }
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** rows: [YYYY-MM, sen] pairs (any order; sorted here). */
export function rollingForecast(
  rows: readonly (readonly [string, number])[],
  project = 6,
): { actual: ForecastActual[]; projected: ForecastProjected[] } {
  const sorted = [...rows].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const actual = sorted.map(([ym, sen], i) => {
    const prior = sorted.slice(Math.max(0, i - FORECAST_WINDOW), i);
    const targetSen =
      prior.length === FORECAST_WINDOW
        ? prior.reduce((t, [, v]) => t + v, 0) / FORECAST_WINDOW
        : null;
    return { ym, sen, targetSen, hit: targetSen === null ? null : sen >= targetSen };
  });
  const tail = sorted.slice(-FORECAST_WINDOW).map(([, v]) => v);
  const avg = tail.length ? tail.reduce((t, v) => t + v, 0) / tail.length : 0;
  const projected: ForecastProjected[] = [];
  let cursor = sorted.length ? sorted[sorted.length - 1][0] : "";
  for (let k = 0; k < project && cursor; k++) {
    cursor = nextMonth(cursor);
    projected.push({ ym: cursor, sen: avg });
  }
  return { actual, projected };
}
