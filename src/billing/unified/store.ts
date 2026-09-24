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

  /** Credit (top-up, amount > 0), signed adjustment, or an externally-funded "credit_purchase"
   *  (also amount > 0 — see types.ts's LedgerType doc comment). Rejects a result below zero. When
   *  `externalTransactionId` is given, a repeat with the same id for the same account and type
   *  family returns the original entry instead of crediting twice — this is the ONLY dedup
   *  mechanism external payment crediting relies on (see src/billing/external/service.ts), so it
   *  is safe to call this from a replayed Stripe webhook or a re-submitted USDC confirmation. */
  applyCredit(input: { accountId: string; amountMicros: number; type: "credit" | "adjustment" | "credit_purchase"; reason: string; externalTransactionId?: string | null; now: Date }): Promise<{ entry: LedgerEntry; balanceMicros: number; duplicate: boolean }>;

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
  /** Every SETTLED charge (type "debit" or "subscription_usage" — i.e. money actually charged to
   *  an account for a tool call, never a top-up/refund/adjustment) across ALL accounts, with
   *  createdAt >= since (or every such row ever, when since is null), newest first — a read-only
   *  cross-account aggregate purpose-built for reporting (e.g. the internal ops dashboard's
   *  unified-billing revenue section), analogous to RevenueLedger.query() in
   *  src/revenue/types.ts. Never called from the reserve/settle/release path itself. */
  listSettledCharges(since: Date | null, limit?: number): Promise<LedgerEntry[]>;
  /** Every "credit_purchase" ledger row (externally-funded top-ups — see types.ts's LedgerType
   *  doc comment) across ALL accounts, with createdAt >= since (or every such row ever, when
   *  since is null), newest first — the funding-side counterpart to listSettledCharges(), used by
   *  src/billing/external/reconciliation.ts to cross-check every confirmed ExternalPayment has
   *  exactly one matching ledger row (matched by externalTransactionId) and vice versa. Never
   *  called from the reserve/settle/release or fundExternalCredit path itself. */
  listCreditPurchases(since: Date | null, limit?: number): Promise<LedgerEntry[]>;
  /** Sum of every currently-"pending" ledger entry's magnitude for one account (money reserved
   *  for an in-flight call, already subtracted from creditBalanceMicros but not yet settled or
   *  released) — always >= 0. Used only for reporting (GET /api/v1/billing/balance's reservedUSD
   *  — see src/billing/external/http.ts); never read by the reserve/settle/release path itself,
   *  which already knows the one entry it cares about by id. */
  pendingReservedMicros(accountId: string): Promise<number>;
  /** Sum of creditBalanceMicros across EVERY billing account (active, suspended and closed alike)
   *  — the true, current, point-in-time outstanding prepaid liability this deployment owes its
   *  customers (spec section 16's "Prepaid Outstanding Balance"). Deliberately NOT derived from
   *  "funding collected minus consumption" over some time window: an account's balance can also
   *  move via admin-granted credit/adjustment rows (billing/unified/engine.ts's addCredit/
   *  adjustCredit — never touched by the external payment-collection layer), so only a direct sum
   *  of the accounts' own running balance is honest — see billing/external/types.ts's accounting-
   *  model doc comment on why the balance is never re-derived from a ledger scan. Never windowed
   *  by a reporting period: a balance is a stock, not a flow. */
  totalOutstandingBalanceMicros(): Promise<number>;
  close(): Promise<void>;
}

export class BillingStoreError extends Error {
  constructor(public code: "account_not_found" | "account_inactive" | "key_not_found" | "negative_balance" | "invalid_amount" | "unknown_plan", message: string) { super(message); }
}
