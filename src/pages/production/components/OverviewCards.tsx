import { memo, useMemo } from "react";
import { AlertTriangle, Building2 } from "lucide-react";
import type { Cell, ProductionOrder } from "../types";
import {
  CARD_HEIGHT,
  CARD_HEIGHT_NARROW,
  cellFor,
  fmtShortDate,
  overviewRowLook,
  stageKind,
  stageTint,
  type CellFlash,
  type StageClick,
  type StageConfig,
  type StageKind,
} from "../utils";
import { ProductDetailLine } from "./ProductDetailLine";

// Production Overview "Cards" view: one card per work order = a one-line
// header (order metadata) over a row of stage tiles (label, status pill,
// date). Each card is ONE virtual row in OverviewVirtualRows with a fixed
// height, so header + stages can never desync. The stage row is a CSS grid
// with one equal track per stage, so adding a stage (see overviewStages)
// needs no layout change and nothing scrolls sideways. Shared helpers
// (overviewRowLook, stageTint, stageKind, CARD_HEIGHT) live in ../utils.
// The Grid view keeps the original CellBox colours; this look is Cards only.
//
// Width: the cards' scroll box is an @container. Below 56rem (@max-4xl) a
// card switches to a two-line header and puts its stages in two rows
// (ceil(n / 2) columns), with its own fixed height (CARD_HEIGHT_NARROW).

const PILL: Record<StageKind, string> = {
  done: "bg-[#2D5A54] text-white",
  inProgress: "bg-[#2563EB] text-white",
  pending: "bg-[#B0892A] text-white",
  overdue: "bg-[#991B1B] text-white",
  skipped: "border border-dashed border-[#D1CCC4] text-[#9CA3AF]",
};

const StageCell = memo(function StageCell({
  order,
  stage,
  cell,
  tint,
  onStageClick,
}: {
  order: ProductionOrder;
  stage: StageConfig;
  cell: Cell;
  tint: "ok" | "err" | "";
  onStageClick: StageClick;
}) {
  const kind = stageKind(cell);
  const clickable = kind !== "skipped";
  const date = kind === "done" ? cell.latestCompleted || cell.earliestDue : cell.earliestDue;
  return (
    <div
      className={`min-w-0 flex flex-col items-center rounded-md transition-colors ${clickable ? "cursor-pointer hover:bg-[#F7F5F1]" : ""} ${
        tint === "ok" ? "bg-green-100" : tint === "err" ? "bg-red-100" : ""
      }`}
      onClick={clickable ? (e) => onStageClick(order, stage.code, cell, e.currentTarget) : undefined}
      onDoubleClick={(e) => e.stopPropagation()}
      title={clickable ? `${stage.name}: click to reschedule` : `${stage.name}: not applicable`}
    >
      <span className="h-4 max-w-full truncate text-[11px] leading-4 uppercase tracking-wide text-[#6B7280]">
        {stage.name}
      </span>
      <span
        className={`mt-0.5 h-6 w-full max-w-14 flex items-center justify-center gap-0.5 rounded-md text-xs font-semibold tabular-nums ${PILL[kind]}`}
      >
        {kind === "overdue" && <AlertTriangle className="h-3 w-3" strokeWidth={2.5} />}
        {kind === "skipped" ? "N/A" : `${cell.doneCards}/${cell.totalCards}`}
      </span>
      <span
        className={`mt-0.5 h-3.5 flex items-center gap-1 text-[11px] leading-[14px] tabular-nums ${
          kind === "overdue" ? "font-bold text-[#991B1B]" : kind === "skipped" ? "text-[#D1CCC4]" : "text-[#6B7280]"
        }`}
      >
        {kind === "skipped" ? "—" : `${kind === "overdue" ? "! " : ""}${fmtShortDate(date)}`}
        {/* Off-leadtime: a JC's date was moved off the leadtime plan. Done
            stages suppress it (the work already shipped). */}
        {cell.isOffLeadtime && kind !== "done" && kind !== "skipped" && (
          <span className="h-1.5 w-1.5 rounded-full bg-[#22D3EE]" title="Date moved off the leadtime plan" />
        )}
      </span>
    </div>
  );
});

export function StagePipeline({
  order,
  orders,
  stages,
  cellFlash,
  onStageClick,
}: {
  order: ProductionOrder;
  orders: ProductionOrder[];
  stages: StageConfig[];
  cellFlash: CellFlash;
  onStageClick: StageClick;
}) {
  // FAB_CUT sibling-walk needs the FULL order list (not the filtered one) —
  // see the Grid's cellFor call. Memoized so a selection tick or a flash on
  // another card doesn't rebuild these cells.
  const cells = useMemo(() => stages.map((s) => cellFor(order, s.code, orders)), [order, orders, stages]);
  return (
    <div
      className="grid gap-1 grid-cols-[repeat(var(--cols),minmax(0,1fr))] @max-4xl:grid-cols-[repeat(var(--cols-narrow),minmax(0,1fr))]"
      style={{ "--cols": stages.length, "--cols-narrow": Math.ceil(stages.length / 2) } as React.CSSProperties}
    >
      {stages.map((s, i) => (
        <StageCell
          key={s.code}
          order={order}
          stage={s}
          cell={cells[i]}
          tint={stageTint(order, s.code, cellFlash)}
          onStageClick={onStageClick}
        />
      ))}
    </div>
  );
}

const BADGE = "rounded-md bg-[#F3EFE7] px-2 py-0.5 text-[11px] text-[#6B7280] whitespace-nowrap";

