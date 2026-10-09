// Staging-only test tool: build a realistic sales order for a test in one
// click, and find + cancel the caller's own test orders from today.
// Staging-only: never PR this into main.
//
// The payload mirrors what sales/create.tsx posts after an operator picks a
// product, seat height and fabric: the same base-price seed (customer price
// row first, then the product), and the surcharges (divan, leg, total height,
// specials) are left OUT so POST /api/sales-orders derives them the way it
// does for a scanned PO. The server then applies resolveSoBasePriceSen and the
// sofa combo pass, exactly as for a typed order. Money is integer sen.
//
// Test orders carry a marker in `reference` (the list search covers it):
// `[TEST yyyy-mm-dd by <userId>]`. sales_orders has no creator column, so the
// user id in the marker is the only "created by" there is. It is self-asserted.
import { hasMixedSofaBedframe, findInvalidSofaQty } from "./so-category";

type Tier = "PRICE_1" | "PRICE_2" | "PRICE_3";
type SeatPrice = { height: string; priceSen: number; tier?: Tier };

export type FactoryProduct = {
  id: string;
  code: string;
  name: string;
  category: string;
  baseModel: string;
  sizeCode: string;
  sizeLabel: string;
  status: string;
  basePriceSen?: number;
  price1Sen?: number;
  seatHeightPrices?: SeatPrice[];
  defaultVariants?: { fabricCode?: string; seatHeight?: string; divanHeight?: string; legHeight?: string; gap?: string };
};
export type FactoryCustomerProduct = {
  productId: string;
  basePriceSen: number | null;
  price1Sen: number | null;
  seatHeightPrices: SeatPrice[] | null;
};
export type FactoryFabric = {
  fabricCode: string;
  priceTier?: Tier;
  sofaPriceTier?: Tier | null;
  bedframePriceTier?: Tier | null;
};

export function testMarker(dateYmd: string, userId: string): string {
  return `[TEST ${dateYmd} by ${userId}]`;
}

