// ---------------------------------------------------------------------------
// ap-recon.ts — 400-0000 (Trade Creditors) itemized reconciliation.
//
// The /ap-control card shows drift = GL control − net subledger. This module
// decomposes that drift into a list of items whose contributions sum EXACTLY
// to the drift (integer-sen algebra, no residual by construction — the test
// suite asserts Σ contributions === drift on every scenario). Owner rule
// 2026-07-08 「做账就是要准」: the drift must break down to the sen, not be
// eyeballed across separately-taken snapshots.
//
// Inputs are plain arrays (the route gathers them in one request, applying
// the SAME opening floor / alias resolution / company filter /ap-control
// uses, so the reported drift ties the card's number). Pure + dependency-
// free so the decomposition is unit-testable.
//
// Sign conventions:
//   control        = Σ legs (creditSen − debitSen)         (liability: CR normal)
//   net subledger  = bills outstanding − unallocated CN − unapplied advances
//   drift          = control − net
//   Each item's contributionSen is the amount it moves `drift` away from 0.
// ---------------------------------------------------------------------------

export type ApReconLeg = {
  sourceType: string;
  sourceId: string;
  debitSen: number;
  creditSen: number;
};

export type ApReconPi = {
  id: string;
  piNo: string;
  supplierName: string;
  status: string;
  amountSen: number; // face
  paidSen: number; // stored paid_amount_sen
  isOpening: boolean; // explicit opening seed (is_opening = 1)
  preOpeningIncluded: boolean; // dated before opening, NOT excluded → opening-covered
  floored: boolean; // excluded pre-opening row — invisible to the subledger
};

export type ApReconPaymentRow = {
  paymentNo: string;
  purchaseInvoiceId: string | null;
  bookedSen: number; // AP relief booked against the PI (0 for advances)
  amountSen: number; // bank amount / remaining unapplied for advance rows
  method: string; // 'CREDIT_NOTE' markers vs cash methods
  active: boolean; // document_lifecycle ACTIVE (or no lifecycle row)
  supplierName: string;
  date: string;
};

export type ApReconItem = {
  kind:
    | "opening_coverage" // opening 400-0000 leg vs Σ faces it should cover
    | "pi_gl_mismatch" // a PI's own GL net-CR ≠ its expected face (or ≠ 0)
    | "payment_gl_mismatch" // live payment: subledger claim ≠ GL net-DR
    | "void_payment_gl_leak" // voided/deleted payment still has visible GL
    | "pi_paid_drift" // stored paid_amount_sen ≠ Σ live payment rows
    | "overpaid_clamp" // paid > face: subledger clamps at 0, GL goes negative
    | "status_excluded_outstanding" // PI outside the aging status set but face−paid ≠ 0
    | "cn_block_mismatch" // purchase-CN GL vs posted/allocated totals
    | "other_source_leg"; // any non-PI/payment/CN/opening leg on 400-0000
  ref: string;
  supplierName?: string;
  expectedSen: number;
  actualSen: number;
  contributionSen: number;
  note?: string;
};

export type ApReconReport = {
  controlSen: number;
  billsOutstandingSen: number;
  pcnUnallocSen: number;
  unappliedAdvanceSen: number;
  netSubledgerSen: number;
  driftSen: number;
  glBySource: { family: string; drSen: number; crSen: number; netSen: number; legs: number }[];
  items: ApReconItem[];
  explainedSen: number;
  unexplainedResidualSen: number; // 0 unless the model missed a case — surfaced, never hidden
};

const AGING_STATUSES = new Set(["CONFIRMED", "APPROVED", "PARTIAL_PAID"]);
const DEAD_STATUSES = new Set(["DRAFT", "CANCELLED"]);

// The decomposition algebra is side-agnostic — the AR control (300-0000,
// DR-normal) reuses it by feeding legs with debit/credit SWAPPED and this
// config naming its GL families. Defaults = the original AP behaviour.
export type ReconCfg = {
  docPrefix: string; // GL family of the document postings (face legs)
  payPrefix: string; // GL family of the settlement postings
  cnPrefix: string; // GL family of credit notes ("§none§" = not applicable)
  /** Statuses the aging sums. null = every non-dead status (AR semantics). */
  agingStatuses: ReadonlySet<string> | null;
  deadStatuses: ReadonlySet<string>;
};

