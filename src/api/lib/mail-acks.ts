// ---------------------------------------------------------------------------
// Mail Center — per-person read state + acknowledgement (PRD T-012 R7 / R8).
//
// READ (R7): mail_thread_reads holds one row per (thread, person). A thread
// is unread for a person when they have no row and the legacy shared flag
// says so, when they marked it unread (read_at NULL), or when mail arrived
// after they last read it (read_at < last_message_at). The SQL fragment that
// says this lives in myUnreadSql() so the list and the detail agree.
//
// ACKNOWLEDGEMENT (R8): the sender flags an outbound message; every STAFF
// recipient (an address in email_addresses) gets a mail_acknowledgements row
// with a due time. A recipient confirms from the thread; the sender sees who
// has and who has not; the outbox cron chases overdue rows by email.
//
// All timestamps are ISO strings in TEXT columns (adapter rule). Result
// columns come back camelCased by the pg driver — every read dual-keys.
// ---------------------------------------------------------------------------
import type { Context } from "hono";
import type { Env } from "../worker";
import { enqueueEmail } from "./email-outbox";
import { escapeHtml } from "./email";

export const ACK_DEFAULT_HOURS = 48;
export const ACK_MIN_HOURS = 1;
export const ACK_MAX_HOURS = 24 * 14;

/** Due time for an acknowledgement requested at `now`. */
export function ackDueAt(now: string, hours: number | undefined): string {
  const h = Number.isFinite(hours)
    ? Math.min(Math.max(hours as number, ACK_MIN_HOURS), ACK_MAX_HOURS)
    : ACK_DEFAULT_HOURS;
  return new Date(new Date(now).getTime() + h * 3_600_000).toISOString();
}

// The reminder is sent at most once per this window per pending row.
export const ACK_CHASE_INTERVAL_MS = 24 * 3_600_000;
const ACK_CHASE_BATCH = 50;

/** ISO strings compare lexically, so "later than" is a plain string compare. */
export function laterOf(a: string | null | undefined, b: string | null | undefined): string {
  const x = a ?? "";
  const y = b ?? "";
  return x >= y ? x : y;
}

// ---------------------------------------------------------------------------
// Read state
// ---------------------------------------------------------------------------

/**
 * The per-person unread expression for a thread aliased `t`, given a LEFT
 * JOIN of mail_thread_reads aliased `r` for the caller. Emits 1 / 0.
 */
export function myUnreadSql(): string {
  return `CASE
    WHEN r.thread_id IS NULL THEN t.unread
    WHEN r.read_at IS NULL THEN 1
    WHEN r.read_at < COALESCE(t.last_message_at, '') THEN 1
    ELSE 0
  END`;
}

/** The caller's read row joined onto `t` (bind the user id right after). */
export function myReadJoinSql(): string {
  return `LEFT JOIN mail_thread_reads r
            ON r.org_id = t.org_id AND r.thread_id = t.id AND r.user_id = ?`;
}

/**
 * Record that `userId` has read the thread as of now. read_at is pushed to
 * at least last_message_at so a mail whose Date header runs ahead of our
 * clock cannot stay unread until the clock catches up.
 */
export async function markThreadRead(
  db: D1Database,
  args: {
    orgId: string;
    threadId: string;
    userId: string;
    userName: string | null;
    lastMessageAt: string | null | undefined;
  },
): Promise<void> {
  if (!args.userId) return;
  const readAt = laterOf(new Date().toISOString(), args.lastMessageAt);
  await db
    .prepare(
      `INSERT INTO mail_thread_reads (org_id, thread_id, user_id, user_name, read_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (org_id, thread_id, user_id)
       DO UPDATE SET read_at = EXCLUDED.read_at, user_name = EXCLUDED.user_name`,
    )
    .bind(args.orgId, args.threadId, args.userId, args.userName, readAt)
    .run();
}

