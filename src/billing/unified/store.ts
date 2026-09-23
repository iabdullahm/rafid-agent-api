import type { AccountStatus, ApiKeyEnvironment, ApiKeyRecord, BillingAccount, LedgerEntry, ReleaseInput, ReserveInput, ReserveResult, SettleInput, Subscription, SubscriptionSnapshot, UsageSummaryRow } from "./types.js";

/**
 * Persistence seam for the unified billing ledger. Two implementations with identical semantics:
 * PostgresBillingStore (production — row locks + conditional updates inside one transaction per
 * operation) and MemoryBillingStore (development/tests — every mutating method runs its whole
 * check-and-mutate sequence synchronously, with no `await` in between, so JavaScript's
 * single-threaded event loop makes each call atomic).
 *
 * Every money-moving operation is a single atomic unit that both mutates the balance/allowance
 * AND writes the ledger row. There is deliberately no "getBalance then setBalance" API.
 */
export interface BillingStore {
  migrate(): Promise<void>;

  createAccount(input: { name: string; email?: string | null; metadata?: Record<string, unknown> }): Promise<BillingAccount>;
  getAccount(accountId: string): Promise<BillingAccount | null>;
  setAccountStatus(accountId: string, status: AccountStatus): Promise<BillingAccount>;

  insertApiKey(input: { id: string; accountId: string; keyPrefix: string; keyHash: string; environment: ApiKeyEnvironment; name: string; expiresAt: Date | null; metadata?: Record<string, unknown> }): Promise<ApiKeyRecord>;
  findApiKeyByHash(keyHash: string): Promise<{ key: ApiKeyRecord; account: BillingAccount } | null>;
  touchApiKey(keyId: string, at: Date): Promise<void>;
  revokeApiKey(accountId: string, keyId: string, at: Date): Promise<ApiKeyRecord>;
  listApiKeys(accountId: string): Promise<ApiKeyRecord[]>;

  /** Credit (top-up, amount > 0) or signed adjustment. Rejects a result below zero. When
   *  `externalTransactionId` is given, a repeat with the same id for the same account returns the
   *  original entry instead of crediting twice. */
  applyCredit(input: { accountId: string; amountMicros: number; type: "credit" | "adjustment"; reason: string; externalTransactionId?: string | null; now: Date }): Promise<{ entry: LedgerEntry; balanceMicros: number; duplicate: boolean }>;

  assignSubscription(input: { accountId: string; plan: string; includedMicros: number; now: Date }): Promise<Subscription>;
  cancelSubscription(accountId: string, now: Date): Promise<Subscription | null>;
  /** The active subscription with its CURRENT period's usage (periods roll forward on read). */
  getSubscription(accountId: string, now: Date): Promise<SubscriptionSnapshot | null>;

  reserve(input: ReserveInput): Promise<ReserveResult>;
  settle(input: SettleInput): Promise<void>;
  release(input: ReleaseInput): Promise<{ refundEntryId: string; balanceMicros: number } | null>;
  /** Releases every pending reservation older than `olderThan` (crash recovery). */
  releaseStale(olderThan: Date): Promise<number>;

  listLedger(accountId: string, options: { limit: number; before?: string }): Promise<LedgerEntry[]>;
  usageSummary(accountId: string, since: Date): Promise<UsageSummaryRow[]>;
  close(): Promise<void>;
}

export class BillingStoreError extends Error {
  constructor(public code: "account_not_found" | "account_inactive" | "key_not_found" | "negative_balance" | "invalid_amount" | "unknown_plan", message: string) { super(message); }
}
