// T-010 R11 — scans the model was unsure of, plus per-kind speed / confidence stats (R1).
// Data: GET /api/scan-queue/review and /api/scan-queue/stats. Reviewing itself still
// happens in the PO / PI scan modal (Resume), which highlights the flagged fields.
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCachedJson } from "@/lib/cached-fetch";

type ReviewRow = { id: string; batchId: string; kind: string; fileName: string; lowConfidence: number; completedAt: string | null };
type Env<T> = { success: boolean; data: T };
type Kind = Record<string, unknown>;

// The DB adapter re-camelCases underscore keys, so read both spellings.
const num = (r: Kind, snake: string) => {
  const camel = snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  const v = Number(r[snake] ?? r[camel]);
  return Number.isFinite(v) ? v : null;
};

export default function ScanReviewPage() {
  const review = useCachedJson<Env<ReviewRow[]>>("/api/scan-queue/review", 30);
  const stats = useCachedJson<Env<{ days: number; kinds: Kind[] }>>("/api/scan-queue/stats?days=7", 60);
  const rows = review.data?.data ?? [];
  const kinds = stats.data?.data?.kinds ?? [];

  return (
    <div className="space-y-4 p-4">
      <h1 className="text-xl font-semibold">Scan review</h1>
      <Card>
        <CardHeader><CardTitle>Needs a second look ({rows.length})</CardTitle></CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-[#9CA3AF]">{review.loading ? "Loading…" : "Nothing flagged in the last 14 days."}</p>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-[#9CA3AF]"><th>File</th><th>Type</th><th>Unsure fields</th><th>Scanned</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-[#E2DDD8]">
                    <td className="py-1.5">{r.fileName}</td>
                    <td>{r.kind === "po" ? "Sales order" : "Supplier doc"}</td>
                    <td className="font-medium text-amber-700">{r.lowConfidence}</td>
                    <td>{r.completedAt ? new Date(r.completedAt).toLocaleString() : "—"}</td>
                    <td><Link className="text-[#6B5C32] underline" to={r.kind === "po" ? "/sales" : "/procurement/pi"}>Open scan</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Last 7 days</CardTitle></CardHeader>
        <CardContent>
          {kinds.length === 0 ? (
            <p className="text-sm text-[#9CA3AF]">{stats.loading ? "Loading…" : "No finished scans yet."}</p>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-[#9CA3AF]"><th>Type</th><th>Scans</th><th>Median s</th><th>p95 s</th><th>Cache hit %</th><th>Unsure fields</th><th>Slowest step</th></tr></thead>
              <tbody>
                {kinds.map((k) => (
                  <tr key={String(k.kind)} className="border-t border-[#E2DDD8]">
                    <td className="py-1.5">{String(k.kind)}</td>
                    <td>{num(k, "scans") ?? "—"}</td>
                    <td>{fmtSec(num(k, "p50_duration_ms"))}</td>
                    <td>{fmtSec(num(k, "p95_duration_ms"))}</td>
                    <td>{num(k, "cache_hit_pct") ?? "—"}</td>
                    <td>{num(k, "low_confidence") ?? 0}</td>
                    <td>{String(k.slowest_step ?? k.slowestStep ?? "—")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const fmtSec = (ms: number | null) => (ms == null ? "—" : (ms / 1000).toFixed(1));
