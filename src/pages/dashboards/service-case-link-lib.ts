// service-case-link-lib.ts — where the dashboard's Service tab sends a case.
// Pure (no React) so the desktop views, the /m tab and the test share one
// definition. The targets are the REAL Service Cases module:
//   desktop  /service-cases        + /service-cases/:id   (src/dashboard-routes.tsx)
//   phone    /m/servicecases       + /m/servicecases/:id  (serviceCasesConfig.detailPath)
// `:id` is service_cases.id — the same id both list pages navigate with, and the
// `id` every case carries in the dashboard feed and in /api/service-cases/approvals.

/** Sidebar entry that gates the links: `usePermissions().isNavAllowed(...)`. */
export const SERVICE_CASES_NAV_HREF = "/service-cases";

export type ServiceCasePlatform = "desktop" | "m";

const LIST: Record<ServiceCasePlatform, string> = { desktop: "/service-cases", m: "/m/servicecases" };

/** The Service Cases list page. */
export const serviceCasesHref = (platform: ServiceCasePlatform = "desktop"): string => LIST[platform];

/** One case's detail page; null when the row has no usable id (render plain text). */
export function serviceCaseHref(id: string | null | undefined, platform: ServiceCasePlatform = "desktop"): string | null {
  const clean = (id ?? "").trim();
  return clean ? `${LIST[platform]}/${encodeURIComponent(clean)}` : null;
}
