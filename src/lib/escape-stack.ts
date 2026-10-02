// ---------------------------------------------------------------------------
// escape-stack.ts — Esc closes the popup on TOP (owner 2026-10-02 「点开后无法
// 用 esc 关闭，create new pv 时也是这样」).
//
// One window keydown listener for every popup that opts in: an open popup
// pushes its close, a closed one pops it, and Esc runs only the newest — a
// confirm over a form answers the confirm, the next Esc reaches the form. A
// key an inner control already used (a dropdown closing itself calls
// preventDefault) or one typed mid-IME composition is left alone.
// ---------------------------------------------------------------------------
import { useEffect, useRef } from "react";

const stack: { run: () => void }[] = [];

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.preventDefault();
  top.run();
}

/** Put a close handler on top of the stack; the returned function takes it off. */
export function pushEscape(run: () => void): () => void {
  if (stack.length === 0) window.addEventListener("keydown", onKeyDown);
  const entry = { run };
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    if (stack.length === 0) window.removeEventListener("keydown", onKeyDown);
  };
}

/** Esc runs `onClose` while `active` and this popup is the newest one open. */
export function useEscapeClose(onClose: () => void, active = true): void {
  const latest = useRef(onClose);
  useEffect(() => {
    latest.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!active) return;
    return pushEscape(() => latest.current());
  }, [active]);
}
