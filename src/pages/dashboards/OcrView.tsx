import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { useCachedJson, isUnknownOutcome } from "@/lib/cached-fetch";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { OcrAccuracyCard } from "../dashboard-b/OcrAccuracyCard";
import { monthWindow } from "./dashboard-widgets-lib";
import { monthLabel, type Period } from "./dashboard-shared-lib";

// ---------------------------------------------------------------------------
// OCR tab (2026-09-25) — the detail behind Overview's OCR Accuracy card, built
// to judge a model change (e.g. customer POs Sonnet → Haiku) on evidence.
// Model comparison + per-field misses + recent problem scans come from
// GET /api/ocr-accuracy/models (every finished scan_queue row, including the
// failed and discarded ones the sample tables never see); the customer /
// supplier / scan-time breakdowns are the existing card, rendered in full.
// The period's highlighted day is ignored — a day is too few scans to judge.
// ---------------------------------------------------------------------------

type Group = {
  kind: string;
  kindLabel: string;
  model: string;
  scans: number;
  failed: number;
  discarded: number;
  pending: number;
  imported: number;
  clean: number;
  accuracy: number | null;
  failureRate: number | null;
  avgSec: number | null;
  p90Sec: number | null;
  fields: { field: string; fails: number; rate: number | null }[];
};
type Problem = {
  id: string;
  kindLabel: string;
  model: string;
  fileName: string;
  outcome: "failed" | "edited";
  detail: string;
  createdAt: string;
};
type Resp = { success?: boolean; data?: { groups: Group[]; problems: Problem[] } };

/** Same bar as the card: under 5 scans a rate is noise. */
const MIN_SAMPLE = 5;

function ocrRange(p: Period): { from: string; to: string } | null {
  if (p.mode === "range" && p.from && p.to) return { from: p.from, to: p.to };
  if (!p.month) return null;
  if (p.mode === "ytd") return { from: `${p.month.slice(0, 4)}-01-01`, to: `${p.month.slice(0, 4)}-12-31` };
  return monthWindow(p.month);
}

function rateCell(rate: number | null, n: number, good: "high" | "low" = "high") {
  if (rate === null) return <span className="text-[#9CA3AF]">—</span>;
  if (n < MIN_SAMPLE) return <span className="text-[#9CA3AF]">{rate}%*</span>;
  const ok = good === "high" ? rate >= 97 : rate <= 3;
  const warn = good === "high" ? rate >= 85 : rate <= 15;
  const color = ok ? "#3B6D11" : warn ? "#B5701A" : "#A32D2D";
  return <span className="font-semibold" style={{ color }}>{rate}%</span>;
}
function secs(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  if (v < 60) return `${v.toFixed(1)}s`;
  const m = Math.floor(v / 60);
  return `${m}m ${String(Math.round(v - m * 60)).padStart(2, "0")}s`;
}
/** "claude-haiku-4-5-20251001" → "Haiku 4.5"; anything else as-is. */
function modelName(m: string): string {
  const x = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m);
  return x ? `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}.${x[3]}` : m;
}

const TH = "px-3 py-2 text-[11px] uppercase tracking-wide text-[#8A8577] font-medium";
const TD = "px-3 py-2 tabular-nums";

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
      <CardContent className="p-5 max-md:p-4">
        <div className="mb-3">
          <div className="text-base font-semibold text-[#1F1D1B]">{title}</div>
          {note ? <div className="text-xs text-[#8A8577] mt-0.5">{note}</div> : null}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

