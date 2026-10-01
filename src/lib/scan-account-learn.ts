// ---------------------------------------------------------------------------
// scan-account-learn.ts — finance scans (owner 2026-10-01, plan batch 3):
//   · which account a scanned bill line most likely goes to, learned from what
//     was saved before — 「下一次他选的 account … 根据 description」: the same
//     payee's most similar earlier line, else that payee's usual account, else
//     (a new payee) the most similar line of anyone, marked as a suggestion;
//   · whether the scanned bill number is already on our books;
//   · the bill's SST as its own line when the printed lines leave it out.
// Finance only and pure: the caller passes in finance documents it already
// holds (approved / posted vouchers, active other-creditor bills). No shared
// table, no model — it learns because every save adds to the history.
// ---------------------------------------------------------------------------

export type LearnedLine = { payee: string; description: string; accountCode: string; date: string };
export type AccountGuess = {
  accountCode: string;
  /** payee-description: same payee, similar line · payee-usual: that payee's most-used account · suggested: a new payee, someone else's similar line */
  source: "payee-description" | "payee-usual" | "suggested";
  basis: string;
} | null;

// Words that say nothing about WHAT was bought.
const STOP = new Set([
  "THE", "AND", "FOR", "WITH", "FROM", "SDN", "BHD", "INV", "INVOICE", "BILL", "RECEIPT", "CHARGE", "CHARGES",
  "FEE", "FEES", "PAYMENT", "TOTAL", "AMOUNT", "MYR", "QTY", "UNIT", "NOS", "PCS",
]);

export function normPayee(s: string | null | undefined): string {
  return String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function descTokens(s: string | null | undefined): Set<string> {
  return new Set(String(s ?? "").toUpperCase().split(/[^A-Z]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
}

// Each history line's words, and in how many lines each word appears — built
// once per history list.
type Index = { words: Set<string>[]; df: Map<string, number> };
const indexCache = new WeakMap<LearnedLine[], Index>();
function indexOf(history: LearnedLine[]): Index {
  let ix = indexCache.get(history);
  if (!ix) {
    const words = history.map((h) => descTokens(h.description));
    const df = new Map<string, number>();
    for (const ws of words) for (const w of ws) df.set(w, (df.get(w) ?? 0) + 1);
    ix = { words, df };
    indexCache.set(history, ix);
  }
  return ix;
}

// How much of the scanned line's wording an earlier line shares, each word
// weighted by how rare it is in the books (owner 2026-10-01, prod check: a
// transport bill matched a delivery line on the place name "KLANG" before a
// line about transport — a shared rare word says more than a common one).
// Only the words the candidate lines use at all count (a word they never use
// cannot match), so a payee's own lines are judged on that payee's wording.
// 0..1; a share of at least SIMILAR suggests — every guess is shown for
// review before anything is saved.
const SIMILAR = 0.3;

function mostSimilar(history: LearnedLine[], candidates: number[], tokens: Set<string>): { h: LearnedLine; score: number } | null {
  const { words, df } = indexOf(history);
  const n = history.length;
  const weight = (w: string) => Math.log(1 + n / (df.get(w) ?? 1));
  const present = new Set<string>();
  for (const i of candidates) for (const w of words[i]) if (tokens.has(w)) present.add(w);
  let whole = 0;
  for (const w of present) whole += weight(w);
  if (whole <= 0) return null;
  let best: { h: LearnedLine; score: number } | null = null;
  for (const i of candidates) {
    let shared = 0;
    for (const w of tokens) if (words[i].has(w)) shared += weight(w);
    if (shared <= 0) continue;
    const score = shared / whole;
    const h = history[i];
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && h.date > best.h.date)) best = { h, score };
  }
  return best && best.score >= SIMILAR ? best : null;
}

export function guessAccount(history: LearnedLine[], payee: string | null | undefined, description: string | null | undefined): AccountGuess {
  const p = normPayee(payee);
  const tokens = descTokens(description);
  const all = history.map((_, i) => i);
  const mineIx = p ? all.filter((i) => normPayee(history[i].payee) === p) : [];
  const mine = mineIx.map((i) => history[i]);
  const same = mostSimilar(history, mineIx, tokens);
  if (same) return { accountCode: same.h.accountCode, source: "payee-description", basis: same.h.description };
  if (mine.length) {
    const count = new Map<string, { n: number; last: string }>();
    for (const h of mine) {
      const c = count.get(h.accountCode) ?? { n: 0, last: "" };
      c.n += 1;
      if (h.date > c.last) c.last = h.date;
      count.set(h.accountCode, c);
    }
    const [code, c] = [...count.entries()].sort((a, b) => b[1].n - a[1].n || b[1].last.localeCompare(a[1].last))[0];
    return { accountCode: code, source: "payee-usual", basis: `${c.n} earlier line${c.n === 1 ? "" : "s"}` };
  }
  const other = mostSimilar(history, all, tokens);
  if (other) return { accountCode: other.h.accountCode, source: "suggested", basis: `${other.h.payee}: ${other.h.description}` };
  return null;
}

// ---- already on the books?
export type KnownDoc = { docNo: string; payee: string; ref: string };

export function normDocNo(s: string | null | undefined): string {
  return String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function findDuplicate(known: KnownDoc[], docNo: string | null | undefined, payee: string | null | undefined): KnownDoc | null {
  const n = normDocNo(docNo);
  if (n.length < 3) return null;
  const p = normPayee(payee);
  for (const k of known) {
    if (normDocNo(k.docNo) !== n) continue;
    const kp = normPayee(k.payee);
    if (!p || !kp || kp === p || kp.includes(p) || p.includes(kp)) return k;
  }
  return null;
}

// ---- the bill's SST as its own line
export function linesWithTax(
  lines: { description: string; amountSen: number }[],
  taxSen: number | null | undefined,
  totalSen: number | null | undefined,
): { description: string; amountSen: number; isTax?: boolean }[] {
  const tax = Math.round(Number(taxSen) || 0);
  if (tax <= 0 || lines.length === 0) return lines;
  const sum = lines.reduce((s, l) => s + l.amountSen, 0);
  // The printed lines already carry the tax — nothing to add.
  if (totalSen != null && Math.abs(sum - Math.round(Number(totalSen))) <= 1) return lines;
  return [...lines, { description: "SST", amountSen: tax, isTax: true }];
}
