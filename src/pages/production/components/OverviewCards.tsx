import { memo, useMemo } from "react";
import type { Cell, ProductionOrder } from "../types";
import {
  cellFor,
  fmtShortDate,
  overviewRowLook,
  pipelineCols,
  stageTint,
  type CellFlash,
  type StageClick,
  type StageConfig,
} from "../utils";
import { CellBox } from "./CellBox";
import { ProductDetailLine } from "./ProductDetailLine";

// Production Overview "Cards" view: one card per work order = a one-line
// header bar (order metadata) over a full-width stage pipeline. Each card is
// ONE virtual row in OverviewVirtualRows, so header + pipeline can never
// desync heights. The pipeline is a CSS grid with one equal track per stage,
// so adding a stage (see overviewStages) needs no layout change and nothing
// scrolls sideways. Shared helpers (overviewRowLook, stageTint, CARD_HEIGHT)
// live in ../utils.

const StageCell = memo(function StageCell({
  order,
  code,
  cell,
  tint,
  onStageClick,
}: {
  order: ProductionOrder;
  code: string;
  cell: Cell;
  tint: "ok" | "err" | "";
  onStageClick: StageClick;
}) {
  const clickable = cell.state !== "empty";
  return (
    <div
      className={`h-11 border-l border-[#F0EBE3] first:border-l-0 transition-colors ${clickable ? "cursor-pointer" : ""} ${
        tint === "ok" ? "bg-green-100" : tint === "err" ? "bg-red-100" : ""
      }`}
      onClick={clickable ? (e) => onStageClick(order, code, cell, e.currentTarget) : undefined}
      onDoubleClick={(e) => e.stopPropagation()}
      title={clickable ? "Click to reschedule" : undefined}
    >
      <CellBox cell={cell} />
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
    <div className="grid" style={{ gridTemplateColumns: pipelineCols(stages.length) }}>
      {stages.map((s, i) => (
        <StageCell
          key={s.code}
          order={order}
          code={s.code}
          cell={cells[i]}
          tint={stageTint(order, s.code, cellFlash)}
          onStageClick={onStageClick}
        />
      ))}
    </div>
  );
}

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
  const look = overviewRowLook(order, selected, "bg-[#FAF8F4] hover:bg-[#F3EFE7]");
  return (
    <div
      className={`h-9 px-2 flex items-center justify-between gap-4 cursor-pointer text-xs ${look.rowCls}`}
      // Single click toggles selection, double click opens the order — same
      // as a Grid row.
      onClick={() => onToggle(order.id)}
      onDoubleClick={() => onOpen(order)}
    >
      <div className="flex items-center gap-3 min-w-0">
        <input
          type="checkbox"
          aria-label={`Select order ${order.poNo}`}
          checked={selected}
          onChange={() => onToggle(order.id)}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          className="cursor-pointer flex-shrink-0"
        />
        <span className="font-bold text-[#1F1D1B] tabular-nums flex-shrink-0">{order.poNo}</span>
        {look.pillLabel && (
          <span
            className={`text-[9px] font-semibold px-1.5 py-[1px] rounded uppercase tracking-wide no-underline cursor-default flex-shrink-0 ${look.pillCls}`}
            title={look.holdTooltip || undefined}
          >
            {look.pillLabel}
          </span>
        )}
        <span className="doc-number text-[#6B7280] truncate max-w-[140px] flex-shrink-0" title={order.customerPOId || ""}>
          {order.customerPOId || "—"}
        </span>
        <div className="flex items-center gap-2 min-w-0 overflow-hidden whitespace-nowrap">
          <span className="font-semibold text-[#1F1D1B]">{order.productCode}</span>
          <ProductDetailLine order={order} />
          {look.holdReason && (
            <span className="text-[10px] italic text-[#9C6F1E]/70 truncate" title={look.holdTooltip}>
              On hold: {look.holdReason}
            </span>
          )}
        </div>
        <span className="text-[#6B7280] truncate min-w-[60px]" title={order.customerName}>
          {order.customerName}
        </span>
      </div>
      <div className="flex items-center gap-4 flex-shrink-0 text-[11px] text-[#6B7280] tabular-nums">
        {order.specialOrder && (
          <span className="text-[#9A3A2D] font-semibold truncate max-w-[160px]" title={order.specialOrder}>
            {order.specialOrder}
          </span>
        )}
        <span>Qty <b className="text-[#1F1D1B]">{order.quantity}</b></span>
        <span>Cust DD <b className="text-[#1F1D1B]">{order.customerDeliveryDate ? fmtShortDate(order.customerDeliveryDate) : "—"}</b></span>
        <span>Our DD <b className="text-[#1F1D1B]">{order.hookkaExpectedDD ? fmtShortDate(order.hookkaExpectedDD) : "—"}</b></span>
      </div>
    </div>
  );
}

// One virtual row. Memoized: with stable handlers from ProductionPage, a
// checkbox tick re-renders only the ticked card, and a scroll frame re-renders
// none of the already-mounted ones.
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
      className="absolute top-0 left-0 right-0 border-b-2 border-[#E6E0D9] bg-white"
      style={{ transform: `translateY(${start}px)` }}
    >
      <WorkOrderHeader order={order} selected={selected} onToggle={onToggle} onOpen={onOpen} />
      <StagePipeline order={order} orders={orders} stages={stages} cellFlash={cellFlash} onStageClick={onStageClick} />
    </div>
  );
});
