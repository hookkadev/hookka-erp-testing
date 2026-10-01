// ---------------------------------------------------------------------------
// pv-transfer.ts — moving money between two of our own accounts, recorded as
// an ordinary payment voucher (owner 2026-10-01 「fund transfer 就做到像图 4
// 这样 … 就 create 普通 pv」): the voucher's one line is the bank / cash
// account that RECEIVES the money (DR), its Paid from is the account the money
// LEAVES (CR) — so the voucher's normal posting is the transfer itself.
//
// Pure, so the rule is testable without a database. The ordinary expense lines
// refuse a bank / cash account (validateDocLines); a transfer is the one kind
// whose line must be one.
// ---------------------------------------------------------------------------

export const PV_KIND_TRANSFER = "TRANSFER";

export type TransferCoaRow = { specialAccountType: string | null; isPostable: number | null };

export type PvTransfer = {
  payFrom: string;
  transferTo: string;
  amountSen: number;
  lines: { accountCode: string; description: string; amountSen: number }[];
};

const isMoneyAccount = (a: TransferCoaRow | undefined): boolean =>
  !!a && (a.specialAccountType === "SBK" || a.specialAccountType === "SCH") && (a.isPostable ?? 1) === 1;

export function validatePvTransfer(
  coa: ReadonlyMap<string, TransferCoaRow>,
  body: { transferTo?: unknown; payFrom?: unknown; amountSen?: unknown; description?: unknown; accrued?: unknown },
): { ok: true; v: PvTransfer } | { ok: false; error: string } {
  if (body.accrued === true || body.accrued === 1) return { ok: false, error: "A transfer cannot be accrued" };
  const payFrom = String(body.payFrom ?? "").trim();
  const transferTo = String(body.transferTo ?? "").trim();
  if (!isMoneyAccount(coa.get(payFrom))) {
    return { ok: false, error: "Paid from must be one of our bank (SBK) or cash (SCH) accounts" };
  }
  if (!isMoneyAccount(coa.get(transferTo))) {
    return { ok: false, error: "Transfer to must be one of our bank (SBK) or cash (SCH) accounts" };
  }
  if (transferTo === payFrom) return { ok: false, error: "Transfer to and Paid from must be different accounts" };
  const amountSen = Math.round(Number(body.amountSen) || 0);
  if (amountSen <= 0) return { ok: false, error: "The transfer needs a positive amount" };
  const description = String(body.description ?? "").trim() || `Transfer to ${transferTo}`;
  return { ok: true, v: { payFrom, transferTo, amountSen, lines: [{ accountCode: transferTo, description, amountSen }] } };
}
