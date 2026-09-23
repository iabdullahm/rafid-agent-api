/**
 * MPP billing domain types. Amounts are always integer micro-USD ("micros", 1 USD = 1_000_000)
 * inside this module: Rafid prices in USD, MPP settles in 6-decimal USD stablecoins (USDC on
 * Tempo/Base, pathUSD on the Tempo testnet), so one micro-USD is exactly one raw token unit and
 * no floating-point arithmetic ever touches a budget, a spend counter or a settlement amount.
 * Public responses convert back to plain USD numbers at the edge (microsToUsd).
 */

export const MICROS_PER_USD = 1_000_000;

/** USD → integer micros, rounding half up at the 6th decimal (catalog prices have ≤ 2). */
export function usdToMicros(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new RangeError("amount must be a non-negative finite number");
  return Math.round(usd * MICROS_PER_USD);
}

export function microsToUsd(micros: number | bigint): number {
  return Number(micros) / MICROS_PER_USD;
}

/** Decimal display string mppx expects for a route amount ("0.25", "20", "0.000001"). */
export function microsToDecimalString(micros: number | bigint): string {
  const m = BigInt(micros);
  const whole = m / 1_000_000n;
  const frac = (m % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export type MppSessionStatus = "pending" | "active" | "exhausted" | "closed" | "expired" | "failed";
export const MPP_SESSION_STATUSES: readonly MppSessionStatus[] = ["pending", "active", "exhausted", "closed", "expired", "failed"];

/**
 * Settlement lifecycle (separate from the session status):
 *  - not_started          nothing attempted yet (session open, or closed with nothing tried)
 *  - pending              an attempt is in flight (leased; a crashed attempt is retried by the
 *                         maintenance job once the lease expires) — outcome not yet known
 *  - pending_payer_close  metered spend exists but the only safe capture is the payer's close
 *                         credential (a server settle would capture unmetered voucher headroom)
 *  - settled              on-chain settlement confirmed (tx receipt, or on-chain state read back)
 *  - nothing_to_settle    no metered spend (or already fully settled on-chain)
 *  - failed               the last attempt failed definitively; retryable by maintenance/close
 */
export type MppSettlementStatus = "not_started" | "pending" | "pending_payer_close" | "settled" | "nothing_to_settle" | "failed";
export const MPP_SETTLEMENT_STATUSES: readonly MppSettlementStatus[] = ["not_started", "pending", "pending_payer_close", "settled", "nothing_to_settle", "failed"];

export interface MppSession {
  id: string;
  /** The MPP-native session identity: the TIP-1034 payment-channel id (bytes32 hex) once the
   *  channel is open; null while the session is still pending. */
  externalSessionId: string | null;
  status: MppSessionStatus;
  currency: "USD";
  /** Effective budget: min(requested budget, on-chain channel deposit). */
  maxBudgetMicros: number;
  requestedBudgetMicros: number;
  spentMicros: number;
  /** In-flight calls: budget held for calls that passed every pre-check and are executing. */
  reservedMicros: number;
  calls: number;
  allowedTools: string[];
  paymentProvider: string;
  paymentMethod: string;
  /** Channel-open transaction reference from the MPP receipt (public on-chain tx hash). */
  authorizationReference: string | null;
  /** sha256 of the canonical session terms, bound into the open challenge's HMAC'd meta. */
  termsDigest: string;
  settlementStatus: MppSettlementStatus;
  settlementReference: string | null;
  settledMicros: number;
  settlementAttempts: number;
  settlementAttemptedAt: string | null;
  /** Short, safe reason of the last failed settlement attempt (never a raw SDK message). */
  settlementError: string | null;
  /** HMAC of the creating client's IP (never the raw IP) — only used to cap unpaid pending
   *  sessions per client. Null once irrelevant or when unknown. */
  clientKey: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  closedAt: string | null;
  metadata: Record<string, unknown>;
}

export type MppUsageEventStatus = "reserved" | "charged" | "failed" | "released";

export interface MppUsageEvent {
  id: string;
  sessionId: string;
  toolName: string;
  /** Caller-supplied Idempotency-Key (or a server-generated one when idempotency isn't required). */
  requestId: string;
  /** sha256(tool + canonical input) — detects an Idempotency-Key reused for a different request. */
  requestHash: string;
  amountMicros: number;
  currency: "USD";
  status: MppUsageEventStatus;
  createdAt: string;
  updatedAt: string;
  /** Stored response for idempotent replay of a charged call (the tool output only — never a
   *  credential, receipt signature or any payment secret). */
  response: unknown;
  metadata: Record<string, unknown>;
}

export interface MppSessionTerms {
  maxBudgetMicros: number;
  currency: "USD";
  allowedTools: string[];
}

export interface UsageByTool { [tool: string]: { calls: number; spent: number } }
