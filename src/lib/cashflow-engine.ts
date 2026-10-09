// Cash Flow engine — pure functions. Turns fetched ledger data into a
// cash-basis Statement of Cash Flow. No DB, no I/O. Unit-tested in
// tests/cashflow-engine.test.mjs.

export type CfSection =
  | "REVENUE_COLLECTION"
  | "RAW_MATERIALS"
  // Owner 2026-09-28/29, final ruling 「raw material 加, drawdown 减, 一加一减 …
  // 放在 after operation surplus」: a supplier paid from the trade-finance
  // facility is grossed up — the purchase splits by material under Raw
  // Materials (spend, in the month of the draw) and the facility side sits in
  // this block BELOW the operating result, outflow-signed: a drawdown reads
  // negative (the lender lent), interest charged negative, a repayment
  // positive (real cash out). The block nets to the change in what is owed;
  // the bank surplus stays bank-true because the two sides of a draw cancel.
  | "TRADE_FINANCE"
  | "DIRECT_LABOUR"
  | "FACTORY_OVERHEAD"
  | "GENERAL_EXPENSE"
  | "TAXATION"
  | "FINANCE_COST"
  | "CAPEX"
  | "DEPOSIT"
  | "LOAN"
  | "UNALLOCATED";

export type CoaLite = {
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE" | "COST";
  sat: string | null;
  // COA tree parent (AutoCount-style). Drives the statement's parent-child
  // nesting (owner 2026-09-04 「可以自动分一下父子account吗？」).
  parentCode?: string | null;
};

// Sections whose amounts would be shown with the sign flipped (money out
// positive). NONE any more — owner 2026-09-29 「这个 cash flow 我想要更改，全部
// 进钱 positive，出钱 negative」: every line reads the bank's way, amount =
// money in, (amount) = money out, in every block. (History: until then the
// cost blocks and everything below the operating result showed money out
// positive, which made the same bracket mean opposite things across blocks.)
// Kept as an (empty) set so the one sign rule stays in one place.
export const OUTFLOW_SECTIONS: ReadonlySet<CfSection> = new Set<CfSection>([]);

// Operating sections feed "Net operation surplus / (deficit)".
export const OPERATING_SECTIONS: ReadonlySet<CfSection> = new Set<CfSection>([
  "REVENUE_COLLECTION", "RAW_MATERIALS", "DIRECT_LABOUR", "FACTORY_OVERHEAD",
  "GENERAL_EXPENSE", "TAXATION",
]);

// Display order of sections in the statement. Trade Finance is the first
// block after the operating result (owner 2026-09-29).
export const SECTION_ORDER: CfSection[] = [
  "REVENUE_COLLECTION", "RAW_MATERIALS", "DIRECT_LABOUR", "FACTORY_OVERHEAD",
  "GENERAL_EXPENSE", "TAXATION", "TRADE_FINANCE", "FINANCE_COST", "CAPEX", "DEPOSIT", "LOAN",
  "UNALLOCATED",
];

export const SECTION_LABELS: Record<CfSection, string> = {
  REVENUE_COLLECTION: "REVENUE COLLECTION",
  RAW_MATERIALS: "Raw Materials",
  TRADE_FINANCE: "Trade Finance",
  DIRECT_LABOUR: "Direct Labour",
  FACTORY_OVERHEAD: "Factory Overhead",
  GENERAL_EXPENSE: "General Expense",
  TAXATION: "Taxation",
  FINANCE_COST: "Finance Cost",
  CAPEX: "Capital Expenditure (CAPEX)",
  DEPOSIT: "Deposit refunded / (paid)",
  LOAN: "Loan received / (repaid · lent)",
  UNALLOCATED: "Unallocated",
};

export function displaySign(section: CfSection): 1 | -1 {
  return OUTFLOW_SECTIONS.has(section) ? -1 : 1;
}

const band = (code: string): number => parseInt(code.split("-")[0] ?? "0", 10) || 0;

