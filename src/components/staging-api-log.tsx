// Staging-only test tool on every dashboard page: a topbar button (in place of
// the workspace tab strip, see topbar.tsx) that opens a drawer with the last 50 /api calls (method, path, status, ms, and the
// error body for failures), plus "Copy as bug report". The log lives in memory
// (src/lib/staging-api-log.ts), fed by the fetch patch in api-client.ts.
// Renders only on the staging host. Staging-only: never PR this into main.
import { useState, useSyncExternalStore } from "react";
import { Activity, X } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import {
  buildBugReport,
  clearEntries,
  getEntries,
  isFailure,
  pickReportEntry,
  subscribe,
} from "@/lib/staging-api-log";

export function StagingApiLog() {
  if (!window.location.hostname.startsWith("staging.")) return null;
  return <ApiLogDrawer />;
}

function ApiLogDrawer() {
  const entries = useSyncExternalStore(subscribe, getEntries);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const { toast } = useToast();
  const failures = entries.filter(isFailure).length;

  const copyReport = async () => {
    const text = buildBugReport({
      url: window.location.href,
      time: new Date().toISOString(),
      userAgent: navigator.userAgent,
      entry: pickReportEntry(entries, selectedId),
    });
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Bug report copied");
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  };

  return (
    <div className="relative shrink-0 print:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close API log" : "Open API log"}
        aria-expanded={open}
        title="API log (staging)"
        className="flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-amber-500 px-3 text-xs font-semibold text-white hover:bg-amber-600"
      >
        <Activity className="h-4 w-4" />
        API{failures > 0 && <span className="rounded-full bg-red-600 px-1.5">{failures}</span>}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 flex max-h-[70vh] w-[min(36rem,calc(100vw-2rem))] flex-col rounded-lg border border-stone-200 bg-white shadow-xl">
          <div className="flex items-center gap-2 border-b border-stone-200 px-3 py-2">
            <span className="flex-1 text-sm font-semibold">API log (last {entries.length}, staging only)</span>
            <button type="button" onClick={copyReport} className="rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-100">
              Copy as bug report
            </button>
            <button type="button" onClick={() => { clearEntries(); setSelectedId(null); }} className="rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-100">
              Clear
            </button>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close API log" className="rounded p-1 hover:bg-stone-100">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="overflow-y-auto text-xs">
            {entries.length === 0 && <p className="p-3 text-stone-500">No API calls yet.</p>}
            {[...entries].reverse().map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => setSelectedId(e.id === selectedId ? null : e.id)}
                className={`block w-full border-b border-stone-100 px-3 py-1.5 text-left font-mono hover:bg-stone-50 ${e.id === selectedId ? "bg-amber-50" : ""}`}
              >
                <span className="flex gap-2">
                  <span className={`w-8 shrink-0 ${isFailure(e) ? "font-bold text-red-600" : "text-green-700"}`}>{e.status}</span>
                  <span className="w-12 shrink-0 text-stone-500">{e.method}</span>
                  <span className="min-w-0 flex-1 truncate">{e.path}</span>
                  <span className="shrink-0 text-stone-500">{e.ms} ms</span>
                </span>
                {e.error && <span className="mt-0.5 block whitespace-pre-wrap break-all text-red-700">{e.error}</span>}
              </button>
            ))}
          </div>
          <p className="border-t border-stone-200 px-3 py-1.5 text-[11px] text-stone-500">
            Click a row to pick it for the bug report; otherwise the last failed call is used.
          </p>
        </div>
      )}
    </div>
  );
}
