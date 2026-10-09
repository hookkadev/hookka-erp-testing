// ---------------------------------------------------------------------------
// jobcard-sync — reconcile an existing PO's job_cards set with its CURRENT
// BOM template. Fixes the class of bug where a BOM was edited after POs were
// already created (e.g. migrations/0027 + 0029 adding UPHOLSTERY + PACKING to
// sofa variants, or the 5536-CSL / 5537-STOOL missing-FAB_CUT discovery):
// the POs kept their original JC set and had to be patched by hand.
//
// Endpoint:
//   POST /api/production/sync-jobcards-from-bom             — scan every PO
//   POST /api/production/sync-jobcards-from-bom?poId=XYZ    — scan one PO
//
// Semantics (idempotent):
//   For every (wipKey, deptCode) pair the CURRENT ACTIVE BOM expects, check
//   for an existing job_cards row on (productionOrderId, wipKey, deptCode).
//   If missing, INSERT a new row with status='WAITING', dueDate=po.targetEndDate,
//   PIC1/2 null, completedDate null. Existing JCs are never touched — use
//   /api/production-leadtimes or the dedicated recalc endpoint to refresh
//   dueDate/status.
//
// The BOM-resolution logic (ACTIVE first, fall back to most-recent) and the
// JC-row shape are imported from the shared helpers so this endpoint stays in
// lockstep with the SO-confirm path in sales-orders.ts.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { buildAuditStatement } from "../lib/audit";
import {
  breakBomIntoJobCardWips,
  deriveJobCardId,
  l1ProcessesWithoutWipDupes,
  type BomVariantContext,
} from "../lib/bom-wip-breakdown";

const app = new Hono<Env>();

type ProductionOrderRow = {
  id: string;
  salesOrderId: string | null;
  productCode: string | null;
  itemCategory: string | null;
  quantity: number;
  currentDepartment: string | null;
  targetEndDate: string | null;
  startDate: string | null;
  sizeCode: string | null;
  sizeLabel: string | null;
  fabricCode: string | null;
  gapInches: number | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
};

type L1Process = { deptCode: string; category: string; minutes: number };

// Mirror parseL1Processes from sales-orders.ts. Kept inline (not exported
// from sales-orders.ts) to preserve the "do not touch sales-orders.ts"
// constraint — the parser is small and stable.
function parseL1Processes(raw: string | null): L1Process[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((p) => ({
        deptCode: String((p as { deptCode?: unknown }).deptCode ?? ""),
        category: String((p as { category?: unknown }).category ?? ""),
        minutes: Number((p as { minutes?: unknown }).minutes) || 0,
      }))
      .filter((p) => p.deptCode.length > 0);
  } catch {
    return [];
  }
}

// Build the full (wipKey, deptCode) → {wipCode, wipLabel, wipType, wipQty,
// estMinutes, category, sequence} map the BOM currently expects for one PO.
// Covers both the L2 WIP chain (breakBomIntoWips output) and the FG-level
// l1Processes (wipKey="FG").
type ExpectedJc = {
  wipKey: string;
  wipCode: string;
  wipLabel: string;
  wipType: string;
  wipQty: number;
  deptCode: string;
  sequence: number;
  estMinutes: number;
  category: string;
  branchKey: string;
};

