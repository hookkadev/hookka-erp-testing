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

// Share of the smaller word set found in the other (1 = one contains the other).
function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.min(a.size, b.size);
}

// One meaningful word in common out of three is enough to suggest — every
// guess is shown for review before anything is saved.
const SIMILAR = 0.3;

function mostSimilar(history: LearnedLine[], tokens: Set<string>): { h: LearnedLine; score: number } | null {
  let best: { h: LearnedLine; score: number } | null = null;
  for (const h of history) {
    const score = overlap(tokens, descTokens(h.description));
    if (score <= 0) continue;
    if (!best || score > best.score || (score === best.score && h.date > best.h.date)) best = { h, score };
  }
  return best && best.score >= SIMILAR ? best : null;
}

export function guessAccount(history: LearnedLine[], payee: string | null | undefined, description: string | null | undefined): AccountGuess {
  const p = normPayee(payee);
  const tokens = descTokens(description);
  const mine = p ? history.filter((h) => normPayee(h.payee) === p) : [];
  const same = mostSimilar(mine, tokens);
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
  const other = mostSimilar(history, tokens);
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
