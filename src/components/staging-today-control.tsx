// Staging-only: never PR this into main.
// Topbar control for the "today override" (src/lib/staging-today.ts). Off by
// default; set per tab. While active it shows a red "Fake date" banner in the
// sticky topbar. Setting or clearing reloads the page so every screen re-reads.
import { CalendarClock } from "lucide-react";
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
      <span title={TIP} className="flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-red-600 px-3 text-xs font-semibold text-white">
        <CalendarClock className="h-4 w-4" />
        <span className="hidden xl:inline">Fake date:</span> {active}
        <button type="button" onClick={() => apply(null)} className="rounded-full bg-white/20 px-2 py-0.5 hover:bg-white/30">
          Clear
        </button>
      </span>
    );
  }
  return (
    <form
      title={TIP}
      className="flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-amber-100 pl-3 pr-1 text-xs text-amber-800"
      onSubmit={(e) => {
        e.preventDefault();
        const v = new FormData(e.currentTarget).get("fakeToday");
        if (typeof v === "string" && v) apply(v);
      }}
    >
      <CalendarClock className="h-4 w-4 shrink-0" />
      <input type="date" name="fakeToday" aria-label="Fake today" className="w-[7.5rem] cursor-pointer bg-transparent text-xs outline-none" />
      <button type="submit" title="Set fake date" className="h-7 rounded-full px-2.5 font-semibold hover:bg-amber-200">
        Set
      </button>
    </form>
  );
}
