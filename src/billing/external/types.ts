/**
 * Shared types for the external payment-collection layer (src/billing/external/) — Stripe
 * Checkout and USDC-on-Base top-ups. This layer's ONLY job is to turn an independently verified
 * external payment into exactly one call to BillingEngine.fundExternalCredit() (see engine.ts's
 * doc comment); it never manipulates billing_accounts / billing_ledger directly, never re-derives
 * balances, and never touches the reserve/settle/release path used by paid capability calls.
 *
 * ACCOUNTING MODEL — read this before touching anything in this directory:
 *
 *   A. FUNDING     A customer pays Stripe or sends USDC. This is EXTERNAL FUNDING COLLECTED —
 *                  money that left the customer's card/wallet and reached Rafid (Stripe's
 *                  account, or the configured on-chain receiving wallet). It is recorded here, in
 *                  rafid_external_payments, and — once verified — as exactly one
 *                  `credit_purchase` row in the existing unified billing ledger
 *                  (billing_ledger.type = 'credit_purchase'; see unified/types.ts). Funding is
 *                  NEVER itself counted as revenue: it increases a LIABILITY (money Rafid now
 *                  owes the customer in the form of usable prepaid balance), not an asset Rafid
 *                  has earned.
 *   B. CONSUMPTION A customer calls a paid capability and prepaid balance is captured. This is
 *                  PREPAID USAGE REVENUE — the existing unified-billing ledger rows
 *                  (type IN ('debit','subscription_usage'), status='settled'), already reported
 *                  by billing/unified/reporting.ts's summarizeUnifiedBillingRevenue(). This layer
 *                  never writes these rows; they come from the pre-existing reserve/settle path.
 *   C. X402        An on-chain capability payment settled through x402 — entirely separate from
 *                  A and B, already reported by revenue/aggregate.ts. Untouched by this layer.
 *
 * A dashboard (or any other consumer) must NEVER sum A and B: doing so double-counts the same
 * dollar once when the customer funds it and again when they spend it (see
 * src/api/dashboard/service.ts's buildCollectionFunding()/buildRevenueOverview() for exactly how
 * this is kept honest). The customer's outstanding prepaid balance (billing_accounts.
 * credit_balance_micros) is neither A's total nor B's total — it is A minus B minus whatever
 * remains reserved-but-unsettled, i.e. exactly what BillingEngine.billingBalanceView() already
 * reports.
 */

/** The two funding rails this layer supports. Every ExternalPayment/TopupIntent row is tagged
 *  with exactly one — never blended, exactly like x402/USDC vs. unified-billing/USD are never
 *  blended elsewhere in this codebase. */
export type ExternalPaymentProvider = "stripe" | "usdc_base";

/**
 * Lifecycle of one external payment:
 *   created         a checkout/top-up intent exists; no money observed yet (Stripe: session
 *                   created; USDC: intent created, nothing on-chain yet).
 *   pending         money is in flight but not yet independently confirmed (Stripe: a webhook
 *                   arrived but the session/payment isn't `paid`/`succeeded` yet — rare, kept for
 *                   completeness; USDC: a transaction hash was submitted to /confirm but this
 *                   verifier's own on-chain checks haven't all passed yet, e.g. confirmations
 *                   still accumulating).
 *   confirmed       independently verified; the matching credit_purchase ledger row has been (or
 *                   is about to be, in the same transaction) written.
 *   failed          the payment did not succeed (Stripe: payment_intent.payment_failed; USDC: the
 *                   on-chain transaction reverted, or the intent expired with nothing valid
 *                   received).
 *   refunded        the ORIGINAL charge was refunded at the provider (Stripe: charge.refunded).
 *                   See requires_review below for what happens to any credit already funded.
 *   requires_review a refund (or another anomaly) was observed but this payment's credit has
 *                   already been partly or fully CONSUMED (capability calls spent it), so this
 *                   layer cannot safely reverse the ledger without risking a negative balance or
 *                   silently under-charging a customer for work already delivered — see
 *                   service.ts's handleStripeRefund() doc comment for the exact rule.
 */
export type ExternalPaymentStatus = "created" | "pending" | "confirmed" | "failed" | "refunded" | "requires_review";

