// Shared helpers extracted from production/index.tsx.
import type { Cell, CellState, ProductionOrder } from "./types";

export const DEPARTMENTS = [
  { name: "Fab Cut",    code: "FAB_CUT" },
  { name: "Fab Sew",    code: "FAB_SEW" },
  { name: "Foam Cutting", code: "FOAM_CUTTING" },
  { name: "Foam Bonding", code: "FOAM" },
  { name: "Wood Cut",   code: "WOOD_CUT" },
  { name: "Framing",    code: "FRAMING" },
  { name: "Webbing",    code: "WEBBING" },
  { name: "Upholstery", code: "UPHOLSTERY" },
  { name: "Packing",    code: "PACKING" },
] as const;

export type StageConfig = { code: string; name: string };
export type LiveDepartment = {
  code: string;
  name: string;
  shortName?: string;
  sequence: number;
  isProduction: boolean;
};

// Overview stage columns. The 9 DEPARTMENTS keep their current order and
// labels no matter what /api/departments says (the DB `sequence` puts
// WOOD_CUT 3rd; the floor reads it 5th, so we don't reorder). Any other
// isProduction department added in the admin UI is appended by sequence,
// so a new stage shows up with no code change. `live` null/empty (loading
// or a failed read) = the constant alone.
export function overviewStages(live?: LiveDepartment[] | null): StageConfig[] {
  const base: StageConfig[] = DEPARTMENTS.map((d) => ({ code: d.code, name: d.name }));
  if (!live || live.length === 0) return base;
  const known = new Set(base.map((d) => d.code));
  const extra = live
    .filter((d) => d.isProduction && !known.has(d.code))
    .sort((a, b) => a.sequence - b.sequence)
    .map((d) => ({ code: d.code, name: d.shortName || d.name }));
  return extra.length > 0 ? [...base, ...extra] : base;
}

// ----- Overview Cards view helpers (components/OverviewCards.tsx + the Grid) -----

export type CellFlash = Record<string, "ok" | "err">;
export type StageClick = (
  order: ProductionOrder,
  deptCode: string,
  cell: Cell,
  anchor: HTMLElement,
) => void;

// Header bar + pipeline heights are fixed so every card is the same height
// and the virtualizer's estimate is exact (no jump while fast-scrolling).
export const CARD_HEIGHT = 82;
export const pipelineCols = (n: number) => `repeat(${n}, minmax(0, 1fr))`;

// Lifecycle look shared by the Grid rows and the Card header bar: amber for
// ON_HOLD, grey + strikethrough for CANCELLED, warm highlight when ticked
// (overrides the lifecycle tint so the selection reads clearly).
export function overviewRowLook(
  order: ProductionOrder,
  isSelected: boolean,
  plainCls = "hover:bg-[#FDFBF7]",
) {
  const rowCls = isSelected
    ? "bg-[#FFF8E6] hover:bg-[#FBEFC9]"
    : order.status === "ON_HOLD"
      ? "bg-[#FEF6D8] hover:bg-[#FBEBAE]"
      : order.status === "CANCELLED"
        ? "bg-[#F3F4F6] text-[#9CA3AF] line-through hover:bg-[#E5E7EB]"
        : plainCls;
  const pillLabel =
    order.status === "ON_HOLD" ? "ON HOLD" : order.status === "CANCELLED" ? "CANCELLED" : "";
  const pillCls =
    order.status === "ON_HOLD"
      ? "bg-[#FAEFCB] text-[#9C6F1E]"
      : order.status === "CANCELLED"
        ? "bg-[#E5E7EB] text-[#4B5563]"
        : "";
  // ON HOLD reason (0185) — full reason + who + when in the chip tooltip.
  const holdReason = order.status === "ON_HOLD" ? (order.holdReason || "").trim() : "";
  const holdTooltip = holdReason
    ? `On hold: ${holdReason}${order.heldBy ? ` — ${order.heldBy}` : ""}${order.heldAt ? ` (${order.heldAt})` : ""}`
    : "";
  return { rowCls, pillLabel, pillCls, holdReason, holdTooltip };
}

