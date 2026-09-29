/**
 * Revenue Conversion Audit — shared types.
 *
 * "Explains, for every capability/tool call, why it did or did not convert into paid revenue."
 * This module (src/audit/) NEVER creates a new analytics database, a second revenue ledger, or
 * new payment semantics — every fact a CallAuditRecord carries is read from an already-shipped
 * system (analytics events, the x402/L402 revenue settlement ledger, the unified billing ledger,
 * the capability registry — see correlate.ts and build.ts for exactly which source backs each
 * field) and reassembled into one normalized, per-call record. See correlate.ts's doc comment for
 * the correlation strategy (requestId only, never timestamp/toolName/price/client proximity).
 */

/** Mirrors analytics/types.ts's AnalyticsChannel one-for-one, plus "unknown" for a call this audit
 *  could not attribute to any known channel — e.g. a pre-migration analytics row with no
 *  `requestId`/`channel` recorded (see analytics/types.ts's requestId field doc comment: both are
 *  optional for backward compatibility with rows written before this feature existed). Never a
 *  channel value beyond this closed list — an unrecognized string from an older row is normalized
 *  to "unknown", never passed through. */
export type AuditChannel =
  | "rest" | "x402" | "l402" | "mpp" | "mpp-session" | "mcp-remote" | "api_credits" | "subscription" | "free" | "unknown";

export const AUDIT_CHANNELS: readonly AuditChannel[] =
  ["rest", "x402", "l402", "mpp", "mpp-session", "mcp-remote", "api_credits", "subscription", "free", "unknown"];

/**
 * The reason-code taxonomy (spec's literal ~30-code list, verbatim). A CallAuditRecord's
 * `reasonCode` is ALWAYS one of these — never a free-form string — so the dashboard/CLI/internal
 * API can group and count calls by reason without parsing prose; `reasonDetail` (on
 * CallAuditRecord) carries the specific, human-readable explanation for that one call.
 *
 * "unknown" is a first-class, legitimate value, not a fallback to avoid: assign it whenever the
 * evidence this codebase can actually observe does not support a more specific code — most
 * notably the x402/L402 "was payment attempted" stage in some channels (see build.ts's
 * `derivePaymentAttempted()`). Never invent a more specific reason than the evidence supports —
 * this is the single rule every classification function in this module is written to obey.
 */
export type ReasonCode =
  | "tool_not_called"
  | "schema_validation_failed"
  | "authentication_failed"
  | "rate_limited"
  | "provider_not_configured"
  | "provider_timeout"
  | "provider_error"
  | "execution_failed"
  | "execution_succeeded_free_path"
  | "payment_not_required"
  | "x402_challenge_not_issued"
  | "payment_not_attempted"
  | "payment_attempt_failed"
  | "payment_verification_failed"
  | "payment_verified_not_settled"
  | "settlement_failed"
  | "settlement_succeeded"
  | "insufficient_prepaid_balance"
  | "prepaid_reservation_failed"
  | "prepaid_capture_failed"
  | "prepaid_capture_succeeded"
  | "subscription_charge_failed"
  | "subscription_charge_succeeded"
  | "revenue_record_missing"
  | "reconciliation_mismatch"
  | "unknown";

export const REASON_CODES: readonly ReasonCode[] = [
  "tool_not_called", "schema_validation_failed", "authentication_failed", "rate_limited",
  "provider_not_configured", "provider_timeout", "provider_error", "execution_failed",
  "execution_succeeded_free_path", "payment_not_required", "x402_challenge_not_issued",
  "payment_not_attempted", "payment_attempt_failed", "payment_verification_failed",
  "payment_verified_not_settled", "settlement_failed", "settlement_succeeded",
  "insufficient_prepaid_balance", "prepaid_reservation_failed", "prepaid_capture_failed",
  "prepaid_capture_succeeded", "subscription_charge_failed", "subscription_charge_succeeded",
  "revenue_record_missing", "reconciliation_mismatch", "unknown"
];

/** Final, normalized outcome of one call — spec section 8's literal list. Every CallAuditRecord
 *  has exactly one; see build.ts's `classifyFinalStatus()` for the decision tree. */
export type FinalStatus =
  | "converted" | "not_converted" | "free_success" | "failed_before_payment"
  | "payment_failed" | "settlement_failed" | "reconciliation_issue" | "unknown";

export const FINAL_STATUSES: readonly FinalStatus[] = [
  "converted", "not_converted", "free_success", "failed_before_payment",
  "payment_failed", "settlement_failed", "reconciliation_issue", "unknown"
];

export interface CallAuditExecution {
  attempted: boolean;
  /** null when execution was never attempted (e.g. a bare 402 challenge, an auth failure). */
  success: boolean | null;
  /** Best-effort, honestly-scoped failure detail (see build.ts's `deriveFailureReason()`) — never
   *  a raw upstream error message or stack trace. Null when execution succeeded or was never
   *  attempted. "unknown (no granular failure detail captured by current analytics schema)" is a
   *  real, expected value here, not a bug — see the final report's observability-gaps section. */
  failureReason: string | null;
}

export interface CallAuditPayment {
  /** null only when this call's channel makes "was payment required" itself not a well-formed
   *  question from the evidence available (see build.ts) — otherwise always a real true/false. */
  required: boolean | null;
  /** x402/L402 only — whether a 402 challenge was actually observed for this specific request.
   *  null for every other channel (challenge/no-challenge isn't this channel's vocabulary). */
  challengeIssued: boolean | null;
  /** Whether the caller took some payment action for this call — see build.ts's
   *  `derivePaymentAttempted()` for exactly which channels have a real, independently-observable
   *  signal for this (x402/L402: whether the request carried a payment header/token at all) versus
   *  which do not (see spec section 19) and so report null with an explanation in reasonDetail. */
  attempted: boolean | null;
  verified: boolean | null;
  settled: boolean | null;
}

export interface CallAuditRevenue {
  recorded: boolean;
  amount: number | null;
  currency: string | null;
  /** The rail the revenue was actually recorded against — normally identical to the record's own
   *  `channel`, but kept separate (rather than reusing `channel`) so a future reconciliation
   *  mismatch (revenue recorded on a different rail than the call itself reports) is representable
   *  without contradicting itself. */
  channel: AuditChannel | null;
}

/**
 * One normalized audit record per physical call (= one HTTP request, one `requestId` — see
 * correlate.ts's doc comment for why a request is the correct unit of "one call," including for
 * x402/L402, where an unpaid challenge and a later paid retry are two separate requests with two
 * separate requestIds, each fully self-contained and each getting its own record here).
 */
export interface CallAuditRecord {
  /** Null only for a correlation-orphan row from before requestId existed on analytics events
   *  (see analytics/types.ts) — every row recorded after this feature shipped always has one. */
  requestId: string | null;
  toolName: string | null;
  channel: AuditChannel;
  calledAt: string;
  /** Always true for a CallAuditRecord that exists at all — see build.ts's doc comment on why
   *  "the tool was never called" isn't representable as its own record (there is nothing to
   *  correlate it from); kept as an explicit field anyway because the schema in the spec names it
   *  and a false value one day (a purely synthetic "expected but missing" row from reconciliation)
   *  should have an obvious place to go without a schema change. */
  called: boolean;
  execution: CallAuditExecution;
  payment: CallAuditPayment;
  revenue: CallAuditRevenue;
  finalStatus: FinalStatus;
  reasonCode: ReasonCode;
  reasonDetail: string;
}
