// Staging-only: never PR this into main.
// /api/staging-mail: read-only view of the mail staging has sent, for the
// /staging-mail page. Sent mail comes from MailSlurp (the key stays here in
// the worker); outbox rows that never went out come from outbox_emails.
// 404 off staging, then SUPER_ADMIN / ADMIN only.
import { Hono, type Context } from "hono";
import type { Env } from "../worker";
import { isStagingRequest } from "../lib/staging-gate";
import { getOrgId } from "../lib/tenant";
import {
  getSentAttachment,
  getSentMail,
  listSentMail,
  MailSlurpError,
} from "../lib/staging-mail";

const app = new Hono<Env>();

app.use("*", async (c, next) => {
  if (!isStagingRequest(c)) return c.json({ error: "Not found" }, 404);
  const role = (c as unknown as { get: (k: string) => string | undefined })
    .get("userRole")
    ?.toUpperCase();
  if (!role) return c.json({ error: "Unauthorized" }, 401);
  if (role !== "SUPER_ADMIN" && role !== "ADMIN") {
    return c.json({ error: "Admins only" }, 403);
  }
  await next();
});

function mailslurp(c: Context<Env>) {
  const { MAILSLURP_API_KEY: key, MAILSLURP_INBOX_ID: inbox } = c.env;
  return key && inbox ? { key, inbox } : null;
}

function upstreamError(c: Context<Env>, e: unknown) {
  const status = e instanceof MailSlurpError ? e.status : 0;
  console.error("[staging-mail] MailSlurp call failed:", status || e);
  return c.json({ error: `MailSlurp request failed${status ? ` (${status})` : ""}` }, 502);
}

app.get("/", async (c) => {
  const ms = mailslurp(c);
  if (!ms) return c.json({ error: "MailSlurp is not configured on this deploy" }, 503);
  const page = Number(c.req.query("page") ?? 0);
  let sent;
  try {
    sent = await listSentMail(fetch, ms.key, ms.inbox, page, 50);
  } catch (e) {
    return upstreamError(c, e);
  }
  // Mail queued through enqueueEmail that has not gone out (yet). Direct
  // sendMail failures are only logged, so they cannot be listed.
  let notSent: unknown[] = [];
  if (page === 0) {
    try {
      const r = await c.var.DB.prepare(
        `SELECT id,
                to_address AS "toAddress",
                subject,
                status,
                attempts,
                last_error AS "lastError",
                created_at AS "createdAt"
           FROM outbox_emails
          WHERE org_id = ? AND status <> 'SENT'
          ORDER BY created_at DESC
          LIMIT 50`,
      )
        .bind(getOrgId(c))
        .all();
      notSent = r.results ?? [];
    } catch (e) {
      console.error("[staging-mail] outbox read failed:", e);
    }
  }
  return c.json({ ...sent, notSent });
});

app.get("/:id", async (c) => {
  const ms = mailslurp(c);
  if (!ms) return c.json({ error: "MailSlurp is not configured on this deploy" }, 503);
  try {
    const mail = await getSentMail(fetch, ms.key, ms.inbox, c.req.param("id"));
    return mail ? c.json(mail) : c.json({ error: "Not found" }, 404);
  } catch (e) {
    return upstreamError(c, e);
  }
});

app.get("/:id/attachments/:aid", async (c) => {
  const ms = mailslurp(c);
  if (!ms) return c.json({ error: "MailSlurp is not configured on this deploy" }, 503);
  try {
    const a = await getSentAttachment(fetch, ms.key, ms.inbox, c.req.param("id"), c.req.param("aid"));
    if (!a) return c.json({ error: "Not found" }, 404);
    const name = a.meta.name.replace(/["\\\r\n]/g, "_");
    return new Response(a.body, {
      headers: {
        "Content-Type": a.meta.contentType,
        "Content-Disposition": `attachment; filename="${name}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return upstreamError(c, e);
  }
});

export default app;
