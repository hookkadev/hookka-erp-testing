// ============================================================
// /staging-mail: the mail staging has sent, newest first.
//
// STAGING ONLY: lives on the `staging` branch, never PR this into main.
// Reads /api/staging-mail (MailSlurp sent mail, proxied by the worker, plus
// outbox rows that have not gone out). Admins only; the API 404s off staging.
// Bodies render in a sandboxed iframe with scripts off.
// ============================================================
import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { formatDateTime } from "@/lib/utils";

type Row = { id: string; at: string; to: string[]; subject: string; attachmentCount: number };
type NotSent = {
  id: string;
  toAddress: string;
  subject: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
};
type Detail = Row & {
  body: string;
  isHtml: boolean;
  attachments: { id: string; name: string; contentType: string; size: number }[];
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error || `HTTP ${r.status}`);
  return j as T;
}

export default function StagingMail() {
  const onStaging = window.location.hostname.startsWith("staging.");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ rows: Row[]; totalPages: number; notSent: NotSent[] } | null>(null);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState("");

  useEffect(() => {
    if (!onStaging) return;
    getJson<{ rows: Row[]; totalPages: number; notSent: NotSent[] }>(`/api/staging-mail?page=${page}`)
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((e: Error) => setError(e.message));
  }, [onStaging, page]);

  const toggle = (id: string) => {
    setDetail(null);
    setDetailError("");
    setOpenId(openId === id ? null : id);
  };

  useEffect(() => {
    if (!openId) return;
    getJson<Detail>(`/api/staging-mail/${openId}`)
      .then(setDetail)
      .catch((e: Error) => setDetailError(e.message));
  }, [openId]);

  if (!onStaging) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-[#6B7280]">This page is only on staging.</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Staging mail outbox"
        subtitle="Mail staging sent through MailSlurp, newest first. Click a row to see the body."
      />

      {error && (
        <Card>
          <CardContent className="p-6 text-sm text-[#B91C1C]">{error}</CardContent>
        </Card>
      )}

      {data && data.notSent.length > 0 && (
        <Card>
          <CardContent className="p-6">
            <h2 className="mb-2 text-sm font-semibold text-[#1F1D1B]">Queued, not sent</h2>
            <ul className="divide-y divide-[#F0ECE9]">
              {data.notSent.map((n) => (
                <li key={n.id} className="py-2 text-sm">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span className="rounded bg-[#FEF2F2] px-1.5 py-0.5 text-xs text-[#B91C1C]">
                      {n.status} · {n.attempts} tries
                    </span>
                    <span className="flex-1 text-[#1F1D1B]">{n.subject}</span>
                    <span className="text-xs text-[#6B7280]">{n.toAddress}</span>
                    <span className="text-xs text-[#9CA3AF]">{formatDateTime(n.createdAt)}</span>
                  </div>
                  {n.lastError && <div className="mt-1 font-mono text-xs text-[#B91C1C]">{n.lastError}</div>}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {data && (
        <Card>
          <CardContent className="p-6">
            {data.rows.length === 0 ? (
              <p className="text-sm text-[#6B7280]">No sent mail.</p>
            ) : (
              <ul className="divide-y divide-[#F0ECE9]">
                {data.rows.map((r) => (
                  <li key={r.id} className="py-2 text-sm">
                    <button
                      type="button"
                      onClick={() => toggle(r.id)}
                      className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 text-left"
                    >
                      <span className="rounded bg-[#F0FDF4] px-1.5 py-0.5 text-xs text-[#166534]">sent</span>
                      <span className="flex-1 text-[#1F1D1B]">{r.subject || "(no subject)"}</span>
                      <span className="text-xs text-[#6B7280]">{r.to.join(", ")}</span>
                      {r.attachmentCount > 0 && (
                        <span className="text-xs text-[#6B5C32]">{r.attachmentCount} file(s)</span>
                      )}
                      <span className="text-xs text-[#9CA3AF]">{formatDateTime(r.at)}</span>
                    </button>
                    {openId === r.id && (
                      <div className="mt-2 space-y-2">
                        {detailError && <p className="text-xs text-[#B91C1C]">{detailError}</p>}
                        {!detail && !detailError && <p className="text-xs text-[#9CA3AF]">Loading...</p>}
                        {detail && (
                          <>
                            {detail.attachments.length > 0 && (
                              <ul className="flex flex-wrap gap-2 text-xs">
                                {detail.attachments.map((a) => (
                                  <li key={a.id}>
                                    <a
                                      href={`/api/staging-mail/${detail.id}/attachments/${a.id}`}
                                      className="text-[#6B5C32] hover:underline"
                                    >
                                      {a.name} ({Math.ceil(a.size / 1024)} KB)
                                    </a>
                                  </li>
                                ))}
                              </ul>
                            )}
                            <iframe
                              title={`Body of ${detail.subject}`}
                              sandbox=""
                              referrerPolicy="no-referrer"
                              srcDoc={detail.isHtml ? detail.body : `<pre>${escapeHtml(detail.body)}</pre>`}
                              className="h-[600px] w-full rounded border border-[#E5E1DC] bg-white"
                            />
                          </>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex items-center gap-3 text-xs text-[#6B7280]">
              <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} className="disabled:opacity-40">
                Newer
              </button>
              <span>
                Page {page + 1} of {Math.max(1, data.totalPages)}
              </span>
              <button
                type="button"
                disabled={page + 1 >= data.totalPages}
                onClick={() => setPage(page + 1)}
                className="disabled:opacity-40"
              >
                Older
              </button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