function computeExpectedJcs(
  po: ProductionOrderRow,
  bomRow: {
    wipComponents: string | null;
    l1Processes: string | null;
    baseModel: string | null;
  } | null,
): ExpectedJc[] {
  const productCode = po.productCode ?? "";
  const variants: BomVariantContext = {
    productCode,
    // Parent model from bom_templates.baseModel — fall back to productCode
    // when BOM didn't store one (so {MODEL} keeps the legacy variant value
    // for those rows instead of going blank). See BUG-2026-04-27-004.
    model: bomRow?.baseModel ?? productCode,
    sizeLabel: po.sizeLabel ?? "",
    sizeCode: po.sizeCode ?? "",
    fabricCode: po.fabricCode ?? "",
    divanHeightInches: po.divanHeightInches ?? null,
    legHeightInches: po.legHeightInches ?? null,
    gapInches: po.gapInches ?? null,
  };
  // Same rules as the SO-confirm builder: an L1-only BOM gets an
  // auto-generated chain of its L1 steps, and an L1 step a WIP card already
  // covers gets no FG card (BUG-2026-10-01-244).
  const l1ProcsAll = parseL1Processes(bomRow?.l1Processes ?? null);
  const wips = breakBomIntoJobCardWips(
    bomRow?.wipComponents ?? null,
    l1ProcsAll,
    productCode,
    variants,
  );
  const expected: ExpectedJc[] = [];
  for (const wip of wips) {
    const wipQty = Math.max(
      1,
      Math.floor((po.quantity || 1) * wip.quantityMultiplier),
    );
    for (let i = 0; i < wip.processes.length; i++) {
      const p = wip.processes[i];
      expected.push({
        wipKey: wip.wipKey,
        wipCode: p.wipCode || wip.wipCode,
        wipLabel: p.wipLabel || wip.wipLabel,
        wipType: wip.wipType,
        wipQty,
        deptCode: p.deptCode,
        sequence: i,
        estMinutes: p.minutes,
        category: p.category,
        // BOM-walker stamped this on the process — no category/dept hardcode.
        branchKey: p.branchKey ?? "",
      });
    }
  }
  // FG-level l1Processes — single JC per process, wipKey="FG".
  for (const l1p of l1ProcessesWithoutWipDupes(l1ProcsAll, wips)) {
    expected.push({
      wipKey: "FG",
      wipCode: productCode,
      wipLabel: productCode,
      wipType: "FG",
      wipQty: po.quantity || 1,
      deptCode: l1p.deptCode,
      sequence: 99,
      estMinutes: l1p.minutes,
      category: l1p.category,
      // FG-level joint terminals (UPHOLSTERY, PACKING) live at root —
      // shared by every branch, so no specific branch identifier.
      branchKey: "",
    });
  }
  return expected;
}

// Load ACTIVE BOM; fall back to most-recent. Mirrors sales-orders.ts.
async function loadBomTemplate(
  db: D1Database,
  productCode: string,
): Promise<{
  wipComponents: string | null;
  l1Processes: string | null;
  baseModel: string | null;
} | null> {
  if (!productCode) return null;
  type Row = {
    wipComponents: string | null;
    l1Processes: string | null;
    baseModel: string | null;
  };
  const active = await db
    .prepare(
      `SELECT wipComponents, l1Processes, baseModel FROM bom_templates
         WHERE productCode = ? AND versionStatus = 'ACTIVE'
         ORDER BY effectiveFrom DESC LIMIT 1`,
    )
    .bind(productCode)
    .first<Row>();
  if (active) return active;
  const latest = await db
    .prepare(
      `SELECT wipComponents, l1Processes, baseModel FROM bom_templates
         WHERE productCode = ? ORDER BY effectiveFrom DESC LIMIT 1`,
    )
    .bind(productCode)
    .first<Row>();
  return latest ?? null;
}

// Chunk an array into groups of n.
function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) {
    out.push(arr.slice(i, i + n));
  }
  return out;
}

