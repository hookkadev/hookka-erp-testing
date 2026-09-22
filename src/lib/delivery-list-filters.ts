// Pure helpers behind GET /api/delivery-orders (list + /stats). Kept out of
// the route file so node:test can exercise them without a Worker harness.
// Tests: tests/delivery-list-filters.test.mjs.

/** `?status=DRAFT,LOADED` → ["DRAFT", "LOADED"]; absent / blank → []. */
export function parseStatusList(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * One page of an in-memory list (Planning / Pending Delivery rows are one
 * server payload already in the browser). Bypassed while a search term is
 * typed: a search must span the WHOLE list, never just the visible page.
 */
export function pageSlice<T>(rows: T[], page: number, size: number, searching: boolean): T[] {
  if (searching) return rows;
  const p = Math.max(1, Math.floor(page) || 1);
  return rows.slice((p - 1) * size, p * size);
}

/**
 * ISO instant of 00:00 on the 1st of `now`'s month in Malaysia (UTC+8) — the
 * "Delivered (MTD)" boundary. `delivery_orders.deliveredAt` is ISO TEXT, so a
 * plain string compare against this is exact. Computed in Malaysian time
 * because the operator's month is Malaysian, not UTC's (which starts 8h late).
 */
export function startOfMonthMYT(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return new Date(`${get("year")}-${get("month")}-01T00:00:00+08:00`).toISOString();
}
