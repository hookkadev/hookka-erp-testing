// ============================================================
// /staging-notes — the latest PRs merged into staging.
//
// STAGING ONLY: lives on the `staging` branch, never PR this into main.
// deploy.yml runs scripts/gen-staging-notes.mjs on `staging` pushes, which
// writes /staging-notes.json into the build. Any other build has no file, so
// the page just says there is nothing to show.
// ============================================================
import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { formatDateTime } from "@/lib/utils";

type NotePr = {
  number: number;
  branch: string;
  type: string;
  scope: string | null;
  title: string;
  mergedAt: string;
};

type Notes = { generatedAt: string; commit: string; prs: NotePr[] };

const REPO = "https://github.com/hookkadev/hookka-erp-testing";

const GROUPS: Array<{ label: string; match: (t: string) => boolean }> = [
  { label: "New features", match: (t) => t === "feat" },
  { label: "Fixes", match: (t) => t === "fix" },
  { label: "Other", match: (t) => t !== "feat" && t !== "fix" },
];

export default function StagingNotes() {
  const [notes, setNotes] = useState<Notes | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    // A missing file comes back as the SPA's index.html, so a JSON parse
    // failure means "not generated for this build".
    fetch("/staging-notes.json", { cache: "no-store" })
      .then((r) => r.json() as Promise<Notes>)
      .then((j) => (Array.isArray(j?.prs) ? setNotes(j) : setMissing(true)))
      .catch(() => setMissing(true));
  }, []);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Staging patch notes"
        subtitle={
          notes
            ? `Latest ${notes.prs.length} PRs merged into staging. Build ${notes.commit}, ${formatDateTime(notes.generatedAt)}.`
            : "Latest PRs merged into staging."
        }
      />

      {missing && (
        <Card>
          <CardContent className="p-6 text-sm text-[#6B7280]">
            No patch notes in this build. They are generated on staging deploys only.
          </CardContent>
        </Card>
      )}

      {notes &&
        GROUPS.map((g) => {
          const prs = notes.prs.filter((p) => g.match(p.type));
          if (prs.length === 0) return null;
          return (
            <Card key={g.label}>
              <CardContent className="p-6">
                <h2 className="mb-3 text-sm font-semibold text-[#1F1D1B]">
                  {g.label} <span className="font-normal text-[#9CA3AF]">({prs.length})</span>
                </h2>
                <ul className="divide-y divide-[#F0ECE9]">
                  {prs.map((p) => (
                    <li key={p.number} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm">
                      <a
                        href={`${REPO}/pull/${p.number}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-[#6B5C32] hover:underline"
                      >
                        #{p.number}
                      </a>
                      {p.scope && (
                        <span className="rounded bg-[#F5F2ED] px-1.5 py-0.5 text-xs text-[#6B5C32]">{p.scope}</span>
                      )}
                      <span className="flex-1 text-[#1F1D1B]">{p.title}</span>
                      <span className="text-xs text-[#9CA3AF]">{formatDateTime(p.mergedAt)}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          );
        })}
    </div>
  );
}