export const AP_RECON_CFG: ReconCfg = {
  docPrefix: "purchase_invoice",
  payPrefix: "supplier_payment",
  cnPrefix: "purchase_credit_note",
  agingStatuses: AGING_STATUSES,
  deadStatuses: DEAD_STATUSES,
};

export const AR_RECON_CFG: ReconCfg = {
  docPrefix: "invoice",
  payPrefix: "payment",
  cnPrefix: "§none§",
  agingStatuses: null, // /ar-control clamps per-invoice over ALL non-dead statuses
  deadStatuses: DEAD_STATUSES,
};

function isOpeningSource(sourceType: string): boolean {
  return sourceType === "opening_balance" || sourceType === "opening_balance_reversal";
}

function familyOf(sourceType: string, cfg: ReconCfg): "opening" | "doc" | "pay" | "cn" | "other" {
  if (isOpeningSource(sourceType)) return "opening";
  if (sourceType.startsWith(cfg.cnPrefix)) return "cn";
  if (sourceType.startsWith(cfg.docPrefix)) return "doc";
  if (sourceType.startsWith(cfg.payPrefix)) return "pay";
  return "other";
}

export function buildApReconciliation(input: {
  legs400: ApReconLeg[];
  pis: ApReconPi[];
  paymentRows: ApReconPaymentRow[];
  pcnPostedSen: number;
  cnAllocCtlSen: number; // Σ booked_sen of method='CREDIT_NOTE' rows (mirrors /ap-control)
}, cfg: ReconCfg = AP_RECON_CFG): ApReconReport {
  const { legs400, pis, paymentRows, pcnPostedSen, cnAllocCtlSen } = input;

  // ---- GL side --------------------------------------------------------------
  let openingCr = 0; // net CR of opening legs
  const glNetByPi = new Map<string, number>(); // sourceId → CR−DR
  const glDrByPay = new Map<string, number>(); // sourceId → DR−CR
  let cnGlDr = 0; // net DR of purchase-CN legs
  const otherByKey = new Map<string, { sourceType: string; sourceId: string; net: number }>();
  const bySourceAgg = new Map<string, { drSen: number; crSen: number; legs: number }>();
  let controlSen = 0;
  const famLabel = (fam: string): string =>
    fam === "doc" ? cfg.docPrefix : fam === "pay" ? cfg.payPrefix : fam === "cn" ? cfg.cnPrefix : fam;

  for (const l of legs400) {
    const dr = Math.round(Number(l.debitSen) || 0);
    const cr = Math.round(Number(l.creditSen) || 0);
    controlSen += cr - dr;
    const fam = familyOf(l.sourceType, cfg);
    const label = famLabel(fam);
    const agg = bySourceAgg.get(label) ?? { drSen: 0, crSen: 0, legs: 0 };
    agg.drSen += dr;
    agg.crSen += cr;
    agg.legs += 1;
    bySourceAgg.set(label, agg);
    if (fam === "opening") openingCr += cr - dr;
    else if (fam === "doc") {
      // PI edit legs carry a ':edit-<stamp>' suffix on the sourceId — fold
      // them into the base PI so its whole GL story is compared to one face.
      const baseId = l.sourceId.split(":")[0];
      glNetByPi.set(baseId, (glNetByPi.get(baseId) ?? 0) + cr - dr);
    }
    else if (fam === "pay") glDrByPay.set(l.sourceId, (glDrByPay.get(l.sourceId) ?? 0) + dr - cr);
    else if (fam === "cn") cnGlDr += dr - cr;
    else {
      const key = `${l.sourceType}\u0000${l.sourceId}`;
      const o = otherByKey.get(key) ?? { sourceType: l.sourceType, sourceId: l.sourceId, net: 0 };
      o.net += cr - dr;
      otherByKey.set(key, o);
    }
  }

  // ---- Subledger side (mirrors /ap-control exactly) -------------------------
  // A  = live PI universe (past the floor, not DRAFT/CANCELLED)
  // S3 = the aging status set /ap-control actually sums
  const piById = new Map<string, ApReconPi>();
  for (const pi of pis) piById.set(pi.id, pi);
  const inA = (pi: ApReconPi) => !pi.floored && !cfg.deadStatuses.has(pi.status);
  const inS3 = (pi: ApReconPi) => inA(pi) && (cfg.agingStatuses === null || cfg.agingStatuses.has(pi.status));
  const openingCovered = (pi: ApReconPi) => pi.isOpening || pi.preOpeningIncluded;

  let billsOutstandingSen = 0;
  for (const pi of pis) {
    if (!inS3(pi)) continue;
    const amt = pi.amountSen - pi.paidSen;
    if (amt <= 0) continue;
    billsOutstandingSen += amt;
  }
  // Advances: LIVE rows with no PI and a positive remaining amount — mirrors
  // loadUnappliedSupplierAdvances (which excludes VOIDED/DELETED payments via
  // document_lifecycle since BUG-2026-07-08-003).
  // A trade-finance repayment (method TF_REPAYMENT) has no PI either, but it
  // pays down the trade-finance account, not the supplier: supplier-payments.ts
  // posts it DR TF account / CR bank and loadUnappliedSupplierAdvances leaves
  // it out. Never an advance here either (BUG-2026-09-30-229).
  let unappliedAdvanceSen = 0;
  for (const r of paymentRows) {
    if (r.purchaseInvoiceId) continue;
    if (r.method === "TF_REPAYMENT") continue;
    if (r.amountSen <= 0) continue;
    if (!r.active) continue;
    unappliedAdvanceSen += r.amountSen;
  }
  const pcnUnallocSen = Math.max(0, pcnPostedSen - cnAllocCtlSen);
  const netSubledgerSen = billsOutstandingSen - pcnUnallocSen - unappliedAdvanceSen;
  const driftSen = controlSen - netSubledgerSen;

  // ---- Itemized decomposition ------------------------------------------------
  const items: ApReconItem[] = [];

  // (1) Opening coverage: the opening entry's 400-0000 leg should equal the
  // faces of every opening-covered live bill (opening seeds + included
  // pre-opening PIs). A gap means the opening was not re-posted after the
  // covered set changed.
  let openFaceSen = 0;
  for (const pi of pis) if (inA(pi) && openingCovered(pi)) openFaceSen += pi.amountSen;
  if (openingCr !== openFaceSen) {
    items.push({
      kind: "opening_coverage",
      ref: "opening_balance",
      expectedSen: openFaceSen,
      actualSen: openingCr,
      contributionSen: openingCr - openFaceSen,
      note: "400-0000 opening leg vs Σ face of opening-covered bills (opening seeds + included pre-opening PIs). Re-post opening if the covered set changed.",
    });
  }

  // (2) Per-PI GL vs face. Expected own-GL: face for live post-opening PIs,
  // 0 for opening-covered ones (their GL lives in the opening entry — the
  // OCEAN SKY false-positive fix), 0 for dead/floored/unknown ids.
  const piIds = new Set<string>([...glNetByPi.keys()]);
  for (const pi of pis) if (inA(pi) && !openingCovered(pi)) piIds.add(pi.id);
  for (const id of piIds) {
    const pi = piById.get(id);
    const actual = glNetByPi.get(id) ?? 0;
    const expected = pi && inA(pi) && !openingCovered(pi) ? pi.amountSen : 0;
    if (actual === expected) continue;
    const why = !pi
      ? "GL legs reference no known PI"
      : pi.floored
        ? "excluded pre-opening PI still has visible post-floor GL"
        : cfg.deadStatuses.has(pi.status)
          ? `PI status ${pi.status} should net to 0 on the control`
          : openingCovered(pi)
            ? "opening-covered PI has its own GL (double-counted with the opening entry)"
            : actual === 0
              ? "live PI has NO visible GL on 400-0000 (never posted / hidden legs)"
              : "GL net-CR differs from the PI face";
    items.push({
      kind: "pi_gl_mismatch",
      ref: pi?.piNo || id,
      supplierName: pi?.supplierName,
      expectedSen: expected,
      actualSen: actual,
      contributionSen: actual - expected,
      note: why,
    });
  }

  // Group payment rows by paymentNo (a payment's rows share lifecycle state —
  // any row marked inactive means the voucher is inactive).
  const byPay = new Map<string, ApReconPaymentRow[]>();
  for (const r of paymentRows) {
    const list = byPay.get(r.paymentNo);
    if (list) list.push(r);
    else byPay.set(r.paymentNo, [r]);
  }

  const paidRowsByPi = new Map<string, number>(); // PI id → Σ live rows (truth-guard semantics)
  for (const r of paymentRows) {
    if (!r.purchaseInvoiceId) continue;
    const live = r.method === "CREDIT_NOTE" ? true : r.active; // CN markers carry no lifecycle
    if (!live) continue;
    paidRowsByPi.set(r.purchaseInvoiceId, (paidRowsByPi.get(r.purchaseInvoiceId) ?? 0) + r.bookedSen);
  }

  let cnAllocLiveASen = 0; // CN-marker bookings against live bills (part of Σ paid)
  for (const r of paymentRows) {
    if (r.method !== "CREDIT_NOTE" || !r.purchaseInvoiceId) continue;
    const pi = piById.get(r.purchaseInvoiceId);
    if (pi && inA(pi)) cnAllocLiveASen += r.bookedSen;
  }

  // (3)+(4)+(5) Per-payment: live vouchers compare subledger claim vs GL;
  // inactive vouchers should have zero visible GL and zero advance remainder.
  const payNos = new Set<string>([...byPay.keys(), ...glDrByPay.keys()]);
  for (const payNo of payNos) {
    const all = byPay.get(payNo) ?? [];
    // A trade-finance repayment settles the trade-finance account, so it
    // claims nothing on this control; GL of it here would be a stray.
    if (all.length > 0 && all.every((r) => r.method === "TF_REPAYMENT")) {
      const glDrTf = glDrByPay.get(payNo) ?? 0;
      if (glDrTf !== 0) {
        items.push({
          kind: "payment_gl_mismatch",
          ref: payNo,
          supplierName: all[0].supplierName,
          expectedSen: 0,
          actualSen: glDrTf,
          contributionSen: -glDrTf,
          note: "trade-finance repayment — it settles the trade-finance account, so its GL should not touch this control",
        });
      }
      continue;
    }
    const rows = all.filter((r) => r.method !== "CREDIT_NOTE");
    if (rows.length === 0 && !glDrByPay.has(payNo)) continue;
    const glDr = glDrByPay.get(payNo) ?? 0;
    const active = rows.length > 0 ? rows.every((r) => r.active) : false;
    const supplierName = rows[0]?.supplierName;
    if (rows.length > 0 && active) {
      // Subledger claim = cash booked against LIVE bills + positive advance
      // remainders. Bookings to floored/dead/unknown PIs claim nothing (the
      // net never counted them), so their GL lands in this item's gap.
      let claim = 0;
      let outsideSen = 0;
      let advSen = 0;
      for (const r of rows) {
        if (!r.purchaseInvoiceId) {
          if (r.amountSen > 0) {
            claim += r.amountSen;
            advSen += r.amountSen;
          }
          continue;
        }
        const pi = piById.get(r.purchaseInvoiceId);
        if (pi && inA(pi)) claim += r.bookedSen;
        else outsideSen += r.bookedSen;
      }
      if (claim !== glDr) {
        items.push({
          kind: "payment_gl_mismatch",
          ref: payNo,
          supplierName,
          expectedSen: claim,
          actualSen: glDr,
          contributionSen: claim - glDr,
          note:
            (outsideSen !== 0 ? `RM ${(outsideSen / 100).toFixed(2)} booked to floored/dead/unknown PIs (claims nothing). ` : "") +
            (advSen !== 0 ? `Includes advance remainder ${(advSen / 100).toFixed(2)}. ` : "") +
            "Subledger claim (bookings to live bills + advance remainder) vs visible GL net-DR on 400-0000.",
        });
      }
    } else {
      // Inactive (voided/deleted) voucher — or GL legs with no rows at all.
      if (glDr !== 0) {
        items.push({
          kind: "void_payment_gl_leak",
          ref: payNo,
          supplierName,
          expectedSen: 0,
          actualSen: glDr,
          contributionSen: -glDr,
          note:
            rows.length === 0
              ? "GL legs reference no supplier_payments rows"
              : "voided/deleted payment still nets non-zero visible GL on 400-0000",
        });
      }
    }
  }

  // (6) Stored paid_amount_sen vs Σ live payment rows (truth-guard drift) and
  // (7) overpaid clamps and (10) PIs outside the aging status set.
  for (const pi of pis) {
    if (!inA(pi)) continue;
    const rowsPaid = paidRowsByPi.get(pi.id) ?? 0;
    if (pi.paidSen !== rowsPaid) {
      items.push({
        kind: "pi_paid_drift",
        ref: pi.piNo || pi.id,
        supplierName: pi.supplierName,
        expectedSen: rowsPaid,
        actualSen: pi.paidSen,
        contributionSen: pi.paidSen - rowsPaid,
        note: "stored paid_amount_sen ≠ Σ live payment rows — run POST /api/supplier-payments/recompute-pi-paid",
      });
    }
    if (inS3(pi) && pi.paidSen > pi.amountSen) {
      const clamp = pi.paidSen - pi.amountSen;
      items.push({
        kind: "overpaid_clamp",
        ref: pi.piNo || pi.id,
        supplierName: pi.supplierName,
        expectedSen: pi.amountSen,
        actualSen: pi.paidSen,
        contributionSen: -clamp,
        note: "paid exceeds face — the subledger clamps outstanding at 0 while the GL keeps the excess DR",
      });
    }
    if (!inS3(pi) && pi.amountSen !== pi.paidSen) {
      items.push({
        kind: "status_excluded_outstanding",
        ref: pi.piNo || pi.id,
        supplierName: pi.supplierName,
        expectedSen: pi.paidSen,
        actualSen: pi.amountSen,
        contributionSen: pi.amountSen - pi.paidSen,
        note: `status ${pi.status} keeps this PI out of the aging sum, but face − paid = ${((pi.amountSen - pi.paidSen) / 100).toFixed(2)} ≠ 0`,
      });
    }
  }

  // (8) CN block: GL DR of purchase-CN legs vs unallocated remainder +
  // live allocations. Consistent books net this to zero.
  const cnBlock = pcnUnallocSen + cnAllocLiveASen - cnGlDr;
  if (cnBlock !== 0) {
    items.push({
      kind: "cn_block_mismatch",
      ref: "purchase_credit_note",
      expectedSen: cnGlDr,
      actualSen: pcnUnallocSen + cnAllocLiveASen,
      contributionSen: cnBlock,
      note: `unallocated CN ${(pcnUnallocSen / 100).toFixed(2)} + live allocations ${(cnAllocLiveASen / 100).toFixed(2)} vs CN GL net-DR ${(cnGlDr / 100).toFixed(2)} (posted total ${(pcnPostedSen / 100).toFixed(2)}, ctl allocations ${(cnAllocCtlSen / 100).toFixed(2)})`,
    });
  }

  // (9) Anything else on 400-0000 (journal entries, contra, strays) hits the
  // control with no subledger counterpart — list each source.
  for (const o of otherByKey.values()) {
    if (o.net === 0) continue;
    items.push({
      kind: "other_source_leg",
      ref: `${o.sourceType} · ${o.sourceId}`,
      expectedSen: 0,
      actualSen: o.net,
      contributionSen: o.net,
      note: "non-PI/payment/CN/opening source posting to 400-0000 — verify it belongs on the control",
    });
  }

  items.sort((a, b) => Math.abs(b.contributionSen) - Math.abs(a.contributionSen));
  const explainedSen = items.reduce((s, it) => s + it.contributionSen, 0);

  const glBySource = [...bySourceAgg.entries()]
    .map(([family, a]) => ({ family, drSen: a.drSen, crSen: a.crSen, netSen: a.crSen - a.drSen, legs: a.legs }))
    .sort((a, b) => a.family.localeCompare(b.family));

  return {
    controlSen,
    billsOutstandingSen,
    pcnUnallocSen,
    unappliedAdvanceSen,
    netSubledgerSen,
    driftSen,
    glBySource,
    items,
    explainedSen,
    unexplainedResidualSen: driftSen - explainedSen,
  };
}
