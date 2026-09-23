// Customer-receipt helpers shared by the Customer Payment page
// (src/pages/invoices/payments.tsx) and the Receipts hub
// (src/pages/accounting/index.tsx › ReceiptsHubTab). Pure: no React, no DOM.
import type { PaymentRecord } from "@/types";
import { formatCurrency, formatDateDMY } from "@/lib/utils";
import { COMPANY } from "@/lib/constants";
import { amountInWords } from "@/lib/amount-in-words";
import type { VoucherSpec, VoucherLine } from "@/lib/print-voucher";

// COMPANY.HOOKKA → the VoucherSpec.company shape (single source of truth);
// mirrors VOUCHER_COMPANY in supplier-payments.tsx / accounting/index.tsx.
const VOUCHER_COMPANY: VoucherSpec["company"] = {
  name: COMPANY.HOOKKA.name,
  addressLines: COMPANY.HOOKKA.addressLines,
  regNo: COMPANY.HOOKKA.regNo,
  tin: COMPANY.HOOKKA.tin,
  phone: COMPANY.HOOKKA.phone,
  email: COMPANY.HOOKKA.email,
};

// Money on the receipt that is not yet sitting against an invoice. The customer
// twin of hasUnappliedAdvance in supplier-payments.tsx: there, an advance is a
// payment LINE with no invoice; here a receipt is one row whose allocations may
// simply not add up to it, so the leftover is the difference. Both are integer
// sen (formatRM's input), so they subtract directly.
//
// Owner 2026-08-06: 「如果有还没 knock off clear 的我要像 supplier 这样整体字体
// 显示蓝色」— a receipt with money still on account is work outstanding, and he
// wants to spot it down the list without opening anything.
export function unallocatedSen(p: PaymentRecord): number {
  const allocated = (p.allocations ?? []).reduce((s, a) => s + (Number(a.amount) || 0), 0);
  return Math.max(0, (Number(p.amount) || 0) - allocated);
}

// Voided / deleted receipts are already dimmed and carry no obligation, so they
// never turn blue however little of them was allocated.
export function hasUnallocated(p: PaymentRecord): boolean {
  return (p.lifecycleState ?? "ACTIVE") === "ACTIVE" && unallocatedSen(p) > 0;
}

// One customer receipt → a PAYMENT RECEIPT voucher: one line per invoice the
// receipt cleared (Invoice No · amount), total = the receipt amount. Money
// stays integer sen, formatted with formatCurrency. The customer twin of
// buildSupplierPaymentVoucher in supplier-payments.tsx.
export function buildCustomerPaymentVoucher(p: PaymentRecord): VoucherSpec {
  const active = (p.lifecycleState ?? "ACTIVE") === "ACTIVE";
  // Date first on the printed receipt too — the customer matches it against
  // their own statement, which is ordered by date.
  const lines: VoucherLine[] = p.allocations.map((a) => ({
    cells: [a.invoiceDate ? formatDateDMY(a.invoiceDate) : "", a.invoiceNumber, formatCurrency(a.amount)],
  }));
  return {
    title: active ? "PAYMENT RECEIPT" : "PAYMENT RECEIPT — VOID",
    company: VOUCHER_COMPANY,
    docNo: p.receiptNumber,
    date: formatDateDMY(p.date),
    partyLabel: "Received From",
    partyName: p.customerName ?? "",
    columns: [{ label: "Date" }, { label: "Invoice" }, { label: "Amount", align: "right" }],
    lines,
    totalCells: ["", "Total", formatCurrency(p.amount)],
    amountWords: amountInWords(p.amount),
    // The customer receipt carries no bank/deposit account in PaymentRecord, so
    // there is no "Deposited to" footer; surface the payment reference instead.
    remarks: p.reference || undefined,
    signatures: [{ label: "Received by" }, { label: "Issued by" }],
    printedOn: formatDateDMY(new Date()),
  };
}
