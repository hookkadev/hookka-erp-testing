// T-004 follow-up — Export must dump the grid's currently FILTERED rows, not
// the whole unfiltered dataset. Import's currentRows stays on the FULL
// dataset (it needs to match/rename-detect against ANY existing record, not
// just what the grid's filter currently hides) — that's why the two were
// split into a standalone exportImportRows() instead of one overloaded prop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('exportImportRows is a standalone export, independent of BatchImportDialog', () => {
  const src = readFileSync('src/components/ui/batch-import-dialog.tsx', 'utf8');
  assert.match(src, /export async function exportImportRows\(/);
  assert.doesNotMatch(src, /handleExportCurrent/, 'the old dialog-internal export handler must be gone');
  assert.doesNotMatch(src, /Export Current Data/, 'the export button must no longer live inside the import dialog');
});

test('Products page Export button uses the filtered/sorted rows, not the raw list', () => {
  const src = readFileSync('src/pages/products/index.tsx', 'utf8');
  assert.match(src, /import \{ exportImportRows \} from "@\/components\/ui\/batch-import-dialog";/);
  assert.match(
    src,
    /exportImportRows\(\s*productImportColumns,\s*filtered\.map/,
    'export must read from the `filtered` memo (search/filter/sort applied), not `products`',
  );
  // Import-side matching must still see the FULL dataset — untouched.
  assert.match(src, /currentRows=\{products\.map\(\(p\) => \(\{/);
});

test('Inventory FG Export button uses filteredFG, RM Export button uses filteredRM', () => {
  const src = readFileSync('src/pages/inventory/index.tsx', 'utf8');
  assert.match(src, /import \{ exportImportRows \} from "@\/components\/ui\/batch-import-dialog";/);
  assert.match(
    src,
    /exportImportRows\(\s*fgImportColumns,\s*filteredFG\.map/,
    'FG export must read from filteredFG (category + search applied), not the raw products array',
  );
  assert.match(
    src,
    /exportImportRows\(\s*rmImportColumns,\s*filteredRM\.map/,
    'RM export must read from filteredRM, not the raw liveRawMaterials array',
  );
  // Import-side matching must still see the FULL dataset for both — untouched.
  assert.match(src, /currentRows=\{products\.map\(\(p\) => \(\{/);
  assert.match(src, /currentRows=\{liveRawMaterials\.map\(\(r\) => \(\{/);
});
