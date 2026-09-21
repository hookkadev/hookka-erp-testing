// ---------------------------------------------------------------------------
// Mail Center — recipient + RFC-threading helpers (PRD T-012 R1-R4).
//
// Pure: no DB, no fetch, no React. Shared by the API (compose / reply) and the
// browser (the reply box pre-fills To / Cc from the same rule the server
// enforces), so the two can never disagree about who a reply goes to.
// ---------------------------------------------------------------------------

export const MAIL_DOMAIN = "hookka.com";

// Conservative single-@ shape check. Not RFC-5322-complete on purpose; it
// only blocks obvious garbage. Same regex the compose UI mirrors.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Turn whatever a caller hands us into a clean, de-duplicated list of bare
 * lowercase addresses. Accepts a string ("a@x.com, Bob <b@y.com>; c@z.com"),
 * an array of such strings, or nothing. Order is preserved; the first
 * spelling of a duplicate wins.
 */
export function parseAddressList(
  input: string | string[] | null | undefined,
): string[] {
  const raw = Array.isArray(input) ? input : input ? [input] : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const chunk of raw) {
    for (const piece of String(chunk ?? "").split(/[,;\n]+/)) {
      const bare = bareAddress(piece);
      if (!bare) continue;
      const key = bare.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/** "Display Name <addr@dom>" → "addr@dom"; bare input passes through trimmed. */
export function bareAddress(input: string): string {
  const s = String(input ?? "").trim();
  if (!s) return "";
  const m = s.match(/<([^>]+)>\s*$/);
  return (m ? m[1] : s).trim();
}

/** True when every address passes the shape check (the Send-button gate). */
export function recipientsValid(list: readonly string[]): boolean {
  return list.every((a) => EMAIL_RE.test(a));
}

/** The entries of `list` that fail the shape check (for a 400 message). */
export function invalidAddresses(list: readonly string[]): string[] {
  return list.filter((a) => !EMAIL_RE.test(a));
}

/** Remove every address in `exclude` from `list` (case-insensitive). */
export function without(
  list: readonly string[],
  exclude: readonly string[],
): string[] {
  const drop = new Set(exclude.map((a) => a.toLowerCase()));
  return list.filter((a) => !drop.has(a.toLowerCase()));
}

// ---------------------------------------------------------------------------
// RFC 5322 threading headers.
// ---------------------------------------------------------------------------

/** A fresh `<uuid@domain>` Message-ID for an outgoing mail. */
export function newMessageId(domain: string = MAIL_DOMAIN): string {
  return `<${crypto.randomUUID()}@${domain}>`;
}

/** Guarantee the angle brackets a Message-ID header needs; "" stays "". */
export function normalizeMessageId(id: string | null | undefined): string {
  const s = String(id ?? "").trim();
  if (!s) return "";
  return s.startsWith("<") ? s : `<${s}>`;
}

// References grows by one id per hop; cap it so a 200-message thread does
// not ship a multi-KB header (RFC 5322 recommends keeping the first and the
// most recent ids when trimming — we keep the newest 30, which always
// includes the direct parent).
const MAX_REFERENCES = 30;

/**
 * The References chain for a reply to `parent`: the parent's own References
 * followed by the parent's Message-ID, de-duplicated and capped.
 */
export function referencesChain(
  parentReferences: string | string[] | null | undefined,
  parentMessageId: string | null | undefined,
): string[] {
  const raw = Array.isArray(parentReferences)
    ? parentReferences
    : String(parentReferences ?? "").split(/\s+/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of [...raw, parentMessageId ?? ""]) {
    const id = normalizeMessageId(r);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.length > MAX_REFERENCES ? out.slice(-MAX_REFERENCES) : out;
}

/**
 * The headers an outgoing mail carries so the other side's client threads it.
 * `inReplyTo` / `references` are omitted for a fresh conversation.
 */
export function buildThreadingHeaders(args: {
  messageId: string;
  inReplyTo?: string | null;
  references?: readonly string[] | null;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "Message-ID": normalizeMessageId(args.messageId),
  };
  const irt = normalizeMessageId(args.inReplyTo);
  if (irt) headers["In-Reply-To"] = irt;
  const refs = (args.references ?? []).map(normalizeMessageId).filter(Boolean);
  if (refs.length) headers["References"] = refs.join(" ");
  return headers;
}

// ---------------------------------------------------------------------------
// Who does a reply go to? (R2 / R3)
// ---------------------------------------------------------------------------

export type ThreadMessageLite = {
  direction: string;
  fromAddress: string;
  toAddresses: readonly string[];
  ccAddresses: readonly string[];
  messageId?: string | null;
  referenceIds?: string | null;
  /** ISO. Used only to pick the newest when the array is not in order. */
  createdAt: string;
};

export type ReplyMode = "reply" | "reply_all";

/**
 * The message a reply is built from: the NEWEST inbound message, so the reply
 * goes to whoever wrote last (R3) — not to the address the thread started
 * with. When nobody has written back yet (we started the conversation) the
 * newest outbound message is used instead, so a follow-up goes to the same
 * people we first wrote to.
 */
export function replyBaseMessage<T extends ThreadMessageLite>(
  messages: readonly T[],
): T | null {
  const byNewest = [...messages].sort((a, b) =>
    (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
  );
  return (
    byNewest.find((m) => m.direction === "inbound") ??
    byNewest.find((m) => m.direction === "outbound") ??
    null
  );
}

/**
 * Compute To / Cc for a reply.
 *
 *   reply      → To = the newest correspondent only.
 *   reply_all  → To = the newest correspondent; Cc = everyone else that
 *                message was addressed to or copied on.
 *
 * `exclude` is the set of our own addresses (the mailbox we reply from and the
 * thread's mailbox) so a reply-all never mails ourselves. When the base
 * message is one WE sent, its To/Cc are the recipients (the correspondent is
 * not its From).
 */
export function replyRecipients(
  messages: readonly ThreadMessageLite[],
  mode: ReplyMode,
  exclude: readonly string[],
): { to: string[]; cc: string[]; base: ThreadMessageLite | null } {
  const base = replyBaseMessage(messages);
  if (!base) return { to: [], cc: [], base: null };

  if (base.direction === "outbound") {
    const to = without(parseAddressList([...base.toAddresses]), exclude);
    const cc =
      mode === "reply_all"
        ? without(parseAddressList([...base.ccAddresses]), [...exclude, ...to])
        : [];
    return { to, cc, base };
  }

  const to = without(parseAddressList(base.fromAddress), exclude);
  if (mode !== "reply_all") return { to, cc: [], base };
  const cc = without(
    parseAddressList([...base.toAddresses, ...base.ccAddresses]),
    [...exclude, ...to],
  );
  return { to, cc, base };
}