// A dept cell may hold several JCs (a sofa with several WIPs in one dept);
// flash keys are per JC, so OR them: any "err" wins, then any "ok".
export function stageTint(order: ProductionOrder, deptCode: string, cellFlash: CellFlash): "ok" | "err" | "" {
  let tint: "ok" | "err" | "" = "";
  for (const jc of order.jobCards) {
    if (jc.departmentCode !== deptCode) continue;
    const k = cellFlash[`${jc.id}|${deptCode}`];
    if (k === "err") return "err";
    if (k === "ok") tint = "ok";
  }
  return tint;
}

// Today as YYYY-MM-DD. Used for the page's default fltDueFrom/fltDueTo so
// the production grid (and the API call that backs it) only loads POs
// whose targetEndDate falls on today by default.
export function todayISO(): string {
  // Malaysia-local date (UTC+8, no DST). `new Date().toISOString()` is UTC, so
  // before 08:00 MYT it returns YESTERDAY — which mis-classified cells as
  // "pending" instead of "overdue", and made different users (different
  // timezones / device clocks) see different overdue sets for the same data.
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function fmtShortDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const mm = d.toLocaleString("en-US", { month: "short" });
  return `${d.getDate()} ${mm}`;
}

export function cellFor(
  order: ProductionOrder,
  deptCode: string,
  allOrders?: ProductionOrder[],
): Cell {
  let cards = order.jobCards.filter((j) => j.departmentCode === deptCode);
  // Option C — for FAB_CUT, the merged JC may live on the anchor PO of a
  // SOFA cross-PO group; this PO is a sibling and has zero FC JCs of its
  // own. Walk same-(SO|CO)/same-baseModel/same-fabric siblings and
  // surface the anchor's FC so the Overview cell isn't blank.
  // Consignment-Order POs use companyCOId / consignmentOrderId (not
  // companySOId / salesOrderId), so include both pairs in the order key
  // — without this, every sibling-of-anchor row in a CO group rendered
  // blank even though fabric was already cut.
  if (deptCode === "FAB_CUT" && cards.length === 0 && allOrders) {
    const myGroupId =
      order.companySOId ||
      order.salesOrderId ||
      order.companyCOId ||
      order.consignmentOrderId ||
      "";
    if (myGroupId) {
      const isSofa = order.itemCategory === "SOFA";
      const myBase = (order.productCode || "").split("-")[0];
      const myFabric = order.fabricCode || "";
      for (const sib of allOrders) {
        if (sib.id === order.id) continue;
        const sibGroupId =
          sib.companySOId ||
          sib.salesOrderId ||
          sib.companyCOId ||
          sib.consignmentOrderId ||
          "";
        if (sibGroupId !== myGroupId) continue;
        if (isSofa) {
          if ((sib.fabricCode || "") !== myFabric) continue;
          const sibBase = (sib.productCode || "").split("-")[0];
          if (sibBase !== myBase) continue;
        }
        const sibFc = sib.jobCards.filter((j) => j.departmentCode === "FAB_CUT");
        if (sibFc.length > 0) {
          cards = sibFc;
          break;
        }
      }
    }
  }
  if (cards.length === 0) {
    return {
      state: "empty",
      totalCards: 0,
      doneCards: 0,
      earliestDue: "",
      latestCompleted: "",
      isOffLeadtime: false,
    };
  }
  const done = cards.filter(
    (c) => c.status === "COMPLETED" || c.status === "TRANSFERRED",
  ).length;
  const earliestDue =
    cards.map((c) => c.dueDate).filter(Boolean).sort()[0] || "";
  const latestCompleted =
    cards.map((c) => c.completedDate || "").filter(Boolean).sort().slice(-1)[0] || "";

  let state: CellState;
  if (done === cards.length) state = "done";
  else {
    // Malaysia-local "today" (see todayISO) so overdue is consistent for all
    // users regardless of their browser timezone / clock.
    const today = todayISO();
    state = earliestDue && earliestDue < today ? "overdue" : "pending";
  }
  // Off-leadtime signal: any JC whose persisted dueDate doesn't match
  // the server-computed expectedDueDate (current leadtime plan).
  // Empty expectedDueDate = "no signal" (treat as on-plan). Done
  // suppresses the override — ✓ stays white per spec.
  const isOffLeadtime =
    state !== "done" &&
    cards.some(
      (c) =>
        !!c.expectedDueDate &&
        !!c.dueDate &&
        c.expectedDueDate !== c.dueDate,
    );
  return {
    state,
    totalCards: cards.length,
    doneCards: done,
    earliestDue,
    latestCompleted,
    isOffLeadtime,
  };
}

