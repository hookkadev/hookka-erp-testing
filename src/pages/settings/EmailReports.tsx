// Settings → Email Reports (BUG-36). One card per email report: on/off, when
// it goes out (daily / weekly / monthly at one or more SGT times), who receives
// it, and a test send. Backed by GET/PUT /api/reports/settings
// (kv_config['daily_report_settings']). The 15-minute cron in
// .github/workflows/daily-reports.yml sends whatever is due.
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { useToast } from "@/components/ui/toast";
import { Plus, X } from "lucide-react";
import { DEFAULT_TIMES, MAX_TIMES, type Frequency } from "@/api/lib/report-settings";

type Kind = "brief" | "schedule" | "overdue" | "efficiency";
type Setting = {
  enabled: boolean;
  recipients: string[];
  frequency: Frequency;
  times: string[];
  weekday: number;
  monthDay: number;
};

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const REPORTS: { kind: Kind; title: string; description: string }[] = [
  {
    kind: "overdue",
    title: "Overdue Orders",
    description: "Sales orders past their customer delivery date that production has not finished.",
  },
  {
    kind: "schedule",
    title: "Today's Production Orders",
    description: "Today's production plan by department.",
  },
  {
    kind: "efficiency",
    title: "Production Efficiency",
    description: "Per-worker and per-department efficiency for the previous working day.",
  },
  {
    kind: "brief",
    title: "Production Morning Brief",
    description: "Today's plan, overdue totals and yesterday's output in one email.",
  },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32] focus-visible:ring-offset-1";
const CONTROL = `h-9 rounded-md border border-[#E2DDD8] bg-white px-2 text-sm text-[#1F1D1B] ${FOCUS}`;
const PANEL = "min-w-0 space-y-3 rounded-lg border border-[#E2DDD8] bg-[#FAF8F6] p-4";
const PANEL_TITLE = "text-sm font-semibold text-[#1F1D1B]";
const FIELD = "flex flex-col gap-1 text-xs text-[#6B7280]";
const CHIP =
  "inline-flex max-w-full items-center gap-1 rounded-full border border-[#E2DDD8] bg-white px-3 py-1 text-sm text-[#1F1D1B]";
const CHIP_X = `shrink-0 cursor-pointer rounded-full p-0.5 text-[#6B7280] hover:bg-[#F0ECE9] hover:text-[#9A3A2D] ${FOCUS}`;