// Best-effort default placement of a contra account into a cash-flow section.
// The owner can override any account via the Maintenance mapping editor.
export function defaultSectionFor(a: CoaLite): CfSection {
  const b = band(a.code);
  // Debtor control / sales collection.
  if (a.sat === "SDC" || b === 300 || b === 305) return "REVENUE_COLLECTION";
  // GST / SST payable settlements shown under collection as (-) GST Payables.
  if (b === 350) return "REVENUE_COLLECTION";
  // AP control / supplier payments → raw materials (split by PI downstream).
  if (a.sat === "SCC" || b === 400 || b === 405) return "RAW_MATERIALS";
  // Direct labour.
  if (b === 750) return "DIRECT_LABOUR";
  // Material purchase accounts (701-x PURCHASE - FABRIC …) belong with the
  // raw-material money, not overhead — cash paid straight against one shows
  // under Raw Materials as its own named row.
  if (b >= 700 && b <= 705 && /^PURCHASE\b/i.test(a.name)) return "RAW_MATERIALS";
  // Factory overhead (700-range manufacturing + 780 overhead).
  if (b === 780 || (b >= 700 && b <= 705)) return "FACTORY_OVERHEAD";
  // Fixed assets → capex.
  if (b >= 200 && b <= 299) return "CAPEX";
  // Director / related-party advances & borrowings, HP / related-party loans
  // (440-x: e.g. 440-0030 LOAN FROM RELATED PARTY - HOUZS VENTURE;
  // 480-x: HIRE PURCHASE CREDITOR + its interest suspense).
  if ((b >= 440 && b <= 459) || b === 480) return "LOAN";
  // Generic expense.
  if (a.type === "EXPENSE" || b === 900) return "GENERAL_EXPENSE";
  return "UNALLOCATED";
}

export const RM_LINES = [
  "Purchase of Fabric",
  "Purchase of Wooden",
  "Purchase of Filler",
  "Purchase of Other & Packaging",
] as const;
export type RmLine = (typeof RM_LINES)[number];

// Default stock-group → raw-material line. Override map (cashflow_stockgroup_map)
// takes precedence; unmapped groups fall to "Other & Packaging".
export function rawMaterialLineFor(
  group: string,
  override: Record<string, string>,
): string {
  if (override[group]) return override[group];
  const g = group.toUpperCase();
  if (g.includes("FABR")) return "Purchase of Fabric";
  if (g.includes("PLYWOOD") || g.includes("WD") || g.includes("WOOD"))
    return "Purchase of Wooden";
  if (g.includes("FILLER")) return "Purchase of Filler";
  return "Purchase of Other & Packaging";
}

// Display order inside the Raw Materials block: stock-group rows first, then
// the named non-material settlements (owner 2026-08-27 「必须要知道还什么」),
// "Unallocated raw material" always last.
export function rmLineOrder(line: string): number {
  if (line === "Unallocated raw material") return 99;
  // Per-supplier unresolved rows (owner 2026-08-31 「这个我也有要分」) sit
  // just above the absolute-residual line.
  if (line.startsWith("Unallocated — ")) return 15;
  if (line === "Supplier advance / deposit") return 14;
  // "Opening creditors settlement" and the per-supplier "Opening creditors —
  // X" rows (owner 2026-08-31 「我想要分」) share the same slot.
  if (line.startsWith("Opening creditors")) return 13;
  if (line === "Trade finance repayment" || line.endsWith("(other creditor)") || line.startsWith("Suppliers settled via ")) return 12;
  if (line === "SST / TAX") return 11;
  return 10;
}

// Sections a supplier can be filed under INSTEAD of a raw-material category
// (owner 2026-09-29 「我无法选其他的 categories, 类似 capex 等等」): the
// supplier's uncoded / opening-creditor money (the "Unallocated — X" and
// "Opening creditors — X" rows, i.e. payments with no material line behind
// them) moves there whole, as a row named after the supplier. A payment that
// settled a PI with real material lines still splits by material.
export const SUPPLIER_SECTION_TARGETS: readonly CfSection[] = ["CAPEX", "FACTORY_OVERHEAD", "GENERAL_EXPENSE", "DIRECT_LABOUR"];
export function supplierSectionFor(
  line: string,
  supplierCategory: Record<string, string>,
): { section: CfSection; supplier: string } | null {
  const m = /^(?:Opening creditors|Unallocated) — (.+)$/.exec(line);
  if (!m) return null;
  const cat = supplierCategory[m[1]];
  return cat && (SUPPLIER_SECTION_TARGETS as readonly string[]).includes(cat)
    ? { section: cat as CfSection, supplier: m[1] }
    : null;
}

