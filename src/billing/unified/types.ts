/**
 * Shared types for the unified billing layer (src/billing/unified/).
 *
 * The capability itself never sees any of this: a capability is executed only after exactly one
 * billing rail has authorized the call, and it never learns which one.
 */

/** Every rail a paid call can be authorized by. `free` needs no account at all. */
export type BillingRail = "free" | "x402" | "api_credits" | "subscription" | "l402" | "mpp";

/** Values accepted in the `X-Rafid-Payment-Method` request header (default `auto`). */
export const PAYMENT_METHOD_HINTS = ["auto", "credits", "subscription", "x402", "l402", "mpp"] as const;
export type PaymentMethodHint = (typeof PAYMENT_METHOD_HINTS)[number];
export const PAYMENT_METHOD_HEADER = "x-rafid-payment-method";

/** Rails the unified ledger itself settles (the account-backed rails). x402/L402/MPP are
 *  verified and settled by their own existing, protocol-specific gates. */
export type AccountRail = "subscription" | "api_credits";

export interface BillingRequest {
  toolName: string;
  /** Canonical price in micro-USD — always derived from the capability registry's `price`. */
  priceMicros: number;
  apiKey?: string;
  method?: PaymentMethodHint;
  protocol?: "rest" | "mcp";
  requestId: string;
  idempotencyKey?: string;
  /** SHA-256 of the canonicalized input; used to detect idempotency-key reuse with different input. */
  requestHash?: string;
}

export interface BillingAuthorization {
  authorized: true;
  rail: BillingRail;
  accountId?: string;
  apiKeyId?: string;
  priceMicros: number;
  chargedMicros: number;
  balanceBeforeMicros?: number;
  balanceAfterMicros?: number;
  /** Ledger entry id of the pending charge (txn_…); settled or refunded after execution. */
  transactionId?: string;
  subscription?: SubscriptionSnapshot;
}

export type AccountStatus = "active" | "suspended" | "closed";
export type ApiKeyEnvironment = "live" | "test";
export type ApiKeyStatus = "active" | "revoked";
export type LedgerType = "credit" | "debit" | "refund" | "adjustment" | "subscription_usage";
export type LedgerStatus = "pending" | "settled" | "refunded" | "failed";
export type LedgerRail = "api_credits" | "subscription" | "admin";

export interface BillingAccount {
  id: string;
  name: string;
  email: string | null;
  status: AccountStatus;
  currency: "USD";
  creditBalanceMicros: number;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface ApiKeyRecord {
  id: string;
  accountId: string;
  keyPrefix: string;
  keyHash: string;
  environment: ApiKeyEnvironment;
  name: string;
  status: ApiKeyStatus;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  metadata: Record<string, unknown>;
}

export interface LedgerEntry {
  id: string;
  accountId: string;
  apiKeyId: string | null;
  requestId: string | null;
  toolName: string | null;
  type: LedgerType;
  /** Signed effect on the customer: + adds credit/allowance back, − consumes it. */
  amountMicros: number;
  currency: "USD";
  rail: LedgerRail;
  status: LedgerStatus;
  externalTransactionId: string | null;
  relatedEntryId: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export type SubscriptionStatus = "active" | "canceled";

export interface Subscription {
  id: string;
  accountId: string;
  plan: string;
  status: SubscriptionStatus;
  includedMicros: number;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  canceledAt: string | null;
}

export interface SubscriptionSnapshot {
  subscriptionId: string;
  plan: string;
  periodStart: string;
  periodEnd: string;
  includedMicros: number;
  usedMicros: number;
}

export interface ReserveInput {
  accountId: string;
  apiKeyId: string;
  requestId: string;
  toolName: string;
  priceMicros: number;
  /** Ordered rails to try, first success wins (see selection.ts). */
  rails: AccountRail[];
  /** When the account HAS an active subscription whose allowance can't cover the call: may the
   *  next rail (prepaid credits) be tried? false for an explicit `subscription` hint. */
  subscriptionFallback: boolean;
  idempotency?: { key: string; requestHash: string };
  now: Date;
}

export type ReserveResult =
  | { kind: "reserved"; rail: AccountRail; entryId: string; chargedMicros: number; balanceBeforeMicros: number; balanceAfterMicros: number; subscription?: SubscriptionSnapshot }
  | { kind: "replay"; responseStatus: number; responseBody: unknown; entryId: string | null }
  | { kind: "idempotency_conflict" }
  | { kind: "idempotency_in_progress" }
  | { kind: "insufficient"; balanceMicros: number; subscription: SubscriptionSnapshot | null };

export interface SettleInput {
  entryId: string;
  idempotency?: { accountId: string; toolName: string; key: string; responseStatus: number; responseBody: unknown };
}

export interface ReleaseInput {
  entryId: string;
  reason: string;
  idempotency?: { accountId: string; toolName: string; key: string };
}

export interface UsageSummaryRow { toolName: string; calls: number; chargedMicros: number; rail: LedgerRail }
