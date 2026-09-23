// ---------------------------------------------------------------------------
// idempotency-key.ts — the CLIENT half of the server's idempotency wrapper.
//
// T-006 R10 wrapped six create/convert routes (DO, GRN, PI, CN convert, both
// returns) in `withIdempotency`, but that wrapper is opt-in: with no
// `Idempotency-Key` header it runs the handler as normal, so the protection
// was inert — no screen sent one. This is the missing half.
//
// The rule that makes a key useful, and that is easy to get backwards:
//
//   * The SAME key must be reused while one attempt is unresolved, so that a
//     retry after a lost response is recognised as that same attempt and
//     replays its result instead of creating a second document. fetchJson
//     aborts at 15s and reports status 0 — a request that timed out may well
//     have committed on the server.
//   * A NEW key must be used once any response has arrived, success or error.
//     The server caches 4xx responses deliberately (a validation error stays a
//     validation error on retry), so a key held across a fixed-and-resubmitted
//     form would replay the old rejection and the form could never be saved.
//
// `withKey` is therefore the whole API: it holds the key across a no-response
// failure and drops it the moment the server answers.
//
// What this does NOT cover: a double-click that fires the handler twice. Each
// click would be a separate, answered attempt. Every call site here already
// disables its submit button while the request is in flight — that is what
// stops the double-click, and it must stay.
//
// Known edge: if a request times out and the operator then edits the payload
// and submits again, the retained key replays the FIRST attempt's response.
// That is the correct idempotent answer (the first attempt probably
// committed), but the operator sees the original document rather than their
// edit. Reloading the page clears the key.
// ---------------------------------------------------------------------------
import { useRef } from "react";
import { FetchJsonError } from "./fetch-json";

/**
 * Exported for tests — this pair IS the rule, and getting it backwards is
 * how a key silently stops protecting anything.
 *
 * True when the failure carries a server response. A FetchJsonError with
 * status 0 means the request never got an answer (network drop, timeout,
 * abort) — the one case where the key must survive. A raw `fetch()` only
 * rejects on network failure, so anything else thrown is also a no-answer.
 */
export function serverAnswered(e: unknown): boolean {
  return e instanceof FetchJsonError && e.status !== 0;
}

/**
 * Some helpers report a failure by RETURNING it rather than throwing — the
 * mobile `mutateJson` catches everything and hands back `{ ok: false,
 * status: 0 }` for a network drop. Status 0 means the same thing there as it
 * does on FetchJsonError: nothing came back, so the key must survive.
 */
export function resultAnswered(out: unknown): boolean {
  return !(
    typeof out === "object" &&
    out !== null &&
    (out as { status?: unknown }).status === 0
  );
}

/**
 * Several independent documents from one screen — the scan modal creates a
 * GRN or a purchase invoice per card, and they must not share a key or the
 * second card would replay the first card's document. `slot` separates them;
 * anything stable per document does (a card id, a row id).
 */
export function useIdempotencyKeys(): {
  withKey: <T>(slot: string, send: (key: string) => Promise<T>) => Promise<T>;
} {
  const ref = useRef<Map<string, string>>(new Map());

  async function withKey<T>(
    slot: string,
    send: (key: string) => Promise<T>,
  ): Promise<T> {
    const keys = ref.current;
    let key = keys.get(slot);
    if (!key) {
      key = crypto.randomUUID();
      keys.set(slot, key);
    }
    try {
      const out = await send(key);
      if (resultAnswered(out)) keys.delete(slot); // next submit is a new intent
      return out;
    } catch (e) {
      if (serverAnswered(e)) keys.delete(slot);
      throw e; // no answer → keep the key so a retry is the SAME attempt
    }
  }

  return { withKey };
}

/** One document per screen — the common case. */
export function useIdempotencyKey(): {
  withKey: <T>(send: (key: string) => Promise<T>) => Promise<T>;
} {
  const keyed = useIdempotencyKeys();
  return {
    withKey: (send) => keyed.withKey("default", send),
  };
}
