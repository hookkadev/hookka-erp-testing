// ---------------------------------------------------------------------------
// Daily email reports: per-report on/off + PIC list (BUG-36).
//
// Stored as ONE kv_config row, key 'daily_report_settings':
//   { "overdue": { "enabled": true, "recipients": ["a@x.com", ...] }, ... }
//
// A report with no entry here is "unconfigured" and keeps the legacy recipient
// chain in routes/reports.ts (env DAILY_REPORT_RECIPIENTS → kv
// 'daily_report_recipients' → SUPER_ADMINs), so shipping this changes nothing
// until someone saves the Settings → Email Reports page. Once a report IS
// configured, its own list is final: an empty list sends to nobody, it never
// falls back to the SUPER_ADMINs.
// ---------------------------------------------------------------------------

export const REPORT_SETTINGS_KEY = "daily_report_settings";

export const REPORT_KINDS = ["brief", "schedule", "overdue", "efficiency"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export interface ReportSetting {
  enabled: boolean;
  recipients: string[];
}
export type ReportSettings = Partial<Record<ReportKind, ReportSetting>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmail(s: string): boolean {
  return EMAIL_RE.test(s);
}

/** Trim, lowercase, drop invalid, de-duplicate (first spelling wins). */
export function cleanEmails(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const x of list) {
    const e = String(x ?? "").trim().toLowerCase();
    if (isEmail(e) && !out.includes(e)) out.push(e);
  }
  return out;
}

/**
 * Coerce whatever is in the kv row (or a PUT body) into ReportSettings.
 * Unknown kinds are dropped; a kind without an object is left unconfigured.
 */
export function normalizeReportSettings(raw: unknown): ReportSettings {
  let obj = raw;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out: ReportSettings = {};
  for (const kind of REPORT_KINDS) {
    const v = (obj as Record<string, unknown>)[kind];
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const s = v as { enabled?: unknown; recipients?: unknown };
    out[kind] = { enabled: s.enabled !== false, recipients: cleanEmails(s.recipients) };
  }
  return out;
}

/** Entries in a PUT body that are not valid emails — rejected, not silently dropped. */
export function invalidEmailsIn(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const bad: string[] = [];
  for (const kind of REPORT_KINDS) {
    const r = (raw as Record<string, { recipients?: unknown }>)[kind]?.recipients;
    if (!Array.isArray(r)) continue;
    for (const x of r) {
      const e = String(x ?? "").trim();
      if (e && !isEmail(e)) bad.push(e);
    }
  }
  return bad;
}

type Db = {
  prepare(sql: string): {
    bind(...v: unknown[]): { run(): Promise<unknown> };
    first<T>(): Promise<T | null>;
  };
};

export async function loadReportSettings(db: Db): Promise<ReportSettings> {
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = 'daily_report_settings'")
      .first<{ value: unknown }>();
    return normalizeReportSettings(row?.value);
  } catch {
    return {};
  }
}

export async function saveReportSettings(db: Db, settings: ReportSettings): Promise<void> {
  // Same upsert as routes/kv-config.ts (excluded.updated_at snake_case — see there).
  await db
    .prepare(
      `INSERT INTO kv_config (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .bind(REPORT_SETTINGS_KEY, JSON.stringify(settings), new Date().toISOString())
    .run();
}