export function OcrView({ period }: { period: Period }) {
  const range = ocrRange(period);
  const qs = range ? `?from=${range.from}&to=${range.to}` : "";
  const { data, loading, failure, refresh } = useCachedJson<Resp>(`/api/ocr-accuracy/models${qs}`);
  const d = data?.data;
  // Only a 2xx body licenses "no scans" — a killed request is not an empty period (C15).
  const loadFailed = !d && failure != null && isUnknownOutcome(failure);
  const label =
    period.mode === "range" ? `${period.from} – ${period.to}` : period.mode === "ytd" ? period.month.slice(0, 4) : monthLabel(period.month);
  const fieldNames = [...new Set((d?.groups ?? []).flatMap((g) => g.fields.map((f) => f.field)))];

  return (
    <div className="space-y-6 max-md:space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">OCR</h2>
        <span className="text-xs text-[#6B7280]">{label}</span>
      </div>
      <Section
        title="Model comparison"
        note={`${label} · every finished scan counts, including failed and discarded ones · accuracy = imported with no edits · * = fewer than ${MIN_SAMPLE}, not enough to judge`}
      >
        {loading && !d ? (
          <div className="py-8 text-center text-sm text-[#9CA3AF]">Loading…</div>
        ) : loadFailed ? (
          <div className="py-8 text-center text-sm">
            <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-[#C2410C]" />
            <p className="font-semibold text-[#1F1D1B]">OCR data could not be loaded</p>
            <p className="mt-1 text-[#4B5563]">{failure?.message}</p>
            <button
              type="button"
              onClick={refresh}
              className="mt-3 inline-flex items-center gap-1 rounded-md border border-[#E2DDD8] px-3 py-1.5 text-xs font-semibold text-[#5A5550] hover:bg-[#F5F2ED]"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </button>
          </div>
        ) : !d || d.groups.length === 0 ? (
          <div className="py-8 text-center text-sm text-[#9CA3AF]">No finished scans in this period.</div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-[#E7E0D4]">
            <table className="w-full text-[13px]">
              <thead className="bg-[#FAF7F2]">
                <tr>
                  <th className={`${TH} text-left`}>Document</th>
                  <th className={`${TH} text-left`}>Model</th>
                  <th className={`${TH} text-right`}>Scans</th>
                  <th className={`${TH} text-right`}>Accuracy</th>
                  <th className={`${TH} text-right`}>Failed</th>
                  <th className={`${TH} text-right`}>Discarded</th>
                  <th className={`${TH} text-right`}>Awaiting review</th>
                  <th className={`${TH} text-right`}>Avg time</th>
                  <th className={`${TH} text-right`}>Slowest 10%</th>
                </tr>
              </thead>
              <tbody>
                {d.groups.map((g) => (
                  <tr key={`${g.kind}-${g.model}`} className="border-t border-[#F0ECE3]">
                    <td className={`${TD} font-medium text-[#1F1D1B]`}>{g.kindLabel}</td>
                    <td className={`${TD} text-[#5F5E5A]`}>{modelName(g.model)}</td>
                    <td className={`${TD} text-right text-[#6B7280]`}>{g.scans}</td>
                    <td className={`${TD} text-right`}>
                      {rateCell(g.accuracy, g.imported)} <span className="text-[11px] text-[#9A9384]">{g.clean}/{g.imported}</span>
                    </td>
                    <td className={`${TD} text-right`}>
                      {rateCell(g.failureRate, g.scans, "low")} <span className="text-[11px] text-[#9A9384]">{g.failed}</span>
                    </td>
                    <td className={`${TD} text-right text-[#6B7280]`}>{g.discarded}</td>
                    <td className={`${TD} text-right text-[#6B7280]`}>{g.pending}</td>
                    <td className={`${TD} text-right font-semibold text-[#1F1D1B]`}>{secs(g.avgSec)}</td>
                    <td className={`${TD} text-right text-[#6B7280]`}>{secs(g.p90Sec)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {d && fieldNames.length > 0 ? (
        <Section title="Where it misses" note="Share of imported scans where the operator corrected this field">
          <div className="overflow-x-auto rounded-lg border border-[#E7E0D4]">
            <table className="w-full text-[13px]">
              <thead className="bg-[#FAF7F2]">
                <tr>
                  <th className={`${TH} text-left`}>Field</th>
                  {d.groups.map((g) => (
                    <th key={`${g.kind}-${g.model}`} className={`${TH} text-right`}>
                      {g.kindLabel} · {modelName(g.model)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {fieldNames.map((f) => (
                  <tr key={f} className="border-t border-[#F0ECE3]">
                    <td className={`${TD} font-medium text-[#1F1D1B]`}>{f}</td>
                    {d.groups.map((g) => {
                      const hit = g.fields.find((x) => x.field === f);
                      return (
                        <td key={`${g.kind}-${g.model}`} className={`${TD} text-right`}>
                          {hit ? (
                            <>
                              {rateCell(hit.rate, g.imported, "low")} <span className="text-[11px] text-[#9A9384]">{hit.fails}</span>
                            </>
                          ) : (
                            <span className="text-[#9CA3AF]">{g.imported ? "0%" : "—"}</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      {d && d.problems.length > 0 ? (
        <Section title="Recent problem scans" note="Latest failed or corrected scans — open the file to see whether it was the photo or the model">
          <div className="overflow-x-auto rounded-lg border border-[#E7E0D4]">
            <table className="w-full text-[13px]">
              <thead className="bg-[#FAF7F2]">
                <tr>
                  <th className={`${TH} text-left`}>When</th>
                  <th className={`${TH} text-left`}>File</th>
                  <th className={`${TH} text-left`}>Model</th>
                  <th className={`${TH} text-left`}>Outcome</th>
                  <th className={`${TH} text-left`}>Detail</th>
                </tr>
              </thead>
              <tbody>
                {d.problems.map((p) => (
                  <tr key={p.id} className="border-t border-[#F0ECE3] align-top">
                    <td className={`${TD} whitespace-nowrap text-[#6B7280]`}>{p.createdAt.slice(0, 16).replace("T", " ")}</td>
                    <td className={TD}>
                      <a
                        href={`/api/scan-queue/${encodeURIComponent(p.id)}/bytes`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[#6B5C32] underline underline-offset-2 break-all"
                      >
                        {p.fileName}
                      </a>
                      <div className="text-[11px] text-[#9A9384]">{p.kindLabel}</div>
                    </td>
                    <td className={`${TD} text-[#5F5E5A]`}>{modelName(p.model)}</td>
                    <td className={`${TD} font-semibold`} style={{ color: p.outcome === "failed" ? "#A32D2D" : "#B5701A" }}>
                      {p.outcome === "failed" ? "Failed" : "Corrected"}
                    </td>
                    <td className={`${TD} text-xs text-[#5F5E5A]`}>{p.detail || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      <OcrAccuracyCard period={label} range={range} />
    </div>
  );
}
