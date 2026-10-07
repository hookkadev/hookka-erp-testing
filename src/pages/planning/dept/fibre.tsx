// ---------------------------------------------------------------------------
// Planning > Fibre department drill-in.
//
// Fibre is a production stage placed immediately BEFORE Upholstery (owner
// 2026-10-07), so the floor can track and schedule fibre filling on its own
// department.
//
// Same shape as Foam Cutting when it first shipped: there is no forward-capacity
// schedule endpoint or owner-confirmed capacity number for Fibre yet, so this
// page renders the saved (empty) snapshot via the shared _DepartmentSchedulePage
// and the live Recalculate fetch 404s and falls back to it. Adding a Fibre
// capacity stage to the planning engine is deferred until the owner gives
// minutes/day.
// ---------------------------------------------------------------------------
import { Layers } from "lucide-react";
import snapshot from "@/data/fibre-schedule-snapshot.json";
import DepartmentSchedulePage, {
  type Snapshot,
  type CalendarConfig,
  type ByDayConfig,
} from "./_DepartmentSchedulePage";

// Sheet columns: 0 Fill Date, 1 Lane, 2 SO ID, 3 Model, 4 Item, 5 Pieces,
// 6 Mins, 7 Customer DD, 8 Upstream.
const CALENDAR_CONFIG: CalendarConfig = {
  headers: [
    "Fill Date",
    "Lane",
    "SO ID",
    "Model",
    "Item",
    "Pieces",
    "Mins",
    "Customer DD",
    "Upstream",
  ],
  laneCol: 1,
  groupKeyCol: 2,
  groupChipPrefix: "SO",
  cddCol: 7,
  wideCol: 4,
  chips: [
    { label: "SO", kind: "count" },
    { label: "min", kind: "sum", col: 6 },
  ],
};

// Sheet columns: 0 Date, 1 Day, 2 Lane, 3 SOs that day, 4 SOs, 5 Fill h, 6 Cap h.
const BY_DAY_CONFIG: ByDayConfig = {
  mode: "lane",
  dateCol: 0,
  dayCol: 1,
  laneCol: 2,
  laneHeaders: ["Lane", "SOs that day", "SOs", "Fill h", "Cap h"],
  laneValueCols: [2, 3, 4, 5, 6],
  wideCol: 3,
};

export default function FibreDeptPage() {
  return (
    <DepartmentSchedulePage
      departmentName="Fibre"
      subtitle="Fibre filling, the stage before upholstery"
      upstream={[{ label: "Foam Bonding", route: "/planning/dept/foam-bonding" }]}
      icon={<Layers className="h-4 w-4 text-[#84CC16]" />}
      accentColor="#84CC16"
      snapshot={snapshot as unknown as Snapshot}
      fetchUrl="/api/planning/schedule/fibre"
      calendarSheetName="Fibre Calendar"
      calendarConfig={CALENDAR_CONFIG}
      calendarHeading="Fibre Calendar"
      byDaySheetName="By Day"
      byDayConfig={BY_DAY_CONFIG}
    />
  );
}