/** Mark the thread unread for `userId` only (nobody else is touched). */
export async function markThreadUnread(
  db: D1Database,
  args: { orgId: string; threadId: string; userId: string; userName: string | null },
): Promise<void> {
  if (!args.userId) return;
  await db
    .prepare(
      `INSERT INTO mail_thread_reads (org_id, thread_id, user_id, user_name, read_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT (org_id, thread_id, user_id)
       DO UPDATE SET read_at = NULL, user_name = EXCLUDED.user_name`,
    )
    .bind(args.orgId, args.threadId, args.userId, args.userName)
    .run();
}

export type ReadReceipt = { userId: string; userName: string; readAt: string };

type ReadRow = {
  userId?: string;
  user_id?: string;
  userName?: string | null;
  user_name?: string | null;
  readAt?: string | null;
  read_at?: string | null;
};

/** Everyone who has read the thread SINCE its latest message. */
export async function loadReadReceipts(
  db: D1Database,
  orgId: string,
  threadId: string,
  lastMessageAt: string | null | undefined,
): Promise<ReadReceipt[]> {
  const res = await db
    .prepare(
      `SELECT user_id, user_name, read_at FROM mail_thread_reads
        WHERE org_id = ? AND thread_id = ? AND read_at IS NOT NULL AND read_at >= ?
        ORDER BY read_at ASC`,
    )
    .bind(orgId, threadId, lastMessageAt ?? "")
    .all<ReadRow>();
  return (res.results ?? [])
    .map((r) => ({
      userId: r.userId ?? r.user_id ?? "",
      userName: r.userName ?? r.user_name ?? "",
      readAt: r.readAt ?? r.read_at ?? "",
    }))
    .filter((r) => r.userId);
}

/**
 * How many people can see this mailbox — the "of 5" in "read by 3 of 5":
 * the address's assigned person, everyone granted it in the mailbox matrix,
 * everyone at company scope, and everyone at department scope in the same
 * department. Never below 1.
 */
export async function mailboxAudience(
  db: D1Database,
  orgId: string,
  mailboxAddress: string,
): Promise<number> {
  const ids = new Set<string>();
  const addr = mailboxAddress.toLowerCase();
  type IdRow = { userId?: string | null; user_id?: string | null };
  const pick = (rows: IdRow[] | undefined) => {
    for (const r of rows ?? []) {
      const id = r.userId ?? r.user_id;
      if (id) ids.add(id);
    }
  };
  const own = await db
    .prepare(
      `SELECT assigned_user_id AS user_id FROM email_addresses
        WHERE org_id = ? AND lower(address) = ? AND assigned_user_id IS NOT NULL`,
    )
    .bind(orgId, addr)
    .all<IdRow>();
  pick(own.results);
  const granted = await db
    .prepare(
      `SELECT a.user_id FROM email_address_access a
         JOIN email_addresses e ON e.id = a.address_id
        WHERE a.org_id = ? AND lower(e.address) = ?`,
    )
    .bind(orgId, addr)
    .all<IdRow>();
  pick(granted.results);
  const company = await db
    .prepare(
      `SELECT user_id FROM mail_user_scope WHERE org_id = ? AND level = 'company'`,
    )
    .bind(orgId)
    .all<IdRow>();
  pick(company.results);
  const dept = await db
    .prepare(
      `SELECT s.user_id FROM mail_user_scope s
         JOIN email_addresses mine ON mine.org_id = s.org_id AND mine.assigned_user_id = s.user_id
         JOIN email_addresses box ON box.org_id = s.org_id AND lower(box.address) = ?
        WHERE s.org_id = ? AND s.level = 'department'
          AND mine.assigned_dept IS NOT NULL AND mine.assigned_dept = box.assigned_dept`,
    )
    .bind(addr, orgId)
    .all<IdRow>();
  pick(dept.results);
  return Math.max(1, ids.size);
}

// ---------------------------------------------------------------------------
// Acknowledgement
// ---------------------------------------------------------------------------

export type AckRow = {
  id: string;
  messageId: string;
  address: string;
  userId: string | null;
  userName: string;
  requestedAt: string;
  dueAt: string;
  ackedAt: string | null;
  ackedByUserId: string | null;
  chasedAt: string | null;
  chaseCount: number;
};

