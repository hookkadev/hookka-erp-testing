// Staging-only: never PR this into main.
// Pure diff behind GET /api/staging-schema. "Expected" is the schema snapshot
// in tests/db-schema.json (table -> column names) plus the real-boolean list in
// tests/db-boolean-columns.json. "Actual" is information_schema.columns rows
// from the database the request ran against. No I/O here so it can be tested
// with fixtures.

export type SchemaMap = Record<string, string[]>;
export type ActualColumn = { table: string; column: string; dataType: string };
export type TableColumn = { table: string; column: string };

export type SchemaDiff = {
  expectedTables: number;
  expectedColumns: number;
  actualTables: number;
  actualColumns: number;
  missingTables: string[];
  // Only columns of tables that exist; a missing table's columns are implied.
  missingColumns: TableColumn[];
  // Expected boolean but the DB has another type, or the reverse.
  booleanMismatches: (TableColumn & { expected: string; actual: string })[];
  extraTables: string[];
  extraColumns: TableColumn[];
};

const byName = (a: TableColumn, b: TableColumn) =>
  a.table.localeCompare(b.table) || a.column.localeCompare(b.column);

export function diffSchema(
  expected: SchemaMap,
  expectedBooleans: SchemaMap,
  actualRows: ActualColumn[],
): SchemaDiff {
  const actual = new Map<string, Map<string, string>>();
  for (const r of actualRows) {
    if (!actual.has(r.table)) actual.set(r.table, new Map());
    actual.get(r.table)!.set(r.column, r.dataType);
  }
  const isBool = (t: string, c: string) => expectedBooleans[t]?.includes(c) ?? false;

  const missingTables: string[] = [];
  const missingColumns: TableColumn[] = [];
  const booleanMismatches: SchemaDiff["booleanMismatches"] = [];
  for (const [table, cols] of Object.entries(expected)) {
    const have = actual.get(table);
    if (!have) {
      missingTables.push(table);
      continue;
    }
    for (const column of cols) {
      const type = have.get(column);
      if (type === undefined) missingColumns.push({ table, column });
      else if (isBool(table, column) !== (type === "boolean"))
        booleanMismatches.push({
          table,
          column,
          expected: isBool(table, column) ? "boolean" : "not boolean",
          actual: type,
        });
    }
  }

  const extraTables: string[] = [];
  const extraColumns: TableColumn[] = [];
  for (const [table, cols] of actual) {
    const want = expected[table];
    if (!want) {
      extraTables.push(table);
      continue;
    }
    for (const column of cols.keys()) if (!want.includes(column)) extraColumns.push({ table, column });
  }

  return {
    expectedTables: Object.keys(expected).length,
    expectedColumns: Object.values(expected).reduce((n, c) => n + c.length, 0),
    actualTables: actual.size,
    actualColumns: actualRows.length,
    missingTables: missingTables.sort(),
    missingColumns: missingColumns.sort(byName),
    booleanMismatches: booleanMismatches.sort(byName),
    extraTables: extraTables.sort(),
    extraColumns: extraColumns.sort(byName),
  };
}
