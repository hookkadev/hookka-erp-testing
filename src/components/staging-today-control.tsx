// Staging-only: never PR this into main.
// Topbar control for the "today override" (src/lib/staging-today.ts). Off by
// default; set per tab. While active it shows a red "Fake date" banner in the
// sticky topbar. Setting or clearing reloads the page so every screen re-reads.
import { readStagingToday, writeStagingToday } from "@/lib/staging-today";

const TIP =
  "Staging only, this tab only. The fake date affects READS only: production overdue counts and the production grid's overdue marks, and the Accounting overview P&L month. Dates written into documents (created, completed, effective dates) still use the real date. Most other screens (aging, leave, payroll) still use the real date.";

function apply(v: string | null) {
  writeStagingToday(v);
  window.location.reload();
}

export function StagingTodayControl() {
  if (!window.location.hostname.startsWith("staging.")) return null;
  const active = readStagingToday();
  if (active) {
    return (
      <span title={TIP} className="flex items-center gap-2 rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white">
        Fake date: {active}
        <button type="button" onClick={() => apply(null)} className="rounded bg-white/20 px-1.5 hover:bg-white/30">
          Clear
        </button>
      </span>
    );
  }
  return (
    <form
      title={TIP}
      className="flex items-center gap-1 rounded-md bg-amber-100 px-2 py-0.5 text-xs text-amber-800"
      onSubmit={(e) => {
        e.preventDefault();
        const v = new FormData(e.currentTarget).get("fakeToday");
        if (typeof v === "string" && v) apply(v);
      }}
    >
      <input type="date" name="fakeToday" aria-label="Fake today" className="bg-transparent text-xs" />
      <button type="submit" className="rounded px-1.5 font-medium hover:bg-amber-200">
        Set fake date
      </button>
    </form>
  );
}
