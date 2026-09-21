// ---------------------------------------------------------------------------
// Mail Center — one recipient field (To / Cc / Bcc) as address chips.
//
// Shared by the New-email dialog and the reply box (PRD T-012 R2). Typing an
// address and pressing Enter / comma / Tab, or pasting "a@x, Bob <b@y>",
// turns it into chips; Backspace on an empty input removes the last one. An
// address that fails the shape check stays visible in red so the operator
// can fix it — Send is disabled while any chip is invalid.
//
// The parse rule is the API's own (parseAddressList / EMAIL_RE from
// api/lib/mail-threading.ts) so what the chips accept is exactly what the
// server accepts.
// ---------------------------------------------------------------------------
import { useState, type KeyboardEvent, type ClipboardEvent } from "react";
import { X, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { EMAIL_RE, parseAddressList } from "@/api/lib/mail-threading";

export type RecipientsInputProps = {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  // When given, a "pick from org chart" button opens the directory picker.
  onOpenPicker?: () => void;
  // Compact variant for the reply box (smaller chrome).
  dense?: boolean;
};

export function RecipientsInput({
  label,
  value,
  onChange,
  disabled = false,
  placeholder = "name@example.com",
  autoFocus = false,
  onOpenPicker,
  dense = false,
}: RecipientsInputProps) {
  const [text, setText] = useState("");

  // Turn whatever is typed into chips (deduped against the existing ones).
  function commit(raw: string) {
    const parsed = parseAddressList(raw);
    if (parsed.length === 0) return;
    const have = new Set(value.map((a) => a.toLowerCase()));
    const add = parsed.filter((a) => !have.has(a));
    if (add.length > 0) onChange([...value, ...add]);
    setText("");
  }

  function remove(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "," || e.key === ";" || e.key === "Tab") {
      if (text.trim()) {
        e.preventDefault();
        commit(text);
      }
      return;
    }
    if (e.key === "Backspace" && !text && value.length > 0) {
      e.preventDefault();
      remove(value.length - 1);
    }
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData("text");
    if (/[,;\n<>]/.test(pasted)) {
      e.preventDefault();
      commit(pasted);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label
          className={cn(
            "font-medium text-[#6B7280]",
            dense ? "text-xs" : "text-xs",
          )}
        >
          {label}
        </label>
        {onOpenPicker && (
          <button
            type="button"
            onClick={onOpenPicker}
            disabled={disabled}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[#6B5C32] transition hover:bg-[#F0ECE9] disabled:opacity-50"
            title="Pick people from the org chart"
          >
            <Users className="h-3 w-3" />
            Org chart
          </button>
        )}
      </div>
      <div
        className={cn(
          "flex flex-wrap items-center gap-1 rounded-md border border-[#E2DDD8] bg-white px-2 text-sm focus-within:border-[#6B5C32] focus-within:ring-2 focus-within:ring-[#6B5C32]/20",
          dense ? "min-h-8 py-0.5" : "min-h-9 py-1",
          disabled && "cursor-not-allowed opacity-60",
        )}
        onClick={(e) => {
          // Clicking the padding focuses the input, like a real mail client.
          const input = (e.currentTarget as HTMLElement).querySelector("input");
          input?.focus();
        }}
      >
        {value.map((addr, i) => {
          const bad = !EMAIL_RE.test(addr);
          return (
            <span
              key={`${addr}-${i}`}
              className={cn(
                "inline-flex max-w-full items-center gap-1 rounded-md border py-0.5 pl-2 pr-1 text-xs",
                bad
                  ? "border-red-300 bg-red-50 text-red-700"
                  : "border-[#E2DDD8] bg-[#FAF9F7] text-[#1F1D1B]",
              )}
              title={bad ? "Not a valid email address" : addr}
            >
              <span className="truncate">{addr}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(i);
                }}
                disabled={disabled}
                aria-label={`Remove ${addr}`}
                className="shrink-0 rounded p-0.5 text-[#6B7280] transition hover:bg-[#F0ECE9] hover:text-[#1F1D1B] disabled:opacity-50"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          );
        })}
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => {
            if (text.trim()) commit(text);
          }}
          disabled={disabled}
          autoFocus={autoFocus}
          placeholder={value.length === 0 ? placeholder : ""}
          aria-label={label}
          className="min-w-[8rem] flex-1 border-0 bg-transparent px-1 py-0.5 text-sm text-[#1F1D1B] placeholder:text-[#9CA3AF] focus:outline-none disabled:cursor-not-allowed"
        />
      </div>
    </div>
  );
}