// Whole-PO overdue predicate. Two modes (dept = null vs string):
//
//   Overview mode (dept = null): "will we ship on time?". A PO is overdue
//   when its SO "Our Expected DD" (hookkaExpectedDD — the date the operator
//   reads in the Overview cell) has passed AND the PO's UPHOLSTERY JC isn't
//   done (COMPLETED / TRANSFERRED). UPH is the ship-readiness gate — once UPH
//   is done the PO is effectively ready. POs without any UPH JC (legacy /
//   non-upholstered items) are skipped so the count never accuses something
//   that has no UPH stage. A PO with no hookkaExpectedDD (empty, or CO-origin
//   which never gets one) can't be late against a date it doesn't have, so it
//   is never overdue here (2026-06-10 — was keyed off targetEndDate).
//
//   Per-dept mode (dept = "FAB_CUT" | "FAB_SEW" | …): "is this dept
//   missing its own deadline?". A PO is overdue at this dept when one of
//   its JCs for that dept has dueDate < today AND isn't done. POs with
//   no JC for that dept are skipped (the cell is empty in the matrix; we
//   don't accuse a dept of being late on work it doesn't own).
//
// Returns false for COMPLETED / CANCELLED POs in both modes so the count
// never includes already-shipped or killed orders.
export function isOverduePO(
  po: ProductionOrder,
  today: string,
  dept: string | null = null,
): boolean {
  if (po.status === "COMPLETED" || po.status === "CANCELLED") return false;

  if (dept === null) {
    // Overview rule: SO "Our Expected DD" passed AND UPHOLSTERY not done.
    if (!po.hookkaExpectedDD || po.hookkaExpectedDD >= today) return false;
    const uph = (po.jobCards ?? []).filter((j) => j.departmentCode === "UPHOLSTERY");
    if (uph.length === 0) return false;
    return uph.some((j) => j.status !== "COMPLETED" && j.status !== "TRANSFERRED");
  }

  // Per-dept rule: that dept's JC dueDate passed AND not done.
  const deptJcs = (po.jobCards ?? []).filter((j) => j.departmentCode === dept);
  if (deptJcs.length === 0) return false;
  return deptJcs.some(
    (j) =>
      !!j.dueDate &&
      j.dueDate < today &&
      j.status !== "COMPLETED" &&
      j.status !== "TRANSFERRED",
  );
}

// Earliest overdue date associated with this PO, scoped to the same
// rule as isOverduePO. Used to sort the per-SO overdue breakdown list
// "earliest first" so the operator can prioritize. Returns "" if the PO
// is not overdue under the given rule.
//
//   Overview (dept = null): if hookkaExpectedDD < today AND UPH is open,
//   return hookkaExpectedDD (the SO "Our Expected DD" is the anchor the
//   operator reads — UPH dueDate isn't what slipped against the promise).
//   Returns "" otherwise (incl. empty / CO-origin DD — 2026-06-10).
//
//   Per-dept (dept = string): earliest dueDate across that dept's open
//   JCs that have already passed today. Returns "" if no such JC.
export function earliestOverdueDateOnPO(
  po: ProductionOrder,
  today: string,
  dept: string | null = null,
): string {
  if (po.status === "COMPLETED" || po.status === "CANCELLED") return "";

  if (dept === null) {
    if (!po.hookkaExpectedDD || po.hookkaExpectedDD >= today) return "";
    const uph = (po.jobCards ?? []).filter((j) => j.departmentCode === "UPHOLSTERY");
    if (uph.length === 0) return "";
    const stillOpen = uph.some(
      (j) => j.status !== "COMPLETED" && j.status !== "TRANSFERRED",
    );
    return stillOpen ? po.hookkaExpectedDD : "";
  }

  let earliest = "";
  for (const jc of po.jobCards ?? []) {
    if (jc.departmentCode !== dept) continue;
    if (!jc.dueDate) continue;
    if (jc.status === "COMPLETED" || jc.status === "TRANSFERRED") continue;
    if (jc.dueDate < today) {
      if (!earliest || jc.dueDate < earliest) earliest = jc.dueDate;
    }
  }
  return earliest;
}
