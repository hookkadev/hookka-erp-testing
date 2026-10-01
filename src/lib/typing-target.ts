/**
 * True when the element is somewhere the user is typing text. A page-wide
 * key listener must stand down for these, or it reads the same keystroke a
 * second time (BUG-2026-10-01: the worker PIN keypad took every digit typed
 * into the Employee No. box).
 */
export function isTypingTarget(
  el: { tagName?: string; isContentEditable?: boolean } | null | undefined,
): boolean {
  if (!el) return false;
  const tag = (el.tagName || "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}
