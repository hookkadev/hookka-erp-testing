// ---------------------------------------------------------------------------
// use-resizable-tables.ts — finance tables (owner 2026-10-01, plan batch 4):
//   · no text wrapping in any finance table;
//   · drag a column's right edge in the header to set its width — ONLY that
//     column changes, everything to its right moves with it (the table is
//     exactly as wide as its columns, left-aligned, never stretched);
//   · widths remembered per table in this browser; double-click an edge to
//     go back to the automatic widths;
//   · reports (a table marked data-col-resize="first") resize the
//     description column only — the figures keep their width.
//
// One enhancer for every plain <table> under a root marked data-fin-tables,
// so the many hand-written finance tables need no edit each. The widths are
// pinned with a <colgroup> it adds (marked data-fin-cols) — the only way a
// header with spanning cells (a report's month over RM + %) keeps each real
// column's width — plus a handle <span> in each top header cell. React never
// touches either. Skipped: a table marked data-col-resize="off", a table that
// brings its own <colgroup> (DataGrid — it has its own resizing), a table
// without a <thead>.
// ---------------------------------------------------------------------------
import { useCallback, useRef } from "react";

const STORE = "fin-colw:";
const MIN_W = 36;

function topCells(t: HTMLTableElement): HTMLTableCellElement[] {
  const row = t.tHead?.rows[0];
  return row ? Array.from(row.cells) : [];
}

// How many real columns the table has (a spanning header cell counts each).
export function columnCount(spans: number[]): number {
  return spans.reduce((s, n) => s + (n > 0 ? n : 1), 0);
}

// The real column a top header cell's right edge belongs to.
export function edgeColumns(spans: number[]): number[] {
  let at = 0;
  return spans.map((n) => { at += n > 0 ? n : 1; return at - 1; });
}

// The columns' current widths, read off a row where every cell is one column
// (header rows bottom-up, then the first body rows). Null when there is none.
function measureColumns(t: HTMLTableElement, n: number): number[] | null {
  const rows = [...Array.from(t.tHead?.rows ?? []).reverse(), ...Array.from(t.tBodies[0]?.rows ?? []).slice(0, 8)];
  for (const r of rows) {
    const cells = Array.from(r.cells);
    if (cells.length !== n || cells.some((c) => c.colSpan !== 1)) continue;
    const widths = cells.map((c) => c.getBoundingClientRect().width);
    if (widths.every((w) => w > 0)) return widths;
  }
  return null;
}

function cellText(c: HTMLTableCellElement | undefined): string {
  return (c?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
}

// Where the widths are kept: the page/tab, the table's own key if it has one,
// and its header — a report by its description column only (its months move).
export function colWidthKey(scope: string, tableKey: string, headers: string[], firstOnly: boolean): string {
  return `${scope}|${tableKey}|${firstOnly ? `first|${headers[0] ?? ""}` : headers.join("|")}`;
}

function keyOf(scope: string, t: HTMLTableElement, firstOnly: boolean): string {
  return colWidthKey(scope, t.dataset.colKey ?? "", topCells(t).map(cellText), firstOnly);
}

function readWidths(key: string): number[] | null {
  try {
    const raw = localStorage.getItem(STORE + key);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === "number" && n > 0) ? (v as number[]) : null;
  } catch { return null; }
}
function writeWidths(key: string, widths: number[] | null) {
  try {
    if (widths) localStorage.setItem(STORE + key, JSON.stringify(widths.map((w) => Math.round(w))));
    else localStorage.removeItem(STORE + key);
  } catch { /* storage blocked: widths are just not remembered */ }
}

// Pin every column at a width; the table is their sum (so a narrower column
// pulls the rest left instead of stretching a neighbour).
export function sumWidths(widths: number[]): number {
  return Math.round(widths.reduce((s, w) => s + w, 0));
}
function freeze(t: HTMLTableElement, widths: number[]) {
  let cg = t.querySelector<HTMLTableColElement>(":scope > colgroup[data-fin-cols]");
  if (!cg) {
    cg = document.createElement("colgroup");
    cg.dataset.finCols = "1";
    t.insertBefore(cg, t.firstChild);
  }
  while (cg.children.length > widths.length) cg.lastElementChild!.remove();
  while (cg.children.length < widths.length) cg.appendChild(document.createElement("col"));
  widths.forEach((w, i) => { (cg!.children[i] as HTMLElement).style.width = `${Math.round(w)}px`; });
  t.style.tableLayout = "fixed";
  t.style.width = `${sumWidths(widths)}px`;
  t.style.minWidth = "0";
  t.style.maxWidth = "none";
  t.dataset.colw = "1";
}
function unfreeze(t: HTMLTableElement) {
  t.querySelector(":scope > colgroup[data-fin-cols]")?.remove();
  t.style.tableLayout = "";
  t.style.width = "";
  t.style.minWidth = "";
  t.style.maxWidth = "";
  delete t.dataset.colw;
}
function pinnedWidths(t: HTMLTableElement): number[] | null {
  const cg = t.querySelector(":scope > colgroup[data-fin-cols]");
  if (!cg) return null;
  return Array.from(cg.children).map((c) => parseFloat((c as HTMLElement).style.width) || 0);
}

function modeOf(t: HTMLTableElement): string {
  return t.dataset.colResize ?? t.closest<HTMLElement>("[data-col-resize]")?.dataset.colResize ?? "all";
}