/** One durable row per external payment attempt — created, then updated in place as its
 *  lifecycle progresses. Never deleted (see reconciliation.ts's doc comment: financial records
 *  are never auto-deleted). `accountId` reuses the EXISTING billing account system
 *  (billing/unified/types.ts's BillingAccount) — there is no separate "customer" table here. */
export interface ExternalPayment {
  id: string;
  accountId: string;
  provider: ExternalPaymentProvider;
  /** Stripe: the Checkout Session id (cs_…). USDC: the on-chain transaction hash once submitted,
   *  null before then. This is a LOOKUP key, not the idempotency key — see providerEventId. */
  providerPaymentId: string | null;
  /** Stripe: the webhook Event id (evt_…) that actually triggered crediting — the true
   *  idempotency key (a Stripe webhook can and does redeliver the same event). Null for USDC
   *  (which has no event-delivery concept; transactionHash is USDC's own uniqueness key — see
   *  below) and null for a Stripe row before its funding webhook has arrived. */
  providerEventId: string | null;
  /** For USDC only — the open top-up intent this payment fulfills (see TopupIntent below). Null
   *  for Stripe, which has no separate intent table (the Checkout Session itself is the intent). */
  topupId: string | null;
  /** Integer micro-USD (same convention as billing_ledger.amount_micros) — always the CONFIRMED
   *  amount once status is "confirmed"; the requested amount before then. */
  amountAtomic: number;
  currency: "USD";
  /** USDC only — CAIP-2 network id (e.g. "eip155:8453"). Null for Stripe. */
  network: string | null;
  /** USDC only — "USDC". Null for Stripe. */
  asset: string | null;
  /** USDC only — the on-chain transaction hash. Null for Stripe (duplicated into
   *  providerPaymentId for USDC too, for a single "how do I look this up" mental model — kept as
   *  a separate named field as the spec requests). */
  transactionHash: string | null;
  status: ExternalPaymentStatus;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Safe, non-secret metadata only — e.g. { checkoutUrl, refundReason }. Never a card number, a
   *  webhook payload, a raw RPC response, or anything else that could carry payment-instrument
   *  data. See service.ts's redaction discipline. */
  metadata: Record<string, unknown>;
}

export type ExternalPaymentInput = Omit<ExternalPayment, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string };

/**
 * A USDC-on-Base top-up intent — see usdcTopup.ts's doc comment for the full correlation-strategy
 * rationale. `amountUsdcAtomic` is the customer's requested amount PLUS a small, unique,
 * sub-cent "tag" (1 to 9,999 micro-USD — i.e. $0.000001 to $0.009999) so that two concurrently
 * open intents never request the exact same on-chain transfer amount from the same recipient,
 * without needing a unique receiving address per customer (this deployment has no HD-wallet /
 * per-customer address derivation, and this layer must never handle a private key — see the
 * final report's "USDC transaction correlation strategy" section for the full reasoning and its
 * known limitation).
 */
export type TopupIntentStatus = "pending" | "confirmed" | "failed" | "expired";

export interface TopupIntent {
  id: string;
  accountId: string;
  /** The customer's requested amount, in micro-USD, before the correlation tag is added. */
  requestedAmountAtomic: number;
  /** requestedAmountAtomic + a unique tag (see this type's doc comment) — the EXACT amount, in
   *  USDC atomic units (1 USDC = 1,000,000, identical scale to micro-USD since this deployment
   *  treats USDC 1:1 with USD, the same convention revenue/aggregate.ts already documents for
   *  x402), the customer must transfer for this intent to be confirmable. */
  amountUsdcAtomic: number;
  network: string;
  chainId: number;
  asset: "USDC";
  recipient: string;
  status: TopupIntentStatus;
  /** Set once a /confirm call successfully verifies a matching transaction. */
  transactionHash: string | null;
  /** Set once confirmed — the ExternalPayment row this intent produced. */
  externalPaymentId: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export type TopupIntentInput = Omit<TopupIntent, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string };

/** Safety cap mirroring every other "fetch everything in the window, aggregate in plain JS"
 *  store in this codebase (revenue/types.ts's MAX_QUERY_SETTLEMENTS, billing/unified/types.ts's
 *  MAX_QUERY_LEDGER_ENTRIES) — a generous ceiling against a pathological unbounded query, not an
 *  expected operating limit. */
export const MAX_QUERY_EXTERNAL_PAYMENTS = 500_000;
