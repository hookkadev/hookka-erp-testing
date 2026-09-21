// ---------------------------------------------------------------------------
// Mail Center — "Request acknowledgement" control (PRD T-012 R8).
//
// One checkbox + a due-time picker, shared by the New-email dialog and the
// reply box. Only STAFF recipients (an @hookka.com mailbox) can acknowledge;
// the API rejects the send when none is on the mail, so the hint says so.
// ---------------------------------------------------------------------------
import { CheckCheck } from "lucide-react";

const DUE_OPTIONS: Array<{ hours: number; label: string }> = [
  { hours: 24, label: "within 1 day" },
  { hours: 48, label: "within 2 days" },
  { hours: 72, label: "within 3 days" },
  { hours: 24 * 7, label: "within 1 week" },
];

export function AckRequestRow({
  checked,
  hours,
  disabled,
  onChange,
  onHours,
}: {
  checked: boolean;
  hours: number;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  onHours: (hours: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label className="inline-flex cursor-pointer items-center gap-1.5 text-[#1F1D1B]">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="h-3.5 w-3.5 accent-[#6B5C32]"
        />
        <CheckCheck className="h-3.5 w-3.5 text-[#6B5C32]" />
        Request acknowledgement
      </label>
      {checked && (
        <select
          value={hours}
          disabled={disabled}
          onChange={(e) => onHours(Number(e.target.value))}
          className="h-7 rounded-md border border-[#E2DDD8] bg-white px-2 text-xs text-[#1F1D1B] focus:border-[#6B5C32] focus:outline-none disabled:opacity-60"
          aria-label="Acknowledge by"
        >
          {DUE_OPTIONS.map((o) => (
            <option key={o.hours} value={o.hours}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      {checked && (
        <span className="text-[11px] text-[#6B7280]">
          Staff recipients confirm from the thread; overdue ones are reminded by email.
        </span>
      )}
    </div>
  );
}