function enhance(t: HTMLTableElement, scope: string) {
  const mode = modeOf(t);
  if (mode === "off" || t.querySelector(":scope > colgroup:not([data-fin-cols])")) return;
  const cells = topCells(t);
  if (!cells.length) return;
  const firstOnly = mode === "first";
  const n = columnCount(cells.map((c) => c.colSpan));
  const key = keyOf(scope, t, firstOnly);
  if (t.dataset.colSig !== key) {
    // A new table, or its header changed (columns came or went): start over.
    if (t.dataset.colSig) { unfreeze(t); delete t.dataset.colSig; }
    const saved = readWidths(key);
    const natural = saved && firstOnly ? measureColumns(t, n) : null;
    if (saved && !firstOnly && saved.length === n) {
      freeze(t, saved);
      t.dataset.colSig = key;
    } else if (saved && firstOnly && natural) {
      natural[0] = saved[0];
      freeze(t, natural);
      t.dataset.colSig = key;
    } else if (!saved || !firstOnly) {
      t.dataset.colSig = key;
    } // else: not laid out yet — the next pass restores it
  }
  const edges = edgeColumns(cells.map((c) => c.colSpan));
  cells.forEach((cell, i) => {
    if (firstOnly && i > 0) return;
    if (cell.querySelector(":scope > [data-fin-col-handle]")) return;
    if (getComputedStyle(cell).position === "static") cell.style.position = "relative";
    const h = document.createElement("span");
    h.dataset.finColHandle = "1";
    h.className = "fin-col-handle";
    h.title = "Drag to resize · double-click for the automatic width";
    h.addEventListener("pointerdown", (e) => startDrag(e, t, edges[i], scope, firstOnly));
    h.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      unfreeze(t);
      writeWidths(keyOf(scope, t, firstOnly), null);
    });
    // A click on the edge is not a click on the header (sorting, expanding).
    h.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
    cell.appendChild(h);
  });
}

function startDrag(e: PointerEvent, t: HTMLTableElement, col: number, scope: string, firstOnly: boolean) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const n = columnCount(topCells(t).map((c) => c.colSpan));
  const widths = pinnedWidths(t) ?? measureColumns(t, n);
  if (!widths || widths.length !== n) return;
  freeze(t, widths);
  const cg = t.querySelector<HTMLTableColElement>(":scope > colgroup[data-fin-cols]")!;
  const startX = e.clientX;
  const startW = widths[col];
  const handle = e.currentTarget as HTMLElement;
  handle.classList.add("active");
  const prevCursor = document.body.style.cursor;
  document.body.style.cursor = "col-resize";
  const move = (ev: PointerEvent) => {
    widths[col] = Math.max(MIN_W, startW + ev.clientX - startX);
    (cg.children[col] as HTMLElement).style.width = `${Math.round(widths[col])}px`;
    t.style.width = `${sumWidths(widths)}px`;
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    handle.classList.remove("active");
    document.body.style.cursor = prevCursor;
    writeWidths(keyOf(scope, t, firstOnly), firstOnly ? [widths[0]] : widths);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// No wrapping anywhere; a pinned column cuts long text with "…" (cells that
// hold a control or a nested table are left alone so nothing gets clipped).
export const FIN_TABLES_CSS = `
[data-fin-tables] table th, [data-fin-tables] table td { white-space: nowrap; }
[data-fin-tables] table[data-colw] > * > tr > th:not(:has(input, select, textarea)),
[data-fin-tables] table[data-colw] > * > tr > td:not(:has(input, select, textarea, button, table)) { overflow: hidden; text-overflow: ellipsis; }
.fin-col-handle { position: absolute; top: 0; right: 0; width: 6px; height: 100%; cursor: col-resize; z-index: 6; touch-action: none; }
.fin-col-handle:hover, .fin-col-handle.active { background: rgba(107, 92, 50, 0.35); }
`;
function ensureCss() {
  if (document.getElementById("fin-tables-css")) return;
  const s = document.createElement("style");
  s.id = "fin-tables-css";
  s.textContent = FIN_TABLES_CSS;
  document.head.appendChild(s);
}

/**
 * A callback ref for the page's root element (which also carries
 * data-fin-tables): every plain table under it gets the treatment, including
 * tables that appear later (data loaded, a tab switched, a popup opened).
 * A callback ref, not an effect, so a page that first renders a loading
 * screen still hooks its real root when that mounts.
 */
export function useResizableTables(scope: string): (el: HTMLElement | null) => void {
  const stop = useRef<(() => void) | null>(null);
  return useCallback((el: HTMLElement | null) => {
    stop.current?.();
    stop.current = el ? attachResizableTables(el, scope) : null;
  }, [scope]);
}

// The same, without React: watch `el` and enhance its tables; returns the stop.
export function attachResizableTables(el: HTMLElement, scope: string): () => void {
  ensureCss();
  let raf = 0;
  const pass = () => { raf = 0; el.querySelectorAll("table").forEach((t) => enhance(t, scope)); };
  pass();
  const mo = new MutationObserver(() => { if (!raf) raf = requestAnimationFrame(pass); });
  mo.observe(el, { childList: true, subtree: true });
  return () => { mo.disconnect(); if (raf) cancelAnimationFrame(raf); };
}