export function WorkOrderHeader({
  order,
  selected,
  onToggle,
  onOpen,
}: {
  order: ProductionOrder;
  selected: boolean;
  onToggle: (id: string) => void;
  onOpen: (order: ProductionOrder) => void;
}) {
  const look = overviewRowLook(order, selected, "hover:bg-[#FAF8F4]");
  return (
    <div
      className={`min-h-7 -mx-1 px-1 rounded flex flex-wrap items-center gap-x-2.5 gap-y-0.5 cursor-pointer text-xs ${look.rowCls}`}
      // Single click toggles selection, double click opens the order — same
      // as a Grid row.
      onClick={() => onToggle(order.id)}
      onDoubleClick={() => onOpen(order)}
    >
      <input
        type="checkbox"
        aria-label={`Select order ${order.poNo}`}
        checked={selected}
        onChange={() => onToggle(order.id)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        className="cursor-pointer flex-shrink-0"
      />
      <span className="h-7 flex items-center text-[13px] font-bold text-[#1F1D1B] tabular-nums flex-shrink-0">{order.poNo}</span>
      {look.pillLabel && (
        <span
          className={`text-[9px] font-semibold px-1.5 py-[1px] rounded uppercase tracking-wide no-underline cursor-default flex-shrink-0 ${look.pillCls}`}
          title={look.holdTooltip || undefined}
        >
          {look.pillLabel}
        </span>
      )}
      {/* Product / specs / PO / hold reason / customer. Wide: fills the space
          between the SO ID and the badges. Narrow: drops to its own line. */}
      <div className="flex-1 min-w-0 h-7 flex items-center gap-2 text-[#6B7280] @max-4xl:order-last @max-4xl:basis-full @max-4xl:h-[18px] @max-4xl:pl-6">
        <div className="min-w-0 flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
          <span className="font-semibold text-[#3A2E22]">{order.productCode}</span>
          <span>·</span>
          <ProductDetailLine order={order} />
          {order.customerPOId && <span className="doc-number">· PO {order.customerPOId}</span>}
          {look.holdReason && (
            <span className="text-[10px] italic text-[#9C6F1E]/70 truncate" title={look.holdTooltip}>
              On hold: {look.holdReason}
            </span>
          )}
        </div>
        <span className="flex items-center gap-1 flex-shrink-0 max-w-[40%] truncate" title={order.customerName}>
          <Building2 className="h-3 w-3 flex-shrink-0 text-[#9CA3AF]" />
          <span className="truncate">{order.customerName}</span>
        </span>
      </div>
      <div className="ml-auto flex items-center gap-1.5 flex-shrink-0 tabular-nums">
        {order.specialOrder && (
          <span
            className="rounded-md bg-[#FBEAE7] px-2 py-0.5 text-[11px] font-semibold text-[#991B1B] truncate max-w-[160px] @max-4xl:max-w-[90px]"
            title={order.specialOrder}
          >
            {order.specialOrder}
          </span>
        )}
        <span className={BADGE}>Qty: <b className="text-[#1F1D1B]">{order.quantity}</b></span>
        <span className={BADGE}>Cust DD: <b className="text-[#1F1D1B]">{order.customerDeliveryDate ? fmtShortDate(order.customerDeliveryDate) : "—"}</b></span>
        <span className={BADGE}>Our DD: <b className="text-[#1F1D1B]">{order.hookkaExpectedDD ? fmtShortDate(order.hookkaExpectedDD) : "—"}</b></span>
      </div>
    </div>
  );
}

// One virtual row. Memoized: with stable handlers from ProductionPage, a
// checkbox tick re-renders only the ticked card, and a scroll frame re-renders
// none of the already-mounted ones. The row's height is fixed (CARD_HEIGHT,
// or CARD_HEIGHT_NARROW in a narrow list) so every card is the same height;
// the virtualizer measures each row, so the narrow height needs no estimate.
export const WorkOrderCard = memo(function WorkOrderCard({
  index,
  start,
  measureRef,
  order,
  orders,
  stages,
  selected,
  cellFlash,
  onToggle,
  onOpen,
  onStageClick,
}: {
  index: number;
  start: number;
  measureRef: (el: Element | null) => void;
  order: ProductionOrder;
  orders: ProductionOrder[];
  stages: StageConfig[];
  selected: boolean;
  cellFlash: CellFlash;
  onToggle: (id: string) => void;
  onOpen: (order: ProductionOrder) => void;
  onStageClick: StageClick;
}) {
  return (
    <div
      ref={measureRef}
      data-index={index}
      className="absolute top-0 left-0 right-0 px-2 pt-2 h-(--card-h) @max-4xl:h-(--card-h-narrow)"
      style={
        {
          "--card-h": `${CARD_HEIGHT}px`,
          "--card-h-narrow": `${CARD_HEIGHT_NARROW}px`,
          transform: `translateY(${start}px)`,
        } as React.CSSProperties
      }
    >
      <div
        className={`h-full overflow-hidden rounded-lg border bg-white p-2.5 shadow-sm ${
          selected ? "border-[#C9A227]" : "border-[#E6E0D9]"
        }`}
      >
        <WorkOrderHeader order={order} selected={selected} onToggle={onToggle} onOpen={onOpen} />
        <div className="mt-1.5 pt-1 border-t border-[#EFEAE2]">
          <StagePipeline order={order} orders={orders} stages={stages} cellFlash={cellFlash} onStageClick={onStageClick} />
        </div>
      </div>
    </div>
  );
});