type RawAckRow = {
  id: string;
  messageId?: string;
  message_id?: string;
  address: string;
  userId?: string | null;
  user_id?: string | null;
  userName?: string | null;
  user_name?: string | null;
  requestedAt?: string | null;
  requested_at?: string | null;
  dueAt?: string | null;
  due_at?: string | null;
  ackedAt?: string | null;
  acked_at?: string | null;
  ackedByUserId?: string | null;
  acked_by_user_id?: string | null;
  chasedAt?: string | null;
  chased_at?: string | null;
  chaseCount?: number | string | null;
  chase_count?: number | string | null;
};

function rowToAck(r: RawAckRow): AckRow {
  return {
    id: r.id,
    messageId: r.messageId ?? r.message_id ?? "",
    address: r.address,
    userId: r.userId ?? r.user_id ?? null,
    userName: r.userName ?? r.user_name ?? "",
    requestedAt: r.requestedAt ?? r.requested_at ?? "",
    dueAt: r.dueAt ?? r.due_at ?? "",
    ackedAt: r.ackedAt ?? r.acked_at ?? null,
    ackedByUserId: r.ackedByUserId ?? r.acked_by_user_id ?? null,
    chasedAt: r.chasedAt ?? r.chased_at ?? null,
    chaseCount: Number(r.chaseCount ?? r.chase_count ?? 0),
  };
}

/**
 * Flag an outbound message as needing acknowledgement and open one row per
 * STAFF recipient among `addresses` (To + Cc; a Bcc is never asked). Returns
 * the rows created — empty when none of the recipients is a staff mailbox,
 * which the caller treats as a 400 before sending.
 */
export async function staffRecipients(
  db: D1Database,
  orgId: string,
  addresses: readonly string[],
): Promise<Array<{ address: string; userId: string | null; userName: string }>> {
  if (addresses.length === 0) return [];
  const ph = addresses.map(() => "?").join(", ");
  const res = await db
    .prepare(
      `SELECT address, assigned_user_id, assigned_user_name FROM email_addresses
        WHERE org_id = ? AND active = 1 AND lower(address) IN (${ph})`,
    )
    .bind(orgId, ...addresses.map((a) => a.toLowerCase()))
    .all<{
      address: string;
      assignedUserId?: string | null;
      assigned_user_id?: string | null;
      assignedUserName?: string | null;
      assigned_user_name?: string | null;
    }>();
  return (res.results ?? []).map((r) => ({
    address: r.address.toLowerCase(),
    userId: r.assignedUserId ?? r.assigned_user_id ?? null,
    userName: r.assignedUserName ?? r.assigned_user_name ?? r.address,
  }));
}

export async function createAckRequests(
  db: D1Database,
  args: {
    orgId: string;
    messageRowId: string;
    threadId: string;
    recipients: Array<{ address: string; userId: string | null; userName: string }>;
    now: string;
    dueAt: string;
  },
): Promise<void> {
  if (args.recipients.length === 0) return;
  await db
    .prepare(
      `UPDATE email_messages SET ack_required = 1, ack_due_at = ?
        WHERE org_id = ? AND id = ?`,
    )
    .bind(args.dueAt, args.orgId, args.messageRowId)
    .run();
  for (const r of args.recipients) {
    await db
      .prepare(
        `INSERT INTO mail_acknowledgements
           (id, org_id, message_id, thread_id, address, user_id, user_name,
            requested_at, due_at, acked_at, acked_by_user_id, chased_at, chase_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0)`,
      )
      .bind(
        crypto.randomUUID(),
        args.orgId,
        args.messageRowId,
        args.threadId,
        r.address,
        r.userId,
        r.userName,
        args.now,
        args.dueAt,
      )
      .run();
  }
}

/** Every acknowledgement row on a thread, grouped by message row id. */
export async function loadAcksForThread(
  db: D1Database,
  orgId: string,
  threadId: string,
): Promise<Map<string, AckRow[]>> {
  const res = await db
    .prepare(
      `SELECT * FROM mail_acknowledgements
        WHERE org_id = ? AND thread_id = ? ORDER BY requested_at ASC, address ASC`,
    )
    .bind(orgId, threadId)
    .all<RawAckRow>();
  const out = new Map<string, AckRow[]>();
  for (const raw of res.results ?? []) {
    const ack = rowToAck(raw);
    const list = out.get(ack.messageId) ?? [];
    list.push(ack);
    out.set(ack.messageId, list);
  }
  return out;
}

