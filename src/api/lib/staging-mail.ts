// Staging-only: never PR this into main.
// Reads the mail staging has sent from the MailSlurp API (staging sends every
// email through one MailSlurp inbox, see sendEmailViaMailSlurp in ./email.ts).
// Pure: the caller passes fetch, so tests run on fixtures with no network.
//
// MailSlurp REST (x-api-key header), from the official client's generated API:
//   GET /sent?inboxId=&page=&size=&sort=DESC   -> PageSentEmailProjection
//   GET /sent/{id}                             -> SentEmailDto (body, attachments)
//   GET /sent/{id}/html                        -> the HTML body as text
//   GET /sent/{id}/raw                         -> the raw SMTP message as text
//   GET /attachments/{id}/metadata             -> { id, name, contentType, contentLength }
//   GET /attachments/{id}/bytes                -> raw file
// Only mail MailSlurp accepted shows up here. A send it refused is not stored.

export const MAILSLURP_API = "https://api.mailslurp.com";

type FetchFn = typeof fetch;

export interface SentMailRow {
  id: string;
  at: string;
  to: string[];
  subject: string;
  attachmentCount: number;
}

export interface SentMailAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
}

export interface SentMailDetail extends SentMailRow {
  body: string;
  isHtml: boolean;
  attachments: SentMailAttachment[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID_RE.test(s);

export class MailSlurpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function getJson<T>(f: FetchFn, apiKey: string, path: string): Promise<T> {
  const res = await f(`${MAILSLURP_API}${path}`, {
    headers: { "x-api-key": apiKey, Accept: "application/json" },
  });
  if (!res.ok) throw new MailSlurpError(res.status, `MailSlurp ${res.status}`);
  return (await res.json()) as T;
}

// Text, or "" on 404, for endpoints that return a body instead of JSON.
async function getText(f: FetchFn, apiKey: string, path: string): Promise<string> {
  const res = await f(`${MAILSLURP_API}${path}`, {
    headers: { "x-api-key": apiKey, Accept: "text/html, text/plain" },
  });
  if (res.status === 404) return "";
  if (!res.ok) throw new MailSlurpError(res.status, `MailSlurp ${res.status}`);
  return await res.text();
}

// The HTML part of a raw MIME message, decoded; "" when there is none.
// Handles nested multipart, base64 and quoted-printable; utf-8 by default.
export function htmlFromRawMime(raw: string): string {
  const cut = raw.search(/\r?\n\r?\n/);
  if (cut < 0) return "";
  const head = raw.slice(0, cut).replace(/\r?\n[ \t]+/g, " ");
  const body = raw.slice(cut).replace(/^\r?\n\r?\n/, "");
  const header = (name: string) =>
    head.match(new RegExp(`^${name}:\\s*(.*)$`, "im"))?.[1]?.trim() ?? "";
  const contentType = header("Content-Type");
  const type = contentType.toLowerCase();
  if (type.startsWith("multipart/")) {
    const boundary = contentType.match(/boundary="?([^";]+)"?/i)?.[1];
    if (!boundary) return "";
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith("--")) break;
      const html = htmlFromRawMime(part.replace(/^\r?\n/, ""));
      if (html) return html;
    }
    return "";
  }
  if (!type.startsWith("text/html")) return "";
  const charset = type.match(/charset="?([^";]+)"?/)?.[1] ?? "utf-8";
  const enc = header("Content-Transfer-Encoding").toLowerCase();
  let bytes: Uint8Array;
  if (enc === "base64") {
    bytes = Uint8Array.from(atob(body.replace(/\s+/g, "")), (ch) => ch.charCodeAt(0));
  } else if (enc === "quoted-printable") {
    const s = body.replace(/=\r?\n/g, "");
    const out: number[] = [];
    const utf8 = new TextEncoder();
    for (let i = 0; i < s.length; i++) {
      const hex = s[i] === "=" ? s.slice(i + 1, i + 3) : "";
      if (/^[0-9A-F]{2}$/i.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
      } else {
        out.push(...utf8.encode(s[i]));
      }
    }
    bytes = Uint8Array.from(out);
  } else {
    return body.replace(/\r?\n$/, "");
  }
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder();
  }
  return decoder.decode(bytes).replace(/\r?\n$/, "");
}