// Default sections for the payroll accruals, found from the chart — the
// parent of the salary accrual (410-0000 ACCRUALS on this chart), never a
// hard-coded code. The salary accrual and that parent carry the production
// wages → Direct Labour (the caller splits them by department). Every other
// accrual under the same parent — EPF / SOCSO / EIS — is the ordinary staff's
// statutory contribution → General Expense (owner 2026-09-29 「这个是普通
// staff，不是 direct 的」; the P&L books that EPF as STAFFS' EPF, not
// PRODUCTION - EPF). No parent → no defaults. The owner's own drags win (the
// caller only fills accounts he has not mapped).
export function payrollAccrualSections(
  coa: ReadonlyMap<string, CoaLite>,
  salaryAccrualCode: string,
): Map<string, CfSection> {
  const out = new Map<string, CfSection>();
  const parent = coa.get(salaryAccrualCode)?.parentCode ?? null;
  if (!parent) return out;
  for (const a of coa.values()) {
    if (a.code === parent || a.code === salaryAccrualCode) out.set(a.code, "DIRECT_LABOUR");
    else if (a.parentCode === parent) out.set(a.code, "GENERAL_EXPENSE");
  }
  return out;
}

// The payroll month a salary voucher's description names — whose payslip
// department mix splits the cash. Owner 2026-09-29 「月份一起修」: the old
// pattern only knew "May'26", so "PAYMENT FOR SALARIES - MAY'26" and
// "… - JULY'26" fell back to the PAYMENT month's mix. Now any case, short or
// full names ("Sept" too), and a month with no year ("LATE SALARY JUNE") is
// the latest such month not after the payment month. Nothing named → fallback.
const MONTH_WORD = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b(?:\s*'\s*(\d{2})\b)?/gi;
const MONTH_NO: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
export function payrollMonthFrom(description: string | null | undefined, fallbackYm: string): string {
  const text = description ?? "";
  let noYear: number | null = null;
  for (const m of text.matchAll(MONTH_WORD)) {
    const mon = MONTH_NO[m[1].slice(0, 3).toLowerCase()];
    if (!mon) continue;
    if (m[2]) return `20${m[2]}-${String(mon).padStart(2, "0")}`;
    noYear ??= mon;
  }
  if (noYear !== null) {
    const fm = /^(\d{4})-(\d{2})$/.exec(fallbackYm);
    if (fm) {
      const y = Number(fm[1]), pm = Number(fm[2]);
      return `${noYear <= pm ? y : y - 1}-${String(noYear).padStart(2, "0")}`;
    }
  }
  return fallbackYm;
}

// Raw-material stock accounts (special type SBS: "STOCK - FABRIC M",
// "STOCK - WOODEN", "STOCK - B.FILLER" …) default to Raw Materials. A payment
// booked straight to one is buying material (owner 2026-09-30: the
// pre-opening fabric repaid to Houzs, 「不要动到 P&L」 — so the bill stays on
// the stock account and only the cash flow files it). Work-in-progress and
// finished-goods stock are not raw material. The owner's drags still win.
export function rawStockAccountSections(coa: ReadonlyMap<string, CoaLite>): Map<string, CfSection> {
  const out = new Map<string, CfSection>();
  for (const a of coa.values()) {
    if (a.sat !== "SBS") continue;
    if (/WORK[\s-]*IN[\s-]*PROGRESS|FINISHED\s+GOODS|\bWIP\b/i.test(a.name)) continue;
    out.set(a.code, "RAW_MATERIALS");
  }
  return out;
}

// Distribute an integer total (sen) across weighted buckets so the parts sum
// EXACTLY to total (largest-remainder method). Used to split one supplier
// payment across the material lines of the PI it settled.
export function splitByLargestRemainder(
  totalSen: number,
  buckets: { key: string; weight: number }[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of buckets) out[b.key] = (out[b.key] ?? 0) + 0;
  const wsum = buckets.reduce((s, b) => s + Math.max(0, b.weight), 0);
  if (buckets.length === 0) return out;
  if (wsum <= 0) {
    out[buckets[0].key] = (out[buckets[0].key] ?? 0) + totalSen;
    return out;
  }
  const exact = buckets.map((b) => ({
    key: b.key,
    raw: (totalSen * Math.max(0, b.weight)) / wsum,
  }));
  let assigned = 0;
  const floored = exact.map((e) => {
    const f = Math.floor(e.raw);
    assigned += f;
    return { key: e.key, floor: f, rem: e.raw - f };
  });
  let leftover = totalSen - assigned;
  floored.sort((a, b) => b.rem - a.rem);
  for (let i = 0; i < floored.length && leftover > 0; i++, leftover--)
    floored[i].floor += 1;
  for (const f of floored) out[f.key] = (out[f.key] ?? 0) + f.floor;
  return out;
}

export type ClassifiedLeg = {
  accountCode: string; // resolved canonical contra account
  debitSen: number;
  creditSen: number;
  ym: string; // YYYY-MM (opening-adjusted by caller)
  sourceType: string;
  sourceId: string;
  // Row label instead of the account's name (the trade-finance rows: one per
  // supplier "(via TF)", "Repaid to <lender>"); the account still decides the
  // section and the group the row nests under.
  lineLabel?: string;
};

// Inside the Trade Finance block: the drawdowns (negative — the lender lent)
// first, the lender's interest next, the repayments (positive — cash out) last.
export function tfLineOrder(label: string): number {
  return label.startsWith("Repaid to ") ? 20 : label.startsWith("Interest charged by ") ? 15 : 10;
}
export type BankLeg = {
  accountCode: string;
  debitSen: number;
  creditSen: number;
  ym: string;
};
// Per-PI raw-material weights (line label → weight in sen of the PI's lines).
export type RmSplit = Record<string, { line: string; weight: number }[]>;

export type CfMapEntry = { section: CfSection; order: number };
export type CfMap = Record<string, CfMapEntry>;

export type CfColumn = { key: string; label: string; accum?: boolean };
export type CfRow = {
  kind: "section" | "group" | "line" | "subtotal" | "result" | "total" | "bf" | "cf" | "gap";
  label: string;
  section?: CfSection;
  depth: number;
  groupId?: string;
  values: (number | null)[];
  accountCode?: string;
  // A line's own key ("<SECTION>|<label>") — what the inline drill asks for.
  lineKey?: string;
};
// Where a line's money came from (the inline drill, owner 2026-09-29 「cash
// flow 也要这样点开看」): one entry per ledger leg that fed the line — its
// entry, month and the cash it put on THIS line (+ in, − out). `of` is the
// leg's whole cash when the line only got a share of it (a payment split
// across the materials of the PIs it settled, a salary split by department).
export type CfSource = { sourceType: string; sourceId: string; ym: string; sen: number; legAccount: string; of?: number };
export type CfStatement = { columns: CfColumn[]; rows: CfRow[]; sources?: Record<string, CfSource[]> };

// Months of the current FY from period back to FY start (inclusive),
// newest first, e.g. fye=8, period=2026-03 → [2026-03,...,2025-09,2025-08].
export function fyMonths(period: string, fyeMonth: number): string[] {
  // BUG-2026-08-13-092. `period` MUST be `YYYY-MM`. Anything else (the
  // Cash Flow tab used to offer "2026-Q1" and "2026") made `pm` NaN, so every
  // column key became "2026-NaN": no leg matched a column, `inFy` was false for
  // every real month, and the statement rendered all-zero income and expense
  // lines — while `balBefore` string-compared "2026-05" < "2026-NaN" as TRUE
  // and printed a large, real bank balance beside them. Refuse loudly instead:
  // a 500 the caller can see beats a plausible statement that is not one.
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    throw new Error(`fyMonths: period must be YYYY-MM, got "${period}"`);
  }
  const [py, pm] = period.split("-").map((n) => parseInt(n, 10));
  const startMonth = (fyeMonth % 12) + 1; // month after FYE
  const out: string[] = [];
  let y = py, m = pm;
  for (let i = 0; i < 13; i++) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (m === startMonth) break;
    m -= 1; if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}