/**
 * The caller confirms a message: every pending row that is theirs — by
 * account, or by an address in their mailbox scope (a shared box) — is
 * stamped. Returns how many rows were confirmed (0 ⇒ nothing was theirs).
 */
export async function acknowledgeMessage(
  db: D1Database,
  args: {
    orgId: string;
    messageRowId: string;
    userId: string;
    addresses: readonly string[];
  },
): Promise<number> {
  const now = new Date().toISOString();
  const addrs = args.addresses.map((a) => a.toLowerCase());
  const ph = addrs.length ? addrs.map(() => "?").join(", ") : "''";
  const res = await db
    .prepare(
      `UPDATE mail_acknowledgements
          SET acked_at = ?, acked_by_user_id = ?
        WHERE org_id = ? AND message_id = ? AND acked_at IS NULL
          AND (user_id = ? OR lower(address) IN (${ph}))`,
    )
    .bind(now, args.userId, args.orgId, args.messageRowId, args.userId, ...addrs)
    .run();
  return Number(res.meta?.changes ?? 0);
}

/**
 * Chase: every pending row past its due time that has not been reminded in
 * the last ACK_CHASE_INTERVAL_MS gets a reminder email through the durable
 * outbox. Runs from the outbox cron; best-effort, capped per run.
 */
export async function chaseOverdueAcknowledgements(
  c: Context<Env>,
): Promise<{ chased: number }> {
  const db = c.var.DB;
  const now = new Date().toISOString();
  const chaseBefore = new Date(Date.now() - ACK_CHASE_INTERVAL_MS).toISOString();
  const res = await db
    .prepare(
      `SELECT a.*, m.subject AS subject, m.from_name AS from_name, m.thread_id AS thread_id
         FROM mail_acknowledgements a
         JOIN email_messages m ON m.id = a.message_id
        WHERE a.acked_at IS NULL AND a.due_at < ?
          AND (a.chased_at IS NULL OR a.chased_at < ?)
        ORDER BY a.due_at ASC
        LIMIT ${ACK_CHASE_BATCH}`,
    )
    .bind(now, chaseBefore)
    .all<RawAckRow & {
      subject?: string | null;
      fromName?: string | null;
      from_name?: string | null;
      threadId?: string;
      thread_id?: string;
    }>();
  let chased = 0;
  const base = (c.env.APP_URL || "").replace(/\/$/, "");
  for (const raw of res.results ?? []) {
    const ack = rowToAck(raw);
    const subject = (raw.subject ?? "(no subject)").trim();
    const sender = (raw.fromName ?? raw.from_name ?? "").trim();
    const threadId = raw.threadId ?? raw.thread_id ?? "";
    const link = threadId ? `${base}/mail-center/${threadId}` : base;
    try {
      await enqueueEmail(c, {
        to: ack.address,
        subject: `Reminder: please acknowledge "${subject}"`,
        text:
          `${sender || "A colleague"} asked you to acknowledge "${subject}" ` +
          `by ${ack.dueAt}. It is still open.\n\nOpen it: ${link}`,
        html:
          `<p>${escapeHtml(sender || "A colleague")} asked you to acknowledge ` +
          `<strong>${escapeHtml(subject)}</strong> by ${escapeHtml(ack.dueAt)}. ` +
          `It is still open.</p><p><a href="${escapeHtml(link)}">Open it in Mail Center</a></p>`,
        payloadJson: { kind: "mail-ack-chase", ackId: ack.id, threadId },
      });
      await db
        .prepare(
          `UPDATE mail_acknowledgements
              SET chased_at = ?, chase_count = chase_count + 1 WHERE id = ?`,
        )
        .bind(now, ack.id)
        .run();
      chased++;
    } catch (e) {
      console.error("[mail-acks] chase failed for", ack.id, e);
    }
  }
  return { chased };
}