// ---------------------------------------------------------------------------
// POST /api/production/sync-jobcards-from-bom
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  const denied = await requirePermission(c, "job-cards", "create");
  if (denied) return denied;
  const db = c.var.DB;
  const poIdParam = c.req.query("poId");

  // Load departments once — every INSERT needs deptId + deptName lookups.
  const deptRes = await db
    .prepare("SELECT id, code, name FROM departments")
    .all<{ id: string; code: string; name: string }>();
  const deptByCode = new Map<string, { id: string; name: string }>();
  for (const d of deptRes.results ?? []) {
    deptByCode.set(d.code, { id: d.id, name: d.name });
  }

  // Target PO set.
  let poRows: ProductionOrderRow[];
  if (poIdParam) {
    const one = await db
      .prepare(
        `SELECT id, salesOrderId, productCode, itemCategory, quantity,
                currentDepartment, targetEndDate, startDate, sizeCode, sizeLabel,
                fabricCode, gapInches, divanHeightInches, legHeightInches
           FROM production_orders WHERE id = ?`,
      )
      .bind(poIdParam)
      .first<ProductionOrderRow>();
    poRows = one ? [one] : [];
  } else {
    const all = await db
      .prepare(
        `SELECT id, salesOrderId, productCode, itemCategory, quantity,
                currentDepartment, targetEndDate, startDate, sizeCode, sizeLabel,
                fabricCode, gapInches, divanHeightInches, legHeightInches
           FROM production_orders`,
      )
      .all<ProductionOrderRow>();
    poRows = all.results ?? [];
  }

  const perPO: Array<{ poId: string; created: string[] }> = [];
  const insertStatements: D1PreparedStatement[] = [];
  let totalCreated = 0;

  for (const po of poRows) {
    const productCode = po.productCode ?? "";
    const bomRow = await loadBomTemplate(db, productCode);
    // Legacy POs without ANY BOM template: we still compute expected JCs —
    // breakBomIntoWips returns a synthetic FG_MAIN WIP covering DEPT_ORDER
    // when `wipComponents` is null, and parseL1Processes returns [] for null
    // l1Processes. This mirrors what SO-confirm would do for the same PO.
    const expected = computeExpectedJcs(po, bomRow);
    if (expected.length === 0) {
      perPO.push({ poId: po.id, created: [] });
      continue;
    }

    // Load existing (wipKey, deptCode) pairs for this PO in one shot.
    const existingRes = await db
      .prepare(
        "SELECT wipKey, departmentCode FROM job_cards WHERE productionOrderId = ?",
      )
      .bind(po.id)
      .all<{ wipKey: string | null; departmentCode: string | null }>();
    const existing = new Set<string>();
    for (const row of existingRes.results ?? []) {
      existing.add(`${row.wipKey ?? ""}::${row.departmentCode ?? ""}`);
    }

    const dueDate = po.targetEndDate || po.startDate || "";
    const createdForThisPO: string[] = [];
    for (const exp of expected) {
      const key = `${exp.wipKey}::${exp.deptCode}`;
      if (existing.has(key)) continue;
      const deptMeta = deptByCode.get(exp.deptCode);
      if (!deptMeta) continue;
      const jcId = deriveJobCardId(po.id, exp.wipKey, exp.deptCode);
      insertStatements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO job_cards (id, productionOrderId, departmentId, departmentCode,
               departmentName, sequence, status, dueDate, wipKey, wipCode, wipType, wipLabel,
               wipQty, prerequisiteMet, pic1Id, pic1Name, pic2Id, pic2Name, completedDate,
               estMinutes, actualMinutes, category, productionTimeMinutes, overdue, rackingNumber, branchKey)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            jcId,
            po.id,
            deptMeta.id,
            exp.deptCode,
            deptMeta.name,
            exp.sequence,
            "WAITING",
            dueDate,
            exp.wipKey,
            exp.wipCode,
            exp.wipType,
            exp.wipLabel,
            exp.wipQty,
            // prerequisiteMet: leave 0 for appended JCs. The SO-confirm path
            // only sets 1 on sequence=0 of a fresh chain — for sync we can't
            // safely assume the appended dept is the new first step, so 0 is
            // the safe default. Upstream-lock / recalc endpoints can
            // re-evaluate.
            0,
            null,
            "",
            null,
            "",
            null,
            exp.estMinutes,
            null,
            exp.category,
            exp.estMinutes,
            "PENDING",
            null,
            // BOM-branch identifier — straight from computeExpectedJcs
            // which gets it from the BOM walker. Pure tree-driven, no
            // category/dept hardcode.
            exp.branchKey,
          ),
      );
      createdForThisPO.push(exp.deptCode);
      totalCreated++;
    }
    perPO.push({ poId: po.id, created: createdForThisPO });
  }

  // Batch INSERTs in groups of 50 to stay under D1's bound-param ceiling.
  for (const batch of chunk(insertStatements, 50)) {
    if (batch.length > 0) {
      await db.batch(batch);
    }
  }

  return c.json({
    success: true,
    scannedPOs: poRows.length,
    createdJCs: totalCreated,
    perPO,
  });
});

