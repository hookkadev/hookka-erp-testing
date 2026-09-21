// ---------------------------------------------------------------------------
// ai-http.ts — the ONE place a non-streaming Anthropic call is made (T-010 R5).
//
// Before this, five call sites (two extractors, the boundary detector, two
// distillers) each hand-rolled fetch + status check + JSON parse. None retried,
// and the distillers had no timeout at all, so one 529 failed a scan and one
// upstream stall hung the weekly cron against its 280s limit.
//
// Retries: 408 / 429 / 5xx / 529 and network errors, exponential backoff with
// jitter, honouring Retry-After. A TIMEOUT is not retried here — the caller's
// budget is already spent, and the scan queue re-queues the row itself.
//
// The streaming assistant client (anthropic-client.ts) is deliberately separate:
// an SSE stream cannot be replayed once bytes have reached the browser.
// ---------------------------------------------------------------------------

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

/** 1-hour prompt cache. Longer-TTL breakpoints must precede shorter ones. */
export const CACHE_1H = { type: "ephemeral", ttl: "1h" } as const;

export type AiUsage = {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type AiResult =
  | { ok: true; text: string; usage: AiUsage; attempts: number; ms: number }
  | { ok: false; error: string; attempts: number; ms: number };

export type AiCallOpts = {
  timeoutMs?: number;
  /** Extra attempts after the first. */
  retries?: number;
  baseDelayMs?: number;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

type RawResponse = {
  content?: Array<{ type: string; text?: string }>;
  error?: { type?: string; message?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

export const isRetryableStatus = (s: number): boolean =>
  s === 408 || s === 429 || s >= 500;

export function backoffMs(attempt: number, base: number, retryAfter?: string | null): number {
  const hinted = Number(retryAfter);
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(hinted * 1000, 30_000);
  // full jitter on top of base * 2^attempt, capped so three tries fit a scan budget
  return Math.min(base * 2 ** attempt, 20_000) * (0.5 + Math.random() / 2);
}

export async function callAnthropic(
  apiKey: string,
  body: Record<string, unknown>,
  opts: AiCallOpts = {},
): Promise<AiResult> {
  const timeoutMs = opts.timeoutMs ?? 150_000;
  const retries = opts.retries ?? 2;
  const base = opts.baseDelayMs ?? 1_000;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = Date.now();
  let lastError = "no attempt made";

  for (let attempt = 0; attempt <= retries; attempt++) {
    const done = (r: { ok: false; error: string } | { ok: true; text: string; usage: AiUsage }): AiResult =>
      ({ ...r, attempts: attempt + 1, ms: Date.now() - started }) as AiResult;
    let retryAfter: string | null = null;
    try {
      const resp = await doFetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(body),
      });
      const bodyText = await resp.text();
      if (!resp.ok) {
        lastError = `Anthropic ${resp.status}: ${bodyText.slice(0, 500)}`;
        if (!isRetryableStatus(resp.status)) return done({ ok: false, error: lastError });
        retryAfter = resp.headers.get("retry-after");
      } else {
        let parsed: RawResponse;
        try {
          parsed = JSON.parse(bodyText) as RawResponse;
        } catch {
          return done({ ok: false, error: `Anthropic returned non-JSON: ${bodyText.slice(0, 300)}` });
        }
        if (parsed.error) {
          return done({ ok: false, error: `Anthropic: ${parsed.error.type}: ${parsed.error.message}` });
        }
        return done({
          ok: true,
          text: parsed.content?.find((b) => b.type === "text")?.text ?? "",
          usage: {
            tokensIn: parsed.usage?.input_tokens ?? 0,
            tokensOut: parsed.usage?.output_tokens ?? 0,
            cacheReadTokens: parsed.usage?.cache_read_input_tokens ?? 0,
            cacheWriteTokens: parsed.usage?.cache_creation_input_tokens ?? 0,
          },
        });
      }
    } catch (e) {
      const err = e as Error;
      lastError = `Network/fetch error: ${err.message}`;
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        return done({ ok: false, error: `${lastError} (timed out after ${timeoutMs}ms)` });
      }
    }
    if (attempt < retries) await sleep(backoffMs(attempt, base, retryAfter));
  }
  return { ok: false, error: lastError, attempts: retries + 1, ms: Date.now() - started };
}
