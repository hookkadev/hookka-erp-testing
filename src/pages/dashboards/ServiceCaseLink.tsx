import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { serviceCaseHref, serviceCasesHref } from "./service-case-link-lib";

// Links from the dashboard's Service tab into the real Service Cases module.
// `canOpen` comes from useServiceCaseLinks() (one permission read per panel, not
// one per row). Not allowed, or no id on the row -> the same text, not a link.

/** A case number that opens /service-cases/:id. */
export function ServiceCaseNo({
  id, caseNo, canOpen, className = "",
}: { id: string | null | undefined; caseNo: string | null | undefined; canOpen: boolean; className?: string }) {
  const label = caseNo ?? "—";
  const href = canOpen ? serviceCaseHref(id) : null;
  if (!href) return <span className={className}>{label}</span>;
  return (
    <Link
      to={href}
      title={`Open ${caseNo ?? "this case"} in Service Cases`}
      className={`${className} text-[#6B5C32] underline decoration-[#D9D2C7] underline-offset-2 hover:text-[#1F1D1B] hover:decoration-[#6B5C32] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]/40 rounded-sm max-md:inline-flex max-md:min-h-10 max-md:items-center`}
    >
      {label}
    </Link>
  );
}

/** Header shortcut to the Service Cases list page. */
export function OpenServiceCasesLink({ canOpen }: { canOpen: boolean }) {
  if (!canOpen) return null;
  return (
    <Link
      to={serviceCasesHref()}
      className="ml-auto inline-flex items-center gap-1 rounded-md border border-[#E5E0D8] bg-white px-2.5 py-1 text-xs font-medium text-[#6B5C32] hover:bg-[#F7F5F3] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]/40 max-md:min-h-10 max-md:px-3"
    >
      Open Service Cases
      <ArrowUpRight className="h-3.5 w-3.5" />
    </Link>
  );
}
