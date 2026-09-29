// Settings → Email Reports (BUG-36). One card per daily email report: on/off,
// the PICs who receive it, and a test send. Backed by GET/PUT
// /api/reports/settings (kv_config['daily_report_settings']). The send times
// themselves live in .github/workflows/daily-reports.yml.
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { useToast } from "@/components/ui/toast";
import { X } from "lucide-react";

type Kind = "brief" | "schedule" | "overdue" | "efficiency";
type Setting = { enabled: boolean; recipients: string[] };

const REPORTS: { kind: Kind; title: string; description: string; when: string }[] = [
  {
    kind: "overdue",
    title: "Overdue Orders",
    description: "Sales orders past their customer delivery date that production has not finished.",
    when: "Daily 08:00",
  },
  {
    kind: "schedule",
    title: "Today's Production Orders",
    description: "Today's production plan by department.",
    when: "Daily 08:00",
  },
  {
    kind: "efficiency",
    title: "Production Efficiency & Revenue",
    description: "Today's per-worker and per-department efficiency, plus production revenue (same figure as the dashboard).",
    when: "Daily 18:30",
  },
  {
    kind: "brief",
    title: "Production Morning Brief",
    description: "Today's plan, overdue totals and yesterday's output in one email.",
    when: "Daily 07:00",
  },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
        subtitle="Choose who receives each daily report. Reports are not sent on Sundays or public holidays."
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
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);

  const dirty =
    !saved || saved.enabled !== enabled || saved.recipients.join(",") !== pics.join(",");

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

  async function save() {
    setBusy("save");
    try {
      const r = await fetch("/api/reports/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [report.kind]: { enabled, recipients: pics } }),
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
            <CardDescription>
              {report.description} <span className="text-[#6B5C32]">{report.when}</span>
            </CardDescription>
          </div>
          <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 accent-[#6B5C32]"
            />
            {enabled ? "On" : "Off"}
          </label>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!saved && (
          <p className="text-xs text-[#8A7F73]">
            Not set up yet. It currently goes to the people listed below. Save to make this list
            its own.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {pics.length === 0 && (
            <span className="text-sm text-[#9A3A2D]">No PIC. This report will not be sent.</span>
          )}
          {pics.map((e) => (
            <span
              key={e}
              className="inline-flex items-center gap-1 rounded-full bg-[#F0ECE9] px-3 py-1 text-xs text-[#1F1D1B]"
            >
              {nameOf(e) ? `${nameOf(e)} · ${e}` : e}
              <button
                type="button"
                aria-label={`Remove ${e}`}
                onClick={() => setPics(pics.filter((x) => x !== e))}
                className="cursor-pointer text-[#6B7280] hover:text-[#9A3A2D]"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Input
            list="report-pic-users"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="Add PIC: pick a user or type an email"
            className="max-w-sm"
          />
          <Button type="button" variant="outline" onClick={add}>
            Add
          </Button>
          <div className="ml-auto flex gap-2">
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
        </div>
      </CardContent>
    </Card>
  );
}
