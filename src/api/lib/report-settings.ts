// ---------------------------------------------------------------------------
// Email reports: per-report on/off + PIC list (BUG-36) + schedule
// (daily / weekly / monthly at a set SGT time).
//
// Stored as ONE kv_config row, key 'daily_report_settings':
//   { "overdue": { "enabled": true, "recipients": ["a@x.com", ...],
//                  "frequency": "weekly", "time": "08:00", "weekday": 1,
//                  "monthDay": 1 }, ... }
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

export const FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export interface ReportSetting {
  enabled: boolean;
  recipients: string[];
  frequency: Frequency;
  /** "HH:MM" in SGT. */
  time: string;
  /** weekly: 1 (Mon) .. 6 (Sat). Sundays never send. */
  weekday: number;
  /** monthly: 1 .. 28, so every month has the day. */
  monthDay: number;
}
export type ReportSettings = Partial<Record<ReportKind, ReportSetting>>;

// When each report went out before it had a schedule of its own.
export const DEFAULT_TIMES: Record<ReportKind, string> = {
  brief: "07:00",
  schedule: "08:00",
  overdue: "08:00",
  efficiency: "18:30",
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function intIn(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
}

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
    const s = v as Record<string, unknown>;
    out[kind] = {
      enabled: s.enabled !== false,
      recipients: cleanEmails(s.recipients),
      frequency: FREQUENCIES.includes(s.frequency as Frequency) ? (s.frequency as Frequency) : "daily",
      time: typeof s.time === "string" && TIME_RE.test(s.time) ? s.time : DEFAULT_TIMES[kind],
      weekday: intIn(s.weekday, 1, 6, 1),
      monthDay: intIn(s.monthDay, 1, 28, 1),
    };
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

/**
 * Is `kind` due at `now`? Due = today (SGT) is the configured day, the
 * configured time has passed, and it has not gone out today. Checking
 * "passed + not sent yet" instead of "exactly now" means a late or dropped
 * cron run still sends, just late. An unconfigured report keeps its old
 * daily time. Sunday / public-holiday skipping is the caller's job.
 */
export function isDue(
  kind: ReportKind,
  setting: ReportSetting | undefined,
  now: Date,
  lastSent: string | undefined,
): boolean {
  const sgt = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString();
  const today = sgt.slice(0, 10);
  if (lastSent === today) return false;
  if (sgt.slice(11, 16) < (setting?.time ?? DEFAULT_TIMES[kind])) return false;
  const d = new Date(today + "T00:00:00Z");
  if (setting?.frequency === "weekly") return d.getUTCDay() === setting.weekday;
  if (setting?.frequency === "monthly") return d.getUTCDate() === setting.monthDay;
  return true;
}

type Db = {
  prepare(sql: string): {
    bind(...v: unknown[]): { run(): Promise<unknown>; first<T>(): Promise<T | null> };
  };
};

export async function loadReportSettings(db: Db): Promise<ReportSettings> {
  return normalizeReportSettings(await loadKv(db, REPORT_SETTINGS_KEY));
}

export async function saveReportSettings(db: Db, settings: ReportSettings): Promise<void> {
  await saveKv(db, REPORT_SETTINGS_KEY, settings);
}

// { brief: "2026-09-29", ... } — the SGT day each report last went out on its
// schedule. Its own key so a settings save never clobbers it.
const LAST_SENT_KEY = "daily_report_last_sent";

export async function loadLastSent(db: Db): Promise<Partial<Record<ReportKind, string>>> {
  let v = await loadKv(db, LAST_SENT_KEY);
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  return v && typeof v === "object" ? (v as Partial<Record<ReportKind, string>>) : {};
}

export async function saveLastSent(db: Db, v: Partial<Record<ReportKind, string>>): Promise<void> {
  await saveKv(db, LAST_SENT_KEY, v);
}

async function loadKv(db: Db, key: string): Promise<unknown> {
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = ?")
      .bind(key)
      .first<{ value: unknown }>();
    return row?.value;
  } catch {
    return undefined;
  }
}

async function saveKv(db: Db, key: string, value: unknown): Promise<void> {
  // Same upsert as routes/kv-config.ts (excluded.updated_at snake_case — see there).
  await db
    .prepare(
      `INSERT INTO kv_config (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .bind(key, JSON.stringify(value), new Date().toISOString())
    .run();
}