// The minutes the CURRENT BOM gives an existing card, or why it can't say.
// A merged Fab Cut card (wipKey `<poId>::<model>::<fabric>::FAB_CUT`) gets the
// sum of every Fab Cut step of its PO, the same total aggregateFcSlots stamps
// on a new one. A sofa merge spans several POs (key starts with the SO id), so
// one PO's BOM can't price it.
// A `<product>::FG_MAIN` card is the all-dept chain a PO got while its BOM was
// empty (before BUG-2026-10-01-244). Today's BOM has other wipKeys, so it is
// matched by dept instead: the sum of that dept's steps. Skipped when the PO
// has another live card in the same dept, or that work would be counted twice.
export function bomMinutesForCard(
  card: { wipKey: string; deptCode: string; poId: string },
  expected: readonly { wipKey: string; deptCode: string; estMinutes: number }[],
  otherCardInDept = false,
): { minutes: number } | { skip: "sofaFabCutMerge" | "noMatch" | "duplicateDept" } {
  if (card.deptCode === "FAB_CUT" && card.wipKey.endsWith("::FAB_CUT")) {
    if (!card.wipKey.startsWith(`${card.poId}::`)) return { skip: "sofaFabCutMerge" };
    const fc = expected.filter((e) => e.deptCode === "FAB_CUT");
    if (fc.length === 0) return { skip: "noMatch" };
    return { minutes: fc.reduce((sum, e) => sum + e.estMinutes, 0) };
  }
  const hit = expected.find(
    (e) => e.wipKey === card.wipKey && e.deptCode === card.deptCode,
  );
  if (hit) return { minutes: hit.estMinutes };
  if (!card.wipKey.endsWith("::FG_MAIN")) return { skip: "noMatch" };
  if (otherCardInDept) return { skip: "duplicateDept" };
  const steps = expected.filter((e) => e.deptCode === card.deptCode);
  if (steps.length === 0) return { skip: "noMatch" };
  return { minutes: steps.reduce((sum, e) => sum + e.estMinutes, 0) };
}