/** Malaysia calendar date of an ISO timestamp, or "" when it does not parse. */
export function ymdMY(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : new Date(t + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function inches(h: string | undefined): number | null {
  const m = (h ?? "").match(/^(\d+(?:\.\d+)?)"/);
  return m ? parseFloat(m[1]) : null;
}

/** Same as create.tsx resolveSofaTierPrice: (height, fabric tier) cell, then any cell for the height. */
function sofaTierPrice(seats: SeatPrice[], seat: string, fabric: FactoryFabric | undefined): number | null {
  if (seats.length === 0 || !seat) return null;
  const tier = fabric?.sofaPriceTier ?? fabric?.priceTier ?? "PRICE_2";
  const cell = seats.find((s) => s.height === seat && (s.tier ?? "PRICE_2") === tier);
  if (cell) return cell.priceSen;
  return seats.find((s) => s.height === seat)?.priceSen ?? null;
}

function seatFor(p: FactoryProduct, cp: FactoryCustomerProduct | undefined): string {
  const seats = cp?.seatHeightPrices ?? p.seatHeightPrices ?? [];
  return p.defaultVariants?.seatHeight || seats[0]?.height || "";
}

/** One line, seeded the way create.tsx seeds it on product + seat + fabric pick. */
export function buildLine(
  p: FactoryProduct,
  quantity: number,
  cp: FactoryCustomerProduct | undefined,
  fabrics: FactoryFabric[],
  rand: () => number,
) {
  const isSofa = p.category === "SOFA";
  const isBF = p.category === "BEDFRAME";
  const def = p.defaultVariants ?? {};
  const fabric =
    fabrics.find((f) => f.fabricCode === def.fabricCode) ?? fabrics[Math.floor(rand() * fabrics.length)];
  const seats = cp?.seatHeightPrices ?? p.seatHeightPrices ?? [];
  const seat = isSofa ? seatFor(p, cp) : "";
  const price1Sen = cp?.price1Sen ?? p.price1Sen ?? null;
  let basePriceSen = 0; // accessory: the server falls back to the product price
  if (isSofa) {
    basePriceSen = sofaTierPrice(seats, seat, fabric) ?? 0;
  } else if (isBF) {
    const tier = fabric?.bedframePriceTier ?? fabric?.priceTier ?? "PRICE_2";
    basePriceSen = tier === "PRICE_1" && price1Sen ? price1Sen : cp?.basePriceSen || p.basePriceSen || 0;
  }
  return {
    productId: p.id,
    productCode: p.code,
    productName: p.name,
    itemCategory: p.category,
    baseModel: p.baseModel,
    sizeCode: isSofa ? seat.replace(/"/g, "").trim() : p.sizeCode,
    sizeLabel: isSofa ? seat : p.sizeLabel,
    fabricCode: fabric?.fabricCode ?? "",
    quantity: isSofa ? 1 : quantity,
    basePriceSen: Math.round(basePriceSen),
    seatHeight: seat,
    selectedModules: [],
    gapInches: isBF ? inches(def.gap) : null,
    divanHeightInches: isBF ? inches(def.divanHeight) : null,
    // Sofa leg left off: the server derives an omitted leg price from the
    // bedframe legHeights list, while the page prices sofa legs from sofaLegHeights.
    legHeightInches: isBF ? inches(def.legHeight) : null,
    specialOrders: [],
    specialOrder: "",
    customSpecials: [],
    notes: "",
    discountSen: 0,
    repairScope: null,
    price1Sen,
    seatHeightPrices: seats,
  };
}

/**
 * Pick `count` products at random from the active ones (or use `chosenId`
 * for every line), never mixing SOFA with BEDFRAME, and build the POST body.
 * Throws with a plain message when no valid order can be built.
 */
export function buildTestSoPayload(args: {
  customerId: string;
  count: number;
  chosenId?: string;
  products: FactoryProduct[];
  customerProducts: FactoryCustomerProduct[];
  fabrics: FactoryFabric[];
  marker: string;
  rand?: () => number;
}) {
  const rand = args.rand ?? Math.random;
  if (!args.customerId) throw new Error("Pick a customer first.");
  if (args.fabrics.length === 0) throw new Error("No fabrics found.");
  const cpBy = new Map(args.customerProducts.map((cp) => [cp.productId, cp]));
  const usable = args.products.filter(
    (p) =>
      String(p.status).toUpperCase() === "ACTIVE" &&
      (p.category !== "SOFA" || (!!p.baseModel && !!seatFor(p, cpBy.get(p.id)))),
  );
  const chosen: FactoryProduct[] = [];
  for (let i = 0; i < Math.max(1, args.count); i++) {
    const has = (cat: string) => chosen.some((p) => p.category === cat);
    const pool = args.chosenId
      ? usable.filter((p) => p.id === args.chosenId)
      : usable.filter(
          (p) => !(has("SOFA") && p.category === "BEDFRAME") && !(has("BEDFRAME") && p.category === "SOFA"),
        );
    if (pool.length === 0) throw new Error(args.chosenId ? "That product cannot be ordered here." : "No active products found.");
    chosen.push(pool[Math.floor(rand() * pool.length)]);
  }
  const items = chosen.map((p) => buildLine(p, 1 + Math.floor(rand() * 2), cpBy.get(p.id), args.fabrics, rand));
  // Same guards the create page runs before it posts.
  if (hasMixedSofaBedframe(items)) throw new Error("Sofa and bedframe ended up on one order.");
  if (findInvalidSofaQty(items.map((it, i) => ({ ...it, lineNo: i + 1 })))) throw new Error("A sofa line has quantity above 1.");
  return { customerId: args.customerId, reference: args.marker, notes: "", items, status: "DRAFT", isServiceOrder: false };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export type ListedSo = {
  id: string;
  companySOId: string;
  customerName: string;
  reference: string;
  status: string;
  createdAt?: string;
  created_at?: string;
};
export type VoidPlan = {
  toVoid: ListedSo[];
  skipped: { so: ListedSo; reason: string }[];
};

const CANCELLABLE = new Set(["DRAFT", "CONFIRMED", "IN_PRODUCTION", "ON_HOLD"]);

/** Marker present AND created today (MY date). Already-cancelled orders drop out quietly. */
export function filterVoidable(rows: ListedSo[], marker: string, todayYmd: string): VoidPlan {
  const plan: VoidPlan = { toVoid: [], skipped: [] };
  for (const so of rows) {
    if (!String(so.reference ?? "").includes(marker)) continue;
    if (ymdMY(so.createdAt || so.created_at || "") !== todayYmd) continue;
    const status = String(so.status).toUpperCase();
    if (status === "CANCELLED") continue;
    if (!CANCELLABLE.has(status)) plan.skipped.push({ so, reason: `status ${status} cannot be cancelled` });
    else plan.toVoid.push(so);
  }
  return plan;
}

/** Read each candidate's detail and skip any with a live delivery order or invoice. */
export async function checkDownstream(plan: VoidPlan, f: typeof fetch = fetch): Promise<VoidPlan> {
  const out: VoidPlan = { toVoid: [], skipped: [...plan.skipped] };
  for (const so of plan.toVoid) {
    const r = await f(`/api/sales-orders/${encodeURIComponent(so.id)}`);
    const j = (await r.json().catch(() => ({}))) as {
      linkedDOs?: { doNo?: string; status?: string }[];
      linkedInvoices?: { invoiceNo?: string; status?: string }[];
    };
    if (!r.ok) {
      out.skipped.push({ so, reason: "could not read the order" });
      continue;
    }
    const live = [...(j.linkedDOs ?? []), ...(j.linkedInvoices ?? [])].filter(
      (d) => String(d.status ?? "").toUpperCase() !== "CANCELLED",
    );
    if (live.length > 0) out.skipped.push({ so, reason: "has a delivery order or invoice" });
    else out.toVoid.push(so);
  }
  return out;
}

/** Cancel through the normal status PUT, one at a time. Never DELETE. */
export async function voidOrders(
  orders: ListedSo[],
  changedBy: string,
  f: typeof fetch = fetch,
): Promise<{ done: number; errors: string[] }> {
  let done = 0;
  const errors: string[] = [];
  for (const so of orders) {
    const r = await f(`/api/sales-orders/${encodeURIComponent(so.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "CANCELLED", changedBy }),
    });
    const j = (await r.json().catch(() => ({}))) as { success?: boolean; error?: string };
    if (r.ok && j.success) done++;
    else errors.push(`${so.companySOId}: ${j.error ?? `HTTP ${r.status}`}`);
  }
  return { done, errors };
}
