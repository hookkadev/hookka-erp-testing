// Staging-only "API log drawer": an in-memory ring of the last 50 /api calls,
// fed by the existing window.fetch patch in api-client.ts on the staging host.
// Nothing is stored or sent anywhere. Request bodies are never recorded; a
// response body only on failure, truncated, and never for auth / PIN /
// password / session / token endpoints.
// Staging-only: never PR this into main.

export type ApiLogEntry = {
  id: number;
  at: string; // ISO time the response (or failure) arrived
  method: string;
  path: string; // pathname only, query string already stripped by api-client
  status: number; // 0 = no response (network fail / abort / timeout)
  ms: number;
  error?: string; // failure body (truncated) or the thrown error's name
};

export const API_LOG_MAX = 50;
export const ERROR_BODY_MAX = 500;

const SENSITIVE_WORDS = new Set([
  "auth", "login", "logout", "pin", "pins", "password", "session", "token",
  "tokens", "invite", "invites", "totp", "oauth",
]);

// Word-level, so /api/shipping stays visible but /workers/:id/set-pin does not.
export function isSensitivePath(path: string): boolean {
  if (/^\/api\/(auth|worker-auth)(\/|$)/.test(path)) return true;
  return path.split("/").some((seg) => seg.toLowerCase().split("-").some((w) => SENSITIVE_WORDS.has(w)));
}

let entries: ApiLogEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function set(next: ApiLogEntry[]) {
  entries = next;
  for (const l of listeners) l();
}

export function getEntries(): ApiLogEntry[] {
  return entries;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function clearEntries() {
  set([]);
}

// Call synchronously before the response is handed back to the caller: the
// clone is taken here, so the caller's body is never consumed.
export function recordApiCall(
  call: { method: string; path: string; status: number; ms: number; error?: unknown },
  response?: Response,
) {
  const id = nextId++;
  const entry: ApiLogEntry = {
    id,
    at: new Date().toISOString(),
    method: call.method,
    path: call.path,
    status: call.status,
    ms: Math.round(call.ms),
  };
  const sensitive = isSensitivePath(call.path);
  if (call.error !== undefined && !sensitive) {
    entry.error = call.error instanceof Error ? call.error.name : "Network error";
  }
  set([...entries, entry].slice(-API_LOG_MAX));
  if (!response || response.ok || sensitive) return;
  let clone: Response;
  try {
    clone = response.clone();
  } catch {
    return; // body already used; nothing to show
  }
  void clone.text().then(
    (text) => {
      const body = text.length > ERROR_BODY_MAX ? `${text.slice(0, ERROR_BODY_MAX)}...` : text;
      set(entries.map((e) => (e.id === id ? { ...e, error: body } : e)));
    },
    () => {},
  );
}

export const isFailure = (e: ApiLogEntry) => e.status === 0 || e.status >= 400;

export function pickReportEntry(list: ApiLogEntry[], selectedId: number | null): ApiLogEntry | undefined {
  return list.find((e) => e.id === selectedId) ?? [...list].reverse().find(isFailure);
}

export function buildBugReport(p: { url: string; time: string; userAgent: string; entry?: ApiLogEntry }): string {
  const lines = [
    "Bug report (staging)",
    `Page: ${p.url}`,
    `Time: ${p.time}`,
    `Browser: ${p.userAgent}`,
  ];
  const e = p.entry;
  if (!e) {
    lines.push("Request: none selected, no failed request in the log");
  } else {
    lines.push(
      `Request: ${e.method} ${e.path}`,
      `Status: ${e.status === 0 ? "0 (no response)" : e.status}, ${e.ms} ms, at ${e.at}`,
      `Error: ${e.error ?? (isSensitivePath(e.path) ? "(not recorded for this endpoint)" : "(none)")}`,
    );
  }
  return lines.join("\n");
}
