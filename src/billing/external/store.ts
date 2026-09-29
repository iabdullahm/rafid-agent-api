import type { ExternalPayment, ExternalPaymentInput, ExternalPaymentProvider, ExternalPaymentStatus, TopupIntent, TopupIntentInput, TopupIntentStatus } from "./types.js";

export class ExternalPaymentStoreError extends Error {
  constructor(public code: "topup_not_found" | "payment_not_found" | "duplicate_event" | "duplicate_transaction_hash" | "amount_collision" | "invalid_amount", message: string) { super(message); }
}

/**
 * Persistence seam for the external payment-collection layer. Two implementations, identical
 * semantics: PostgresExternalPaymentStore (production) and MemoryExternalPaymentStore
 * (development/tests) — same split as billing/unified/store.ts's BillingStore, for the same
 * reasons (see that file's doc comment).
 *
 * This store NEVER touches billing_accounts / billing_ledger — crediting an account always goes
 * through BillingEngine.fundExternalCredit() (see service.ts, the only caller of both this store
 * and that engine method), so the two ledgers (external payments, and the pre-existing unified
 * billing ledger) can never drift out of sync with each other's *intent*, even though they are
 * physically separate tables — reconciliation.ts is what proves they agree in practice.
 */
export interface ExternalPaymentStore {
  migrate(): Promise<void>;
  close(): Promise<void>;

  // ---- USDC top-up intents -----------------------------------------------------------------

  createTopupIntent(input: TopupIntentInput): Promise<TopupIntent>;
  getTopupIntent(id: string): Promise<TopupIntent | null>;
  /** True when some OTHER currently-"pending" intent for this recipient already claims this
   *  exact tagged amount — used by usdcTopup.ts's retry loop to pick a collision-free amount.
   *  Also enforced at the database level (rafid_topup_intents_open_amount_uniq) as a backstop. */
  isAmountOpen(recipient: string, amountUsdcAtomic: number): Promise<boolean>;
  /** Partial update — only the given fields change; `updatedAt` is always refreshed. Returns null
   *  if the intent doesn't exist. */
  updateTopupIntent(id: string, patch: Partial<Pick<TopupIntent, "status" | "transactionHash" | "externalPaymentId" | "metadata">>): Promise<TopupIntent | null>;
  /** Transitions every still-"pending" intent whose expiresAt has passed to "expired". Returns
   *  the count transitioned — called opportunistically (see service.ts) and available as an
   *  admin/cron maintenance action, exactly like BillingStore.releaseStale(). */
  expireStaleTopupIntents(now: Date): Promise<number>;
  listTopupIntents(opts: { accountId?: string; status?: TopupIntentStatus; limit?: number }): Promise<TopupIntent[]>;

  // ---- external payments --------------------------------------------------------------------

  createExternalPayment(input: ExternalPaymentInput): Promise<ExternalPayment>;
  getExternalPayment(id: string): Promise<ExternalPayment | null>;
  findExternalPaymentByProviderPaymentId(provider: ExternalPaymentProvider, providerPaymentId: string): Promise<ExternalPayment | null>;
  findExternalPaymentByEventId(provider: ExternalPaymentProvider, providerEventId: string): Promise<ExternalPayment | null>;
  findExternalPaymentByTransactionHash(provider: ExternalPaymentProvider, transactionHash: string): Promise<ExternalPayment | null>;
  updateExternalPayment(id: string, patch: Partial<Pick<ExternalPayment, "status" | "providerEventId" | "providerPaymentId" | "transactionHash" | "amountAtomic" | "confirmedAt" | "metadata">>): Promise<ExternalPayment | null>;
  /** Every row with createdAt >= since (or every row ever, when since is null), newest first —
   *  same "fetch the whole window, aggregate in plain JS" convention as RevenueLedger.query() /
   *  BillingStore.listSettledCharges(). Used by the dashboard's Collection & Funding section and
   *  by reconciliation.ts. */
  listExternalPayments(opts: { since: Date | null; accountId?: string; provider?: ExternalPaymentProvider; status?: ExternalPaymentStatus; limit?: number }): Promise<ExternalPayment[]>;
}