const monthLabel = (ym: string): string => {
  const [y, m] = ym.split("-");
  const names = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[parseInt(m, 10)]}'${y.slice(2)}`;
};

const cashDelta = (l: { debitSen: number; creditSen: number }): number =>
  l.creditSen - l.debitSen; // + = cash into the bank account

export function buildStatement(opts: {
  classified: ClassifiedLeg[];
  bankLegs: BankLeg[];
  coa: Map<string, CoaLite>;
  map: CfMap;
  rmSplit: RmSplit;
  // Salary settlements by department (owner 2026-08-27 「salary 那边也是要拆散
  // 成department」): same shape as rmSplit, applied to DIRECT_LABOUR legs.
  deptSplit?: RmSplit;
  stockGroupOverride: Record<string, string>;
  // Supplier → template category ("Purchase of Fabric" …) for nesting the
  // per-supplier Opening/Unallocated rows (owner 2026-09-05 「做」). Caller
  // merges the auto-guess with the kv override before passing it in.
  supplierCategory?: Record<string, string>;
  fyeMonth: number;
  period: string;
  editable?: boolean;
  // Record every line's sources (CfSource) for the inline drill.
  trace?: boolean;
}): CfStatement {
  const { classified, bankLegs, coa, map, rmSplit, deptSplit = {}, stockGroupOverride, supplierCategory = {}, fyeMonth, period, editable, trace } = opts;
  const months = fyMonths(period, fyeMonth);        // newest first
  const fyStart = months[months.length - 1];        // FY start ym
  const columns: CfColumn[] = [
    { key: "__accum__", label: `Accumulated`, accum: true },
    ...months.map((m) => ({ key: m, label: monthLabel(m) })),
  ];
  const colIndex = new Map(columns.map((c, i) => [c.key, i] as const));
  const inFy = (ym: string) => ym >= fyStart && ym <= period;

  type Agg = { section: CfSection; label: string; order: number; vals: number[]; accountCode?: string };
  const lines = new Map<string, Agg>();
  const ensure = (section: CfSection, label: string, order: number, accountCode?: string): Agg => {
    const k = `${section}|${label}`;
    let a = lines.get(k);
    if (!a) { a = { section, label, order, vals: columns.map(() => 0), accountCode }; lines.set(k, a); }
    return a;
  };
  const sources: Record<string, CfSource[]> = {};
  type Src = { sourceType: string; sourceId: string; legAccount: string; of?: number };
  const addToLine = (section: CfSection, label: string, order: number, ym: string, deltaSen: number, accountCode?: string, src?: Src) => {
    const a = ensure(section, label, order, accountCode);
    if (inFy(ym)) { a.vals[colIndex.get("__accum__")!] += deltaSen; }
    const ci = colIndex.get(ym);
    if (ci !== undefined) a.vals[ci] += deltaSen;
    if (trace && src) (sources[`${section}|${label}`] ??= []).push({ ...src, ym, sen: deltaSen });
  };

  const placement = (code: string, fallback: CoaLite | undefined): { section: CfSection; order: number; name: string } => {
    const m = map[code];
    if (m) return { section: m.section, order: m.order, name: fallback?.name ?? code };
    const sec = fallback ? defaultSectionFor(fallback) : "UNALLOCATED";
    return { section: sec, order: 9999, name: fallback?.name ?? code };
  };

  for (const leg of classified) {
    const a = coa.get(leg.accountCode);
    const place = placement(leg.accountCode, a);
    const delta = cashDelta(leg); // signed; + = cash in
    const src: Src = { sourceType: leg.sourceType, sourceId: leg.sourceId, legAccount: leg.accountCode };
    const share: Src = { ...src, of: delta };
    if (place.section === "RAW_MATERIALS") {
      // A split registered for this leg's exact account wins over the
      // payment-wide one (an other-party payment can put SOME of its money on
      // the creditor control and the rest on purchase accounts).
      const split = rmSplit[`${leg.sourceId}@${leg.accountCode}`] ?? rmSplit[leg.sourceId];
      if (split && split.length) {
        const parts = splitByLargestRemainder(
          Math.abs(delta),
          split.map((s) => ({ key: s.line, weight: s.weight })),
        );
        const sign = delta < 0 ? -1 : 1;
        for (const [line, sen] of Object.entries(parts)) {
          // A supplier the owner filed under a section (Capex, overhead …)
          // takes its uncoded / opening money there, as a row of its own.
          const via = supplierSectionFor(line, supplierCategory);
          if (via) addToLine(via.section, via.supplier, 50, leg.ym, sign * sen, undefined, share);
          else addToLine("RAW_MATERIALS", line, rmLineOrder(line), leg.ym, sign * sen, undefined, share);
        }
      } else if (a && !(a.sat === "SCC" || band(leg.accountCode) === 400 || band(leg.accountCode) === 405)) {
        // A non-control account routed here (a PURCHASE - … account, or one
        // the owner dragged in) keeps its own name as the line.
        addToLine("RAW_MATERIALS", place.name, rmLineOrder(place.name), leg.ym, delta, leg.accountCode, src);
      } else {
        addToLine("RAW_MATERIALS", "Unallocated raw material", 99, leg.ym, delta, undefined, src);
      }
    } else if (place.section === "DIRECT_LABOUR" && deptSplit[leg.sourceId]?.length) {
      // Salary settlement split across departments (weights = that payroll
      // month's payslip cost mix). Falls through to the account line when the
      // caller had no payslip data for the month.
      const split = deptSplit[leg.sourceId];
      const parts = splitByLargestRemainder(
        Math.abs(delta),
        split.map((s) => ({ key: s.line, weight: s.weight })),
      );
      const sign = delta < 0 ? -1 : 1;
      for (const [line, sen] of Object.entries(parts))
        addToLine("DIRECT_LABOUR", line, 10, leg.ym, sign * sen, undefined, share);
    } else if (place.section === "TRADE_FINANCE") {
      const label = leg.lineLabel ?? place.name;
      addToLine("TRADE_FINANCE", label, tfLineOrder(label), leg.ym, delta, leg.accountCode, src);
    } else {
      addToLine(place.section, leg.lineLabel ?? place.name, place.order, leg.ym, delta, leg.accountCode, src);
    }
  }

  const surplusByCol = columns.map(() => 0); // = bank movement (authoritative)
  for (const bl of bankLegs) {
    const d = bl.debitSen - bl.creditSen; // + = balance up
    if (inFy(bl.ym)) surplusByCol[colIndex.get("__accum__")!] += d;
    const ci = colIndex.get(bl.ym);
    if (ci !== undefined) surplusByCol[ci] += d;
  }
  const balBefore = (ym: string): number => {
    let s = 0;
    for (const bl of bankLegs) if (bl.ym < ym) s += bl.debitSen - bl.creditSen;
    return s;
  };
  const bfVals = columns.map((col) =>
    col.accum ? balBefore(fyStart) : balBefore(col.key),
  );
  const cfVals = columns.map((col, i) => bfVals[i] + surplusByCol[i]);

  const rows: CfRow[] = [];
  const push = (r: CfRow) => rows.push(r);
  const sectionLines = (sec: CfSection): Agg[] =>
    [...lines.values()].filter((a) => a.section === sec)
      .sort((x, y) => x.order - y.order || x.label.localeCompare(y.label));
  const sumCols = (aggs: Agg[]): number[] =>
    columns.map((_, i) => aggs.reduce((s, a) => s + a.vals[i], 0));

  // Owner 2026-09-04 「可以自动分一下父子account吗？」— lines nest under their
  // COA parent (AutoCount-style tree, one level). Raw-material stock-group
  // rows join the purchase parent their category maps to, so the block reads
  // like the owner's Excel template (Purchase - Fabric / Wooden / Filler / …).
  // A parent row is kind "group" with groupId "<SECTION>><parentCode>" — the
  // ">" makes the hierarchy visible to the UI's collapse logic.
  const RM_LINE_PARENT: Record<string, string> = {
    "Purchase of Fabric": "701-0000",
    "Purchase of Wooden": "702-0000",
    "Purchase of Filler": "703-0000",
    "Purchase of Other & Packaging": "704-0000",
  };
  const emitSection = (sec: CfSection, asGroup: boolean) => {
    const aggs = sectionLines(sec);
    if (aggs.length === 0 && sec !== "REVENUE_COLLECTION" && !editable) return;
    const sign = displaySign(sec);
    const sub = sumCols(aggs);
    const baseDepth = asGroup ? 2 : 1;
    type Cluster = { code: string; label: string; members: Agg[] };
    const clusters = new Map<string, Cluster>();
    const flat: Agg[] = [];
    for (const a of aggs) {
      let pCode: string | undefined;
      if (sec === "TRADE_FINANCE" && a.accountCode && coa.has(a.accountCode)) {
        // The facility account itself is the group ("TRADE FINANCE - HOUZS
        // CENTURY SDN BHD"), its supplier / repayment rows sit under it.
        pCode = a.accountCode;
      } else if (sec === "RAW_MATERIALS" && a.accountCode && coa.get(a.accountCode)?.sat === "SBS") {
        // A raw-material stock account files under the purchase parent its
        // name belongs to ("STOCK - FABRIC M" → PURCHASE - FABRIC), not under
        // the balance-sheet STOCK parent.
        const p = RM_LINE_PARENT[rawMaterialLineFor(a.label, stockGroupOverride)];
        if (p && coa.has(p)) pCode = p;
      } else if (a.accountCode) {
        const p = coa.get(a.accountCode)?.parentCode ?? undefined;
        if (p && p !== a.accountCode && coa.has(p)) pCode = p;
      } else if (sec === "RAW_MATERIALS") {
        if (rmLineOrder(a.label) === 10) {
          const p = RM_LINE_PARENT[rawMaterialLineFor(a.label, stockGroupOverride)];
          if (p && coa.has(p)) pCode = p;
        } else {
          // Per-supplier Opening/Unallocated rows file under the category
          // assigned to that SUPPLIER — the row keeps its label, it just
          // sits under the right purchase parent. No category → stays flat.
          const m = /^(?:Opening creditors|Unallocated) — (.+)$/.exec(a.label);
          const cat = m ? supplierCategory[m[1]] : undefined;
          const p = cat ? RM_LINE_PARENT[cat] : undefined;
          if (p && coa.has(p)) pCode = p;
        }
      }
      if (pCode) {
        const cl = clusters.get(pCode) ?? { code: pCode, label: coa.get(pCode)?.name ?? pCode, members: [] };
        cl.members.push(a);
        clusters.set(pCode, cl);
      } else flat.push(a);
    }
    // A lone child under a COA parent stays flat (the nest would add a row
    // saying nothing); Raw-Material template categories keep single members.
    for (const [k, cl] of [...clusters]) {
      if (cl.members.length < 2 && sec !== "RAW_MATERIALS" && sec !== "TRADE_FINANCE") { flat.push(...cl.members); clusters.delete(k); }
    }
    flat.sort((x, y) => x.order - y.order || x.label.localeCompare(y.label));
    const line = (a: Agg, depth: number, gid?: string) =>
      push({ kind: "line", label: a.label, section: sec, depth, groupId: gid, values: a.vals.map((v) => sign * v), accountCode: a.accountCode, lineKey: `${sec}|${a.label}` });
    const body = () => {
      for (const cl of [...clusters.values()].sort((x, y) => x.code.localeCompare(y.code))) {
        const gid = `${sec}>${cl.code}`;
        push({ kind: "group", label: cl.label, section: sec, depth: baseDepth, groupId: gid, accountCode: cl.code, values: sumCols(cl.members).map((v) => sign * v) });
        for (const a of cl.members.sort((x, y) => x.order - y.order || x.label.localeCompare(y.label)))
          line(a, baseDepth + 1, gid);
      }
      for (const a of flat) line(a, baseDepth, asGroup ? sec : undefined);
    };
    if (asGroup) {
      push({ kind: "group", label: SECTION_LABELS[sec], section: sec, depth: 1,
        groupId: sec, values: sub.map((v) => sign * v) });
      body();
    } else {
      push({ kind: "section", label: SECTION_LABELS[sec], section: sec, depth: 0, values: columns.map(() => null) });
      body();
      push({ kind: "subtotal", label: SECTION_LABELS[sec], section: sec, depth: 1, values: sub.map((v) => sign * v) });
    }
  };

  emitSection("REVENUE_COLLECTION", false);
  push({ kind: "gap", label: "", depth: 0, values: columns.map(() => null) });
  push({ kind: "section", label: "COST / EXPENSE OUT", depth: 0, values: columns.map(() => null) });
  for (const sec of ["RAW_MATERIALS", "DIRECT_LABOUR", "FACTORY_OVERHEAD", "GENERAL_EXPENSE", "TAXATION"] as CfSection[])
    emitSection(sec, true);

  const opAggs = [...lines.values()].filter((a) => OPERATING_SECTIONS.has(a.section));
  push({ kind: "gap", label: "", depth: 0, values: columns.map(() => null) });
  push({ kind: "result", label: "Net operation surplus / (deficit)", depth: 0, values: sumCols(opAggs) });

  push({ kind: "gap", label: "", depth: 0, values: columns.map(() => null) });
  for (const sec of ["TRADE_FINANCE", "FINANCE_COST", "CAPEX", "DEPOSIT", "LOAN", "UNALLOCATED"] as CfSection[])
    emitSection(sec, true);

  push({ kind: "gap", label: "", depth: 0, values: columns.map(() => null) });
  push({ kind: "total", label: "Cash Surplus / (Deficit)", depth: 0, values: surplusByCol.slice() });
  push({ kind: "bf", label: "Bank balance b/f", depth: 0, values: bfVals });
  push({ kind: "cf", label: "Bank balance c/f", depth: 0, values: cfVals });

  return trace ? { columns, rows, sources } : { columns, rows };
}
