/**
 * Every MPP-rail error Rafid itself raises (as opposed to the SDK's own RFC 9457 payment
 * problems, which are forwarded verbatim on 402 responses). Codes are stable, documented in
 * OpenAPI, and never carry a credential, signature, receipt or private key.
 */
export type MppErrorCode =
  | "MPP_DISABLED"
  | "MPP_MODE_DISABLED"
  | "MPP_UNSUPPORTED_TOOL"
  | "MPP_INVALID_REQUEST"
  | "MPP_PAYMENT_REQUIRED"
  | "MPP_INVALID_PAYMENT"
  | "MPP_PAYMENT_REPLAYED"
  | "MPP_SETTLEMENT_FAILED"
  | "MPP_SESSION_NOT_FOUND"
  | "MPP_SESSION_NOT_ACTIVE"
  | "MPP_SESSION_EXPIRED"
  | "MPP_SESSION_CLOSED"
  | "MPP_SESSION_EXHAUSTED"
  | "MPP_SESSION_FAILED"
  | "MPP_SESSION_BUDGET_EXCEEDED"
  | "MPP_SESSION_BUSY"
  | "MPP_TOOL_NOT_ALLOWED"
  | "MPP_IDEMPOTENCY_KEY_REQUIRED"
  | "MPP_IDEMPOTENCY_CONFLICT"
  | "MPP_IDEMPOTENCY_IN_PROGRESS"
  | "MPP_TERMS_MISMATCH"
  | "MPP_PROVIDER_UNAVAILABLE"
  | "MPP_STORAGE_UNAVAILABLE";

export class MppError extends Error {
  constructor(
    readonly status: number,
    readonly code: MppErrorCode,
    message: string,
    /** Extra, safe, top-level response fields (e.g. `required`/`remaining` for a budget error). */
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "MppError";
  }
}

export const mppErrors = {
  sessionNotFound: () => new MppError(404, "MPP_SESSION_NOT_FOUND", "No MPP session exists with this id."),
  toolNotFound: (tool: string) => new MppError(404, "MPP_UNSUPPORTED_TOOL", `Unknown or unpriced tool "${tool}". See GET /api/v1/capabilities.`),
  toolNotAllowed: (tool: string, allowed: readonly string[]) => new MppError(403, "MPP_TOOL_NOT_ALLOWED", `Tool "${tool}" is not in this session's allowedTools.`, { tool, allowedTools: [...allowed] }),
  budgetExceeded: (requiredMicros: number, remainingMicros: number) => new MppError(402, "MPP_SESSION_BUDGET_EXCEEDED", "This call's price exceeds the session's remaining budget; the tool was not executed.", {
    required: requiredMicros / 1_000_000, remaining: Math.max(0, remainingMicros) / 1_000_000, currency: "USD"
  }),
  idempotencyRequired: () => new MppError(400, "MPP_IDEMPOTENCY_KEY_REQUIRED", "Session calls require an Idempotency-Key header (1-255 visible ASCII characters) so a retried call is never charged twice."),
  idempotencyConflict: () => new MppError(422, "MPP_IDEMPOTENCY_CONFLICT", "This Idempotency-Key was already used in this session for a different tool or input."),
  idempotencyInProgress: () => new MppError(409, "MPP_IDEMPOTENCY_IN_PROGRESS", "A call with this Idempotency-Key is still executing; retry after it completes."),
  storageUnavailable: () => new MppError(503, "MPP_STORAGE_UNAVAILABLE", "MPP session storage is unavailable; nothing was charged — retry shortly."),
  providerUnavailable: () => new MppError(503, "MPP_PROVIDER_UNAVAILABLE", "The MPP payment provider is unavailable right now; nothing was charged — retry shortly.")
};
