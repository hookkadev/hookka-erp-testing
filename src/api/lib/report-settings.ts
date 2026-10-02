// ---------------------------------------------------------------------------
// Email reports: per-report on/off + PIC list (BUG-36) + schedule
// (daily / weekly / monthly at one or more SGT times).
//
// Stored as ONE kv_config row, key 'daily_report_settings':
//   { "overdue": { "enabled": true, "recipients": ["a@x.com", ...],
//                  "frequency": "weekly", "times": ["08:00", "17:00"], "weekday": 1,
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
  /** "HH:MM" in SGT, sorted, at least one. Each one sends the report. */
  times: string[];
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

export const MAX_TIMES = 8;

/**
 * Valid, de-duplicated, sorted "HH:MM" list. Reads the old single `time`
 * field when there is no `times`, so rows saved before this keep their time.
 */
function cleanTimes(s: Record<string, unknown>, kind: ReportKind): string[] {
  const raw = Array.isArray(s.times) ? s.times : [s.time];
  const out = [...new Set(raw.filter((t): t is string => typeof t === "string" && TIME_RE.test(t)))]
    .sort()
    .slice(0, MAX_TIMES);
  return out.length > 0 ? out : [DEFAULT_TIMES[kind]];
}

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
      times: cleanTimes(s, kind),
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
 * Which send slot of `kind` is due at `now`, as "YYYY-MM-DD HH:MM" (SGT), or
 * null. Due = today (SGT) is the configured day, and the latest of today's
 * times that has passed has not gone out yet. Checking "passed + not sent
 * yet" instead of "exactly now" means a late or dropped cron run still sends,
 * just late; two missed slots send once, not twice. An unconfigured report
 * keeps its old daily time. Sunday / public-holiday skipping is the caller's
 * job. The caller stores the returned slot as the report's lastSent.
 */
export function dueSlot(
  kind: ReportKind,
  setting: ReportSetting | undefined,
  now: Date,
  lastSent: string | undefined,
): string | null {
  const sgt = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString();
  const today = sgt.slice(0, 10);
  const d = new Date(today + "T00:00:00Z");
  if (setting?.frequency === "weekly" && d.getUTCDay() !== setting.weekday) return null;
  if (setting?.frequency === "monthly" && d.getUTCDate() !== setting.monthDay) return null;
  const passed = (setting?.times ?? [DEFAULT_TIMES[kind]]).filter((t) => t <= sgt.slice(11, 16));
  if (passed.length === 0) return null;
  const slot = `${today} ${passed[passed.length - 1]}`;
  // A bare "YYYY-MM-DD" is the pre-multi-time format (one send a day): treat
  // it as the whole day sent, so the switch-over day never sends twice.
  const last = lastSent && lastSent.length === 10 ? `${lastSent} 23:59` : lastSent;
  return last && last >= slot ? null : slot;
}

/**
 * First run on a database: nothing records what already went out, so every
 * report whose time had already passed today would send again, a duplicate of
 * what the old fixed crons sent. Mark those as handled and leave today's later
 * times to send normally. Fills `lastSent` in place; returns the kinds it
 * seeded, which the caller must not send this run.
 */
export function seedLastSent(
  settings: ReportSettings,
  lastSent: Partial<Record<ReportKind, string>>,
  now: Date,
): ReportKind[] {
  const today = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const seeded: ReportKind[] = [];
  for (const kind of REPORT_KINDS) {
    if (lastSent[kind] !== undefined) continue;
    lastSent[kind] = dueSlot(kind, settings[kind], now, undefined) ?? `${today} 00:00`;
    seeded.push(kind);
  }
  return seeded;
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

// { brief: "2026-09-29 07:00", ... } — the SGT slot each report last went out
// on its schedule (older rows hold just the day). Its own key so a settings
// save never clobbers it.
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
