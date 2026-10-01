// Staging-only: never PR this into main.
// Server gate for the staging-only test tools. True only when the request
// came in on a preview host AND the staging database is bound, the same test
// worker.ts uses (isPreviewHostname) to route a request to HYPERDRIVE_STAGING.
// Prod, PR canaries and custom domains are refused. Keep in step with
// isPreviewHostname in src/api/worker.ts.
type GateCtx = {
  env?: { HYPERDRIVE_STAGING?: { connectionString?: string } };
  req: { url: string };
};

export function isStagingRequest(c: GateCtx): boolean {
  if (!c.env?.HYPERDRIVE_STAGING?.connectionString) return false;
  try {
    const host = new URL(c.req.url).hostname.toLowerCase();
    if (host === "hookka-erp-testing.pages.dev") return false; // prod
    if (host.startsWith("canary-")) return false; // PR canary uses the prod DB
    return host.endsWith(".hookka-erp-testing.pages.dev");
  } catch {
    return false;
  }
}
