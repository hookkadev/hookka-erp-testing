// Staging-only test tool: plan the job-card writes that push a sales order's
// production orders up to a chosen stage, or back to WAITING. The writes go
// through the normal POST /api/production-orders/bulk-patch, so every cascade
// fires exactly as for an operator's "Apply Completion Date".
//
// bulk-patch runs a batch in parallel and the upstream sequence lock
// (src/api/lib/sequence-lock.ts) refuses a card whose lower-sequence cards in
// the same chain are not done, so completion is split into waves by
// `sequence`, sent one after another. Each wave is also cut to bulk-patch's
// 50-patch limit.
import { REPAIR_DEPT_CODES } from "./repair-scope";

export type SkipJobCard = {
  id: string;
  departmentCode: string;
  sequence: number;
  status: string;
};
export type SkipPO = { id: string; jobCards: SkipJobCard[] };
export type SkipPatch = {
  poId: string;
  jobCardId: string;
  completedDate: string;
  status: "COMPLETED" | "WAITING";
};

const MAX_BATCH = 50;
const SETTLED = new Set(["COMPLETED", "TRANSFERRED", "CANCELLED"]);

function chunk<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += MAX_BATCH) out.push(xs.slice(i, i + MAX_BATCH));
  return out;
}

/** Batches to send in order: every open card at or before `upTo`, by sequence. */
export function planCompleteUpTo(pos: SkipPO[], upTo: string, date: string): SkipPatch[][] {
  const cutoff = (REPAIR_DEPT_CODES as readonly string[]).indexOf(upTo);
  if (cutoff < 0) return [];
  const bySeq = new Map<number, SkipPatch[]>();
  for (const po of pos) {
    for (const jc of po.jobCards) {
      const dept = (REPAIR_DEPT_CODES as readonly string[]).indexOf(jc.departmentCode);
      if (dept < 0 || dept > cutoff || SETTLED.has(String(jc.status).toUpperCase())) continue;
      const seq = Number(jc.sequence) || 0;
      if (!bySeq.has(seq)) bySeq.set(seq, []);
      bySeq.get(seq)!.push({ poId: po.id, jobCardId: jc.id, completedDate: date, status: "COMPLETED" });
    }
  }
  return [...bySeq.keys()].sort((a, b) => a - b).flatMap((s) => chunk(bySeq.get(s)!));
}

/** Batches that put every completed card back to WAITING. */
export function planReset(pos: SkipPO[]): SkipPatch[][] {
  const patches = pos.flatMap((po) =>
    po.jobCards
      .filter((jc) => String(jc.status).toUpperCase() === "COMPLETED")
      .map((jc) => ({ poId: po.id, jobCardId: jc.id, completedDate: "", status: "WAITING" as const })),
  );
  return chunk(patches);
}
