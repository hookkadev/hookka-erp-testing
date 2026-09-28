// ---------------------------------------------------------------------------
// Packing-List-first auto-split — pure grouping helper.
//
// The "Create Packing List" flow on the Delivery page lets the operator
// multi-select ready production orders across customers/hubs; the backend
// then splits the selection into one DRAFT delivery order per
// (customerId, hubId) pair — the enforced one-DO-per-customer-per-hub rule —
// and wraps every new DO into ONE packing list.
//
// These two functions are deliberately pure (no DB, no Hono) so the grouping
// and the all-or-nothing credit pre-validation can be unit-tested directly
// (tests/pl-first-autosplit.test.mjs). The route handler in
// src/api/routes/delivery-orders.ts (POST /packing-list-first) feeds them
// rows it loaded itself.
// ---------------------------------------------------------------------------

export type PlFirstPo = {
  poId: string;
  customerId: string;
  /** The parent SO's hubId; "" when the SO has no hub configured. */
  hubId: string;
};

export type PlFirstGroup = {
  customerId: string;
  hubId: string;
  poIds: string[];
};

/**
 * Partition production orders into delivery-order groups keyed by
 * (customerId, hubId). Deterministic: groups appear in first-seen order of
 * the input rows, and each group's poIds preserve the input order. A blank
 * hubId ("") is its own key — POs whose SO has no hub never share a DO with
 * a hub-assigned PO, so the printed DO always carries one unambiguous
 * Deliver-To address.
 */
export function groupPosByCustomerHub(pos: PlFirstPo[]): PlFirstGroup[] {
  const byKey = new Map<string, PlFirstGroup>();
  const ordered: PlFirstGroup[] = [];
  for (const po of pos) {
    // A \u0000 separator can't appear in either id, so the compound key is unambiguous.
    const key = `${po.customerId}\u0000${po.hubId}`;
    let group = byKey.get(key);
    if (!group) {
      group = { customerId: po.customerId, hubId: po.hubId, poIds: [] };
      byKey.set(key, group);
      ordered.push(group);
    }
    group.poIds.push(po.poId);
  }
  return ordered;
}