// ---------------------------------------------------------------------------
// POST /api/production/sync-jobcards-from-bom/fill-zero-minutes
//   ?dryRun=true             preview only
//   &completedFrom=YYYY-MM-DD  also fill COMPLETED/TRANSFERRED cards finished
//                              on or after this date (default: none)
//
// Live cards only (WAITING / IN_PROGRESS / PAUSED / BLOCKED): a CANCELLED card
// is never filled.
//
// A card's minutes are copied from the BOM once, when the card is created, so
// a card cut while its BOM step had no minutes keeps 0 after the BOM is filled.
// This fills ONLY cards still at 0. A card that has minutes is never touched,
// even if the BOM has changed since: that is the BOM of its day, not a gap.
// Each write is audited (before/after) so it can be traced and reversed.
// ---------------------------------------------------------------------------
app.post("/fill-zero-minutes", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";
  const completedFrom = c.req.query("completedFrom") ?? "";
  if (completedFrom && !/^\d{4}-\d{2}-\d{2}$/.test(completedFrom)) {
    return c.json({ success: false, error: "completedFrom must be YYYY-MM-DD" }, 400);
  }

  type ZeroCard = ProductionOrderRow & {
    jcId: string;
    wipKey: string | null;
    deptCode: string | null;
    status: string;
    completedDate: string | null;
    poNo: string | null;
  };
  const sel = await db
    .prepare(
      `SELECT jc.id AS "jcId", jc.wipKey AS "wipKey", jc.departmentCode AS "deptCode",
              jc.status AS "status", jc.completedDate AS "completedDate",
              po.poNo AS "poNo", po.id, po.salesOrderId, po.productCode,
              po.itemCategory, po.quantity, po.currentDepartment, po.targetEndDate,
              po.startDate, po.sizeCode, po.sizeLabel, po.fabricCode, po.gapInches,
              po.divanHeightInches, po.legHeightInches
         FROM job_cards jc
         JOIN production_orders po ON po.id = jc.productionOrderId
        WHERE COALESCE(jc.productionTimeMinutes, 0) = 0
          AND (jc.status IN ('WAITING','IN_PROGRESS','PAUSED','BLOCKED')
               ${completedFrom ? "OR jc.completedDate >= ?" : ""})
        ORDER BY jc.id`,
    )
    .bind(...(completedFrom ? [completedFrom] : []))
    .all<ZeroCard>();
  const cards = sel.results ?? [];

  const bomCache = new Map<string, Awaited<ReturnType<typeof loadBomTemplate>>>();
  const expectedByPo = new Map<string, ExpectedJc[]>();
  // Per PO: dept -> wipKeys of its non-cancelled cards (for the FG_MAIN guard).
  const deptKeysByPo = new Map<string, Map<string, string[]>>();
  const fills: Array<{
    jcId: string;
    poNo: string;
    productCode: string;
    deptCode: string;
    status: string;
    minutes: number;
  }> = [];
  const skipped = { bomZero: 0, noMatch: 0, sofaFabCutMerge: 0, duplicateDept: 0 };
  const skippedSamples: Array<{ jcId: string; poNo: string; productCode: string; deptCode: string; reason: string }> = [];

  for (const r of cards) {
    const productCode = r.productCode ?? "";
    let expected = expectedByPo.get(r.id);
    if (!expected) {
      if (!bomCache.has(productCode)) bomCache.set(productCode, await loadBomTemplate(db, productCode));
      expected = computeExpectedJcs(r, bomCache.get(productCode) ?? null);
      expectedByPo.set(r.id, expected);
    }
    let deptKeys = deptKeysByPo.get(r.id);
    if (!deptKeys) {
      const own = await db
        .prepare(
          `SELECT wipKey AS "wipKey", departmentCode AS "deptCode" FROM job_cards
            WHERE productionOrderId = ? AND status <> 'CANCELLED'`,
        )
        .bind(r.id)
        .all<{ wipKey: string | null; deptCode: string | null }>();
      deptKeys = new Map();
      for (const o of own.results ?? []) {
        const list = deptKeys.get(o.deptCode ?? "") ?? [];
        list.push(o.wipKey ?? "");
        deptKeys.set(o.deptCode ?? "", list);
      }
      deptKeysByPo.set(r.id, deptKeys);
    }
    const wipKey = r.wipKey ?? "";
    const res = bomMinutesForCard(
      { wipKey, deptCode: r.deptCode ?? "", poId: r.id },
      expected,
      (deptKeys.get(r.deptCode ?? "") ?? []).some((k) => k !== wipKey),
    );
    if ("skip" in res || res.minutes <= 0) {
      const reason = "skip" in res ? res.skip : "bomZero";
      skipped[reason]++;
      if (skippedSamples.length < 50) {
        skippedSamples.push({ jcId: r.jcId, poNo: r.poNo ?? "", productCode, deptCode: r.deptCode ?? "", reason });
      }
      continue;
    }
    fills.push({
      jcId: r.jcId,
      poNo: r.poNo ?? "",
      productCode,
      deptCode: r.deptCode ?? "",
      status: r.status,
      minutes: res.minutes,
    });
  }

  const summary = {
    scanned: cards.length,
    toFill: fills.length,
    toFillCompleted: fills.filter((f) => f.status === "COMPLETED" || f.status === "TRANSFERRED").length,
    skipped,
  };
  if (dryRun) {
    return c.json({ success: true, dryRun: true, completedFrom, ...summary, fills, skippedSamples });
  }

  let updated = 0;
  for (const part of chunk(fills, 50)) {
    const stmts: D1PreparedStatement[] = [];
    for (const f of part) {
      // Re-checks 0 so a card that got minutes since the SELECT is left alone.
      stmts.push(
        db
          .prepare(
            `UPDATE job_cards SET productionTimeMinutes = ?, estMinutes = ?
              WHERE id = ? AND COALESCE(productionTimeMinutes, 0) = 0`,
          )
          .bind(f.minutes, f.minutes, f.jcId),
      );
      const audit = await buildAuditStatement(c, {
        resource: "job-cards",
        resourceId: f.jcId,
        action: "fill-zero-minutes-from-bom",
        before: { productionTimeMinutes: 0, deptCode: f.deptCode },
        after: { productionTimeMinutes: f.minutes, estMinutes: f.minutes, deptCode: f.deptCode },
        source: "admin",
      });
      if (audit) stmts.push(audit);
    }
    await db.batch(stmts);
    updated += part.length;
  }

  return c.json({ success: true, dryRun: false, completedFrom, ...summary, updated });
});

export default app;
