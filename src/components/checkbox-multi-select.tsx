// ---------------------------------------------------------------------------
// Checkbox dropdown for filter bars: tick any number of options, empty = all.
//
// Same open/close + click-outside pattern as DepartmentMultiSelect. That one
// stays separate because its onChange also hands back a "primary" department.
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from "react";

export type CheckboxOption = { value: string; label: string };

export function CheckboxMultiSelect({
  options,
  selected,
  onChange,
  allLabel,
  noun,
  title,
  className,
}: {
  options: CheckboxOption[];
  selected: string[];
  onChange: (values: string[]) => void;
  /** Shown when nothing is ticked, e.g. "All categories". */
  allLabel: string;
  /** Plural noun for the count, e.g. "categories" gives "2 categories selected". */
  noun: string;
  title?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Long lists (customers) get a search box; "Select all" then means "all matching".
  const searchable = options.length > 8;
  const q = query.trim().toLowerCase();
  const visible = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  const allVisibleSelected = visible.every((o) => selected.includes(o.value));

  const summary =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? selected[0])
        : `${selected.length} ${noun} selected`;

  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="true"
        aria-expanded={open}
        title={title}
        className={`text-xs px-2 py-1.5 border border-[#E6E0D9] rounded bg-white text-left flex items-center justify-between gap-2 focus:outline-none focus:border-[#6B5C32] ${
          className ?? "min-w-[150px]"
        }`}
      >
        <span className="truncate">{summary}</span>
        <svg className="h-3 w-3 text-[#6B7280] shrink-0" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          className="absolute z-50 top-full left-0 mt-1 min-w-full w-max max-w-[320px] bg-white border border-[#E6E0D9] rounded shadow-lg py-1"
        >
          {searchable && (
            <div className="px-2 pb-1">
              <input
                type="text"
                autoFocus
                placeholder="Search…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full text-xs px-2 py-1 border border-[#E6E0D9] rounded focus:outline-none focus:border-[#6B5C32]"
              />
            </div>
          )}
          <div className="flex justify-between gap-3 px-3 py-1.5 border-b border-[#E6E0D9] text-xs">
            <button
              type="button"
              className="text-[#6B5C32] hover:underline disabled:text-[#9CA3AF] disabled:no-underline"
              disabled={allVisibleSelected}
              onClick={() => onChange([...new Set([...selected, ...visible.map((o) => o.value)])])}
            >
              Select all
            </button>
            <button
              type="button"
              className="text-[#6B5C32] hover:underline disabled:text-[#9CA3AF] disabled:no-underline"
              disabled={selected.length === 0}
              onClick={() => onChange([])}
            >
              Clear all
            </button>
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
          {visible.length === 0 && <div className="px-3 py-1.5 text-xs text-[#9CA3AF]">No matches</div>}
          {visible.map((o) => {
            const checked = selected.includes(o.value);
            return (
              <label
                key={o.value}
                className={`flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-[#FAF9F7] ${
                  checked ? "bg-[#FAF7EE]" : ""
                }`}
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[#6B5C32]"
                  checked={checked}
                  onChange={() => toggle(o.value)}
                />
                <span className="text-[#374151]">{o.label}</span>
              </label>
            );
          })}
          </div>
        </div>
      )}
    </div>
  );
}

export default CheckboxMultiSelect;
