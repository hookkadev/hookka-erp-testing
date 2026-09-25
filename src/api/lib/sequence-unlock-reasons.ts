// ---------------------------------------------------------------------------
// sequence-unlock-reasons — the vocabulary of "why was this lock released".
//
// Shared by the server (validation + the audit row's reason_code) and every
// client that offers the picker (desktop dialog, worker phone), so the weekly
// review reads one list and not three. The labels are what people see; the
// codes are what the report groups by — "earlier step was finished but not
// recorded" and "urgent, skipping" are different problems with different
// fixes, and free prose collapses them into noise (PRD T-013 R9, R11, R12).
//
// English only — the UI is 100% English (CLAUDE.md).
// ---------------------------------------------------------------------------

export const UNLOCK_REASON_OPTIONS = [
  { code: "RECORDING_GAP", label: "Earlier step was finished but not recorded" },
  { code: "NOT_APPLICABLE", label: "Earlier step does not apply to this order" },
  { code: "REAL_SKIP", label: "Urgent — will record the earlier step later" },
  { code: "OTHER", label: "Other" },
] as const;

export type UnlockReasonCode =
  | (typeof UNLOCK_REASON_OPTIONS)[number]["code"]
  /** An automated path released the lock (the Google Sheets sync); nobody chose. */
  | "SHEETS_SYNC";

/** The labels alone, in picker order. */
export const UNLOCK_REASONS = UNLOCK_REASON_OPTIONS.map((o) => o.label);

/** "Other" must carry text after it; the bare word explains nothing. */
export const OTHER_PREFIX = "Other — ";

export const UNLOCK_REASON_MIN = 3;
export const UNLOCK_REASON_MAX = 300;

/**
 * A recording gap means the factory was ahead of the record; a real skip means
 * the record was ahead of the factory. The report's whole question.
 */
export function isRecordingGap(code: UnlockReasonCode): boolean {
  return code === "RECORDING_GAP";
}

/** Map a stored reason back to its code. Unknown prose is OTHER. */
export function classifyUnlockReason(reason: string): UnlockReasonCode {
  const r = reason.trim();
  for (const o of UNLOCK_REASON_OPTIONS) {
    if (r === o.label) return o.code;
  }
  return "OTHER";
}

export type UnlockReasonCheck =
  | { ok: true; reason: string; code: UnlockReasonCode }
  | { ok: false; error: string };

/**
 * Server-side validation of what the client sent. Required, trimmed, bounded,
 * and never the bare "Other" — the review is only as good as its worst row.
 */
export function validateUnlockReason(raw: unknown): UnlockReasonCheck {
  if (typeof raw !== "string") {
    return { ok: false, error: "A reason is required to release the sequence lock." };
  }
  const reason = raw.replace(/\s+/g, " ").trim();
  if (reason.length < UNLOCK_REASON_MIN) {
    return { ok: false, error: "A reason is required to release the sequence lock." };
  }
  if (reason.length > UNLOCK_REASON_MAX) {
    return { ok: false, error: `Reason is too long (max ${UNLOCK_REASON_MAX} characters).` };
  }
  const code = classifyUnlockReason(reason);
  if (code === "OTHER") {
    const detail = reason.startsWith(OTHER_PREFIX)
      ? reason.slice(OTHER_PREFIX.length).trim()
      : reason.replace(/^other\b[\s:—-]*/i, "").trim();
    if (detail.length < UNLOCK_REASON_MIN) {
      return { ok: false, error: "Please say what the reason is." };
    }
  }
  return { ok: true, reason, code };
}