/** "17:30" (stored, SGT) → "05:30 PM" (shown). */
function fmtTime(t: string): string {
  const [h, m] = t.split(":").map(Number);
  return `${String(h % 12 || 12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

// Loose shape of every response this page reads (settings / users / send).
type ApiResp = {
  success?: boolean;
  error?: string;
  data?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  ok?: boolean;
  sent?: number;
  failed?: number;
  errors?: string[];
};

export default function EmailReportsPage() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<Partial<Record<Kind, Setting>>>({});
  const [fallback, setFallback] = useState<string[]>([]);
  const [users, setUsers] = useState<{ email: string; displayName: string }[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/reports/settings");
        const j = (await r.json()) as ApiResp;
        if (!r.ok || !j.success) throw new Error(j.error || `HTTP ${r.status}`);
        setSettings(j.data.settings ?? {});
        setFallback(j.data.fallback ?? []);
        setLoaded(true);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      }
      // The picker list is a convenience; typing an address still works without it.
      try {
        const r = await fetch("/api/users");
        const j = (await r.json()) as ApiResp;
        if (r.ok && Array.isArray(j.data)) {
          setUsers(
            (j.data as { email?: string; displayName?: string; isActive?: boolean }[])
              .filter((u) => u.isActive && u.email)
              .map((u) => ({ email: u.email!, displayName: u.displayName ?? "" })),
          );
        }
      } catch {
        /* picker stays empty */
      }
    })();
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Email Reports"
        subtitle="Choose when each report goes out and who receives it. Times are Malaysia time; a report goes out within about 15 minutes of its time. Nothing is sent on Sundays or public holidays."
      />
      {loadError && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Could not load report settings: {loadError}
        </p>
      )}
      <datalist id="report-pic-users">
        {users.map((u) => (
          <option key={u.email} value={u.email}>
            {u.displayName}
          </option>
        ))}
      </datalist>
      {loaded &&
        REPORTS.map((r) => (
          <ReportCard
            key={r.kind}
            report={r}
            saved={settings[r.kind]}
            fallback={fallback}
            users={users}
            onSaved={(s) => setSettings((prev) => ({ ...prev, [r.kind]: s }))}
            toast={toast}
          />
        ))}
    </div>
  );
}

function ReportCard({
  report,
  saved,
  fallback,
  users,
  onSaved,
  toast,
}: {
  report: (typeof REPORTS)[number];
  saved: Setting | undefined;
  fallback: string[];
  users: { email: string; displayName: string }[];
  onSaved: (s: Setting) => void;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  // Unconfigured → start from who it goes to today, so saving is a no-op change.
  const [enabled, setEnabled] = useState(saved?.enabled ?? true);
  const [pics, setPics] = useState<string[]>(saved?.recipients ?? fallback);
  const [frequency, setFrequency] = useState<Frequency>(saved?.frequency ?? "daily");
  const [times, setTimes] = useState<string[]>(saved?.times ?? [DEFAULT_TIMES[report.kind]]);
  const [newTime, setNewTime] = useState("");
  const [weekday, setWeekday] = useState(saved?.weekday ?? 1);
  const [monthDay, setMonthDay] = useState(saved?.monthDay ?? 1);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);

  const dirty =
    !saved ||
    saved.enabled !== enabled ||
    saved.recipients.join(",") !== pics.join(",") ||
    saved.frequency !== frequency ||
    saved.times.join(",") !== times.join(",") ||
    saved.weekday !== weekday ||
    saved.monthDay !== monthDay;

  const nameOf = (email: string) => users.find((u) => u.email.toLowerCase() === email)?.displayName;

  function add() {
    const e = draft.trim().toLowerCase();
    if (!e) return;
    if (!EMAIL_RE.test(e)) {
      toast.error(`"${draft.trim()}" is not a valid email address`);
      return;
    }
    if (!pics.includes(e)) setPics([...pics, e]);
    setDraft("");
  }

  function addTime() {
    if (!newTime || times.includes(newTime)) return;
    setTimes([...times, newTime].sort());
    setNewTime("");
  }

  async function save() {
    setBusy("save");
    try {
      const r = await fetch("/api/reports/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          [report.kind]: { enabled, recipients: pics, frequency, times, weekday, monthDay },
        }),
      });
      const j = (await r.json().catch(() => ({}))) as ApiResp;
      if (!r.ok || !j.success) throw new Error(j.error || `HTTP ${r.status}`);
      onSaved(j.data[report.kind]);
      toast.success(`${report.title} saved`);
    } catch (e) {
      toast.error(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    setBusy("test");
    try {
      const r = await fetch(`/api/reports/${report.kind}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: pics }),
      });
      const j = (await r.json().catch(() => ({}))) as ApiResp;
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      if ((j.failed ?? 0) > 0 || !j.ok) {
        toast.error(`Sent ${j.sent ?? 0}, failed ${j.failed ?? 0}: ${(j.errors ?? []).join("; ")}`);
      } else {
        toast.success(`Test sent to ${j.sent} recipient${j.sent === 1 ? "" : "s"}`);
      }
    } catch (e) {
      toast.error(`Test send failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>{report.title}</CardTitle>
            <CardDescription>{report.description}</CardDescription>
          </div>
          <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-[#1F1D1B]">
            <input
              type="checkbox"
              role="switch"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className={`h-4 w-4 accent-[#6B5C32] ${FOCUS}`}
            />
            {enabled ? "On" : "Off"}
          </label>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <section aria-labelledby={`${report.kind}-schedule`} className={PANEL}>
            <h3 id={`${report.kind}-schedule`} className={PANEL_TITLE}>
              Schedule
            </h3>
            <div className="flex flex-wrap items-end gap-3">
              <label className={FIELD}>
                Frequency
                <select
                  value={frequency}
                  onChange={(e) => setFrequency(e.target.value as Frequency)}
                  className={CONTROL}
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              {frequency === "weekly" && (
                <label className={FIELD}>
                  Day
                  <select
                    value={weekday}
                    onChange={(e) => setWeekday(Number(e.target.value))}
                    className={CONTROL}
                  >
                    {WEEKDAYS.map((d, i) => (
                      <option key={d} value={i + 1}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {frequency === "monthly" && (
                <label className={FIELD}>
                  Day of month
                  <select
                    value={monthDay}
                    onChange={(e) => setMonthDay(Number(e.target.value))}
                    className={CONTROL}
                  >
                    {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <div className="space-y-2">
              <p className="text-xs text-[#6B7280]">Send times (Malaysia time)</p>
              <ul className="flex flex-wrap gap-2" aria-label="Send times">
                {times.map((t) => (
                  <li key={t} className={CHIP}>
                    {fmtTime(t)}
                    {times.length > 1 && (
                      <button
                        type="button"
                        aria-label={`Remove ${fmtTime(t)}`}
                        onClick={() => setTimes(times.filter((x) => x !== t))}
                        className={CHIP_X}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {times.length < MAX_TIMES ? (
                <div className="flex flex-wrap gap-2">
                  <input
                    type="time"
                    aria-label="New send time"
                    step={900}
                    value={newTime}
                    onChange={(e) => setNewTime(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addTime();
                      }
                    }}
                    className={CONTROL}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!newTime || times.includes(newTime)}
                    onClick={addTime}
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    Add time
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-[#6B7280]">Up to {MAX_TIMES} times.</p>
              )}
            </div>
          </section>

          <section aria-labelledby={`${report.kind}-recipients`} className={PANEL}>
            <h3 id={`${report.kind}-recipients`} className={PANEL_TITLE}>
              Recipients
            </h3>
            {!saved && (
              <p className="text-xs text-[#6B7280]">
                Not set up yet. These are the people it goes to today. Save to keep this list.
              </p>
            )}
            {pics.length === 0 ? (
              <p className="text-sm text-[#9A3A2D]">No recipients. This report will not be sent.</p>
            ) : (
              <ul className="flex flex-wrap gap-2" aria-label="Recipients">
                {pics.map((e) => {
                  const label = nameOf(e) ? `${nameOf(e)} · ${e}` : e;
                  return (
                    <li key={e} className={CHIP} title={label}>
                      <span className="min-w-0 max-w-[16rem] truncate">{label}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${e}`}
                        onClick={() => setPics(pics.filter((x) => x !== e))}
                        className={CHIP_X}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="flex gap-2">
              <Input
                list="report-pic-users"
                aria-label="Add recipient"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add();
                  }
                }}
                placeholder="Add recipient: pick a user or type an email"
                className="min-w-0 flex-1"
              />
              <Button type="button" variant="outline" disabled={!draft.trim()} onClick={add}>
                Add
              </Button>
            </div>
          </section>
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null || pics.length === 0}
            onClick={sendTest}
          >
            {busy === "test" ? "Sending…" : "Send test now"}
          </Button>
          <Button type="button" variant="primary" disabled={busy !== null || !dirty} onClick={save}>
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
