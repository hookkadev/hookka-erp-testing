// ============================================================
// /staging-schema: does the staging database have every table and column
// the code expects?
//
// STAGING ONLY: lives on the `staging` branch, never PR this into main.
// Reads GET /api/staging-schema (SUPER_ADMIN, 404 off staging). "Expected" is
// tests/db-schema.json, a names-only snapshot of the production schema that
// CI checks route SQL against. Read-only: nothing here changes the database.
// ============================================================
import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import type { SchemaDiff, TableColumn } from "@/api/lib/staging-schema-diff";

const isStaging = window.location.hostname.startsWith("staging.");

function List({ title, note, items }: { title: string; note: string; items: string[] }) {
  return (
    <Card>
      <CardContent className="space-y-2 p-6">
        <h2 className="text-sm font-semibold text-[#1F1D1B]">
          {title} ({items.length})
        </h2>
        <p className="text-xs text-[#6B7280]">{note}</p>
        {items.length > 0 && (
          <ul className="max-h-80 overflow-auto font-mono text-xs text-[#1F1D1B]">
            {items.map((s) => (
              <li key={s} className="py-0.5">
                {s}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const tc = (x: TableColumn) => `${x.table}.${x.column}`;

export default function StagingSchema() {
  const [diff, setDiff] = useState<SchemaDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isStaging) return;
    fetch("/api/staging-schema", { cache: "no-store" })
      .then(async (r) => {
        const j = (await r.json().catch(() => null)) as
          | { success?: boolean; error?: string; data?: SchemaDiff }
          | null;
        if (!r.ok || !j?.success || !j.data) throw new Error(j?.error ?? `HTTP ${r.status}`);
        setDiff(j.data);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Staging schema check"
        subtitle={
          diff
            ? `Snapshot: ${diff.expectedTables} tables, ${diff.expectedColumns} columns. Staging DB: ${diff.actualTables} tables, ${diff.actualColumns} columns.`
            : "Expected columns against the staging database."
        }
      />

      <Card>
        <CardContent className="space-y-1 p-6 text-xs text-[#6B7280]">
          <p>
            Expected = tests/db-schema.json, a names-only snapshot of the production schema taken by
            scripts/refresh-db-schema-fixture.mjs and hand-extended when a route self-applies a new
            column. It is only as fresh as its last refresh.
          </p>
          <p>
            Missing on staging is often not a bug: a self-applied column appears only after the first
            POST or PUT on the route that adds it. Columns on staging that are not in the snapshot are
            usually staging-only features or a stale snapshot. Types are not checked except for the
            real-boolean list in tests/db-boolean-columns.json.
          </p>
        </CardContent>
      </Card>

      {!isStaging && (
        <Card>
          <CardContent className="p-6 text-sm text-[#6B7280]">This page only works on staging.</CardContent>
        </Card>
      )}

      {error && (
        <Card>
          <CardContent className="p-6 text-sm text-[#B91C1C]">Could not load: {error}</CardContent>
        </Card>
      )}

      {diff && (
        <>
          <List
            title="Missing tables"
            note="In the snapshot, not in the staging database."
            items={diff.missingTables}
          />
          <List
            title="Missing columns"
            note="Table exists on staging but lacks the column."
            items={diff.missingColumns.map(tc)}
          />
          <List
            title="Boolean type mismatches"
            note="Snapshot says real BOOLEAN and staging disagrees, or the reverse."
            items={diff.booleanMismatches.map((m) => `${tc(m)}: expected ${m.expected}, staging has ${m.actual}`)}
          />
          <List
            title="Tables not in snapshot"
            note="On staging only. Informational."
            items={diff.extraTables}
          />
          <List
            title="Columns not in snapshot"
            note="On staging only. Informational."
            items={diff.extraColumns.map(tc)}
          />
        </>
      )}
    </div>
  );
}