type Raw = Record<string, unknown>;

function toRow(r: Raw): SentMailRow {
  return {
    id: String(r.id ?? ""),
    at: String(r.createdAt ?? r.sentAt ?? ""),
    to: Array.isArray(r.to) ? r.to.map(String) : [],
    subject: String(r.subject ?? ""),
    attachmentCount: Array.isArray(r.attachments) ? r.attachments.length : 0,
  };
}

export async function listSentMail(
  f: FetchFn,
  apiKey: string,
  inboxId: string,
  page = 0,
  size = 50,
): Promise<{ rows: SentMailRow[]; totalPages: number }> {
  const p = Math.max(0, Math.floor(page) || 0);
  const s = Math.min(100, Math.max(1, Math.floor(size) || 50));
  const q = new URLSearchParams({ inboxId, page: String(p), size: String(s), sort: "DESC" });
  const j = await getJson<{ content?: Raw[]; totalPages?: number }>(f, apiKey, `/sent?${q}`);
  return { rows: (j.content ?? []).map(toRow), totalPages: Number(j.totalPages) || 0 };
}

// The sent email, or null when it does not exist or belongs to another inbox
// (the key may see more than staging's inbox; only staging's is shown).
async function getOwnSent(f: FetchFn, apiKey: string, inboxId: string, id: string): Promise<Raw | null> {
  if (!isUuid(id)) return null;
  try {
    const r = await getJson<Raw>(f, apiKey, `/sent/${id}`);
    return r.inboxId === inboxId ? r : null;
  } catch (e) {
    if (e instanceof MailSlurpError && e.status === 404) return null;
    throw e;
  }
}

async function getMeta(f: FetchFn, apiKey: string, aid: string): Promise<SentMailAttachment> {
  const m = await getJson<Raw>(f, apiKey, `/attachments/${aid}/metadata`);
  return {
    id: aid,
    name: String(m.name ?? aid),
    contentType: String(m.contentType ?? "application/octet-stream"),
    size: Number(m.contentLength) || 0,
  };
}

export async function getSentMail(
  f: FetchFn,
  apiKey: string,
  inboxId: string,
  id: string,
): Promise<SentMailDetail | null> {
  const r = await getOwnSent(f, apiKey, inboxId, id);
  if (!r) return null;
  const ids = (Array.isArray(r.attachments) ? r.attachments.map(String) : []).filter(isUuid);
  const attachments = await Promise.all(ids.map((aid) => getMeta(f, apiKey, aid)));
  // The sent record's body can stop at the first line break while the
  // delivered email is whole (BUG-2026-10-01-234), so also read /html and the
  // raw message and show the longest. A failing fallback keeps the body.
  const body = String(r.body ?? "");
  const soft = (path: string) => getText(f, apiKey, path).catch(() => "");
  const [html, raw] = await Promise.all([soft(`/sent/${id}/html`), soft(`/sent/${id}/raw`)]);
  const best = [htmlFromRawMime(raw), html].reduce((a, b) => (b.length > a.length ? b : a), body);
  const isHtml = best === body ? Boolean(r.isHTML ?? r.html) : true;
  return { ...toRow(r), body: best, isHtml, attachments };
}

// The attachment's bytes, only when `aid` is one of that sent email's
// attachments, so the proxy cannot be pointed at an arbitrary attachment id.
export async function getSentAttachment(
  f: FetchFn,
  apiKey: string,
  inboxId: string,
  id: string,
  aid: string,
): Promise<{ meta: SentMailAttachment; body: ArrayBuffer } | null> {
  if (!isUuid(aid)) return null;
  const r = await getOwnSent(f, apiKey, inboxId, id);
  if (!r || !Array.isArray(r.attachments) || !r.attachments.map(String).includes(aid)) return null;
  const meta = await getMeta(f, apiKey, aid);
  const res = await f(`${MAILSLURP_API}/attachments/${aid}/bytes`, { headers: { "x-api-key": apiKey } });
  if (!res.ok) throw new MailSlurpError(res.status, `MailSlurp ${res.status}`);
  return { meta, body: await res.arrayBuffer() };
}
