import { randomUUID } from "node:crypto";
import { BillingAdminError, type BillingEngine } from "../unified/engine.js";
import { formatMicros, usdToMicros } from "../unified/money.js";
import type { ExternalPaymentsConfig } from "./config.js";
import { ExternalPaymentStoreError, type ExternalPaymentStore } from "./store.js";
import type { ExternalPayment, ExternalPaymentProvider, TopupIntent } from "./types.js";
import { type JsonRpcCall, pickUniqueUsdcAmount, verifyUsdcTransfer } from "./usdcTopup.js";
import type { StripeClient, StripeWebhookEvent } from "./stripeClient.js";

const newExternalId = (prefix: "extpay" | "topup") => `${prefix}_${randomUUID().replace(/-/g, "")}`;

/** The eight funding-side events spec section 25 asks for (credits_consumed is deliberately not
 *  one of these — see analytics/types.ts's AnalyticsCategory "funding" doc comment for why).
 *  Deliberately a plain, self-contained shape (no dependency on express/analytics types) so this
 *  service stays usable without pulling in the analytics package — the caller (src/api/app.ts)
 *  adapts this to AnalyticsRepository via analytics/recorder.ts's recordFundingEvent(). */
export type ExternalPaymentsAnalyticsEvent = {
  eventType: "stripe_checkout_created" | "stripe_payment_confirmed" | "stripe_payment_failed" | "stripe_refund" | "usdc_topup_created" | "usdc_topup_confirmed" | "usdc_topup_failed" | "credits_funded";
  provider: ExternalPaymentProvider;
  success: boolean;
  /** Decimal USD, never a raw on-chain atomic value or card-network amount — null when not
   *  meaningful for this event. */
  amountUSD: number | null;
};

/**
 * Orchestration for the external payment-collection layer — the ONLY code in this codebase that
 * calls both an ExternalPaymentStore and BillingEngine.fundExternalCredit()/adjustCredit(), so
 * every actual balance change this layer causes goes through exactly one narrow, auditable path
 * (see engine.ts's doc comment on fundExternalCredit — "never called outside a verified external
 * payment"). Nothing here ever writes billing_accounts / billing_ledger directly.
 *
 * Every method here assumes its caller (src/billing/external/http.ts) has already authenticated
 * the request and resolved `accountId` from a Rafid API key (or, for the Stripe webhook, that the
 * request has NOT yet been trusted at all — see handleStripeWebhookEvent()'s doc comment).
 */
export class ExternalPaymentsService {
  constructor(private readonly deps: {
    store: ExternalPaymentStore;
    engine: BillingEngine;
    config: ExternalPaymentsConfig;
    stripe: StripeClient | null;
    rpcCall: JsonRpcCall | null;
    now?: () => Date;
    /** Fire-and-forget, exactly like analytics/recorder.ts's own call sites — an analytics-recording
     *  failure must never affect a real top-up/webhook/confirmation call. Never throws into a caller
     *  of this service even if the injected callback itself throws (see emit() below). */
    onEvent?: (event: ExternalPaymentsAnalyticsEvent) => void;
  }) {}

  private now(): Date { return this.deps.now ? this.deps.now() : new Date(); }
  private emit(event: ExternalPaymentsAnalyticsEvent): void {
    try { this.deps.onEvent?.(event); } catch { /* analytics must never break the real flow */ }
  }
  private usd(micros: number): number { return Number(formatMicros(micros)); }

  // ==== Stripe ===================================================================================

  /** POST /api/v1/billing/topup/stripe. The amount is validated and bounded HERE, server-side,
   *  before Stripe is ever called — createCheckoutSession() never accepts a client-supplied
   *  price/product id, only this already-validated amount (see stripeClient.ts's doc comment). */
  async createStripeCheckout(input: { accountId: string; amountUSD: unknown }): Promise<{ checkoutUrl: string; sessionId: string }> {
    if (!this.deps.stripe || !this.deps.config.stripe.enabled) throw new BillingAdminError(503, "stripe_unavailable", "Stripe top-ups are not configured on this deployment");
    const cfg = this.deps.config.stripe;
    const amountMicros = this.parseBoundedUsd(input.amountUSD, cfg.minUsd, cfg.maxUsd, "amountUSD");
    if (!cfg.successUrl || !cfg.cancelUrl) throw new BillingAdminError(503, "stripe_unavailable", "STRIPE_SUCCESS_URL / STRIPE_CANCEL_URL are not configured");
    const topupReference = newExternalId("extpay");
    const session = await this.deps.stripe.createCheckoutSession({
      amountUsd: Number(formatMicros(amountMicros)), accountId: input.accountId, topupReference,
      successUrl: cfg.successUrl, cancelUrl: cfg.cancelUrl
    });
    if (!session.url) throw new BillingAdminError(502, "stripe_error", "Stripe did not return a checkout URL");
    // Recorded as "created" — NOT funded. Only a verified webhook (handleStripeWebhookEvent below)
    // ever transitions this row to "confirmed" and credits the account. The browser redirect to
    // successUrl is never trusted for anything (see this module's top-of-class doc comment and
    // Section 3 of the spec this implements).
    await this.deps.store.createExternalPayment({
      id: topupReference, accountId: input.accountId, provider: "stripe", providerPaymentId: session.id,
      providerEventId: null, topupId: null, amountAtomic: amountMicros, currency: "USD", network: null, asset: null,
      transactionHash: null, status: "created", confirmedAt: null, metadata: { checkoutUrl: session.url }
    });
    this.emit({ eventType: "stripe_checkout_created", provider: "stripe", success: true, amountUSD: this.usd(amountMicros) });
    return { checkoutUrl: session.url, sessionId: session.id };
  }

  /**
   * POST /api/v1/billing/webhooks/stripe. `rawBody` MUST be the exact request bytes and
   * `signature` the `Stripe-Signature` header — http.ts is responsible for mounting this route
   * with a raw (non-JSON-parsing) body reader ahead of any global express.json() middleware, and
   * for NEVER calling this with a re-serialized body. Signature verification
   * (StripeClient.constructWebhookEvent) throws on a bad signature; http.ts turns that into a 400
   * without this method ever seeing an unverified event. This is the ONLY place a Stripe payment
   * can fund a balance — the success-redirect page never does (see createStripeCheckout above).
   */
  async handleStripeWebhookEvent(rawBody: Buffer, signature: string): Promise<{ handled: boolean; type: string }> {
    if (!this.deps.stripe || !this.deps.config.stripe.webhookSecret) throw new BillingAdminError(503, "stripe_unavailable", "Stripe webhooks are not configured");
    const event = this.deps.stripe.constructWebhookEvent(rawBody, signature, this.deps.config.stripe.webhookSecret);
    switch (event.type) {
      case "checkout.session.completed": await this.handleStripeCheckoutCompleted(event); return { handled: true, type: event.type };
      case "checkout.session.expired": await this.handleStripeCheckoutExpired(event); return { handled: true, type: event.type };
      case "payment_intent.payment_failed": await this.handleStripePaymentFailed(event); return { handled: true, type: event.type };
      case "charge.refunded": await this.handleStripeRefund(event); return { handled: true, type: event.type };
      default: return { handled: false, type: event.type };
    }
  }

  private async handleStripeCheckoutCompleted(event: StripeWebhookEvent): Promise<void> {
    const obj = event.data.object;
    const topupReference = readString(obj.metadata, "rafidTopupReference") ?? (typeof obj.client_reference_id === "string" ? obj.client_reference_id : null);
    if (!topupReference) return; // Not a session this layer created — nothing to attribute this to.
    const payment = await this.deps.store.getExternalPayment(topupReference);
    if (!payment || payment.provider !== "stripe") return;
    // Idempotency: a Stripe webhook can and does redeliver the same event. event.id is the true
    // idempotency key (see types.ts's providerEventId doc comment) — if this exact event already
    // produced a confirmed row, this is a pure replay.
    if (payment.providerEventId === event.id || payment.status === "confirmed") return;
    if (payment.status !== "created") return; // already failed/refunded/under review — do not resurrect it
    const paymentStatus = typeof obj.payment_status === "string" ? obj.payment_status : null;
    const currency = typeof obj.currency === "string" ? obj.currency : null;
    const amountTotalCents = typeof obj.amount_total === "number" ? obj.amount_total : null;
    if (paymentStatus !== "paid" || currency !== "usd" || amountTotalCents === null) {
      await this.deps.store.updateExternalPayment(payment.id, { status: "requires_review", providerEventId: event.id, metadata: { ...payment.metadata, reviewReason: "checkout.session.completed with unexpected payment_status/currency/amount", paymentStatus, currency, amountTotalCents } });
      return;
    }
    const confirmedMicros = amountTotalCents * 10_000; // 1 cent = 1,000,000/100 micro-USD
    const stripePaymentIntentId = typeof obj.payment_intent === "string" ? obj.payment_intent : null;
    const updated = await this.deps.store.updateExternalPayment(payment.id, {
      status: "confirmed", providerEventId: event.id, amountAtomic: confirmedMicros, confirmedAt: this.now().toISOString(),
      metadata: { ...payment.metadata, stripeSessionId: payment.providerPaymentId, stripePaymentIntentId, stripeEventId: event.id }
    });
    if (!updated) return;
    this.emit({ eventType: "stripe_payment_confirmed", provider: "stripe", success: true, amountUSD: this.usd(confirmedMicros) });
    await this.deps.engine.fundExternalCredit({ accountId: updated.accountId, amountMicros: confirmedMicros, externalPaymentId: updated.id, reason: "Stripe checkout top-up" });
    this.emit({ eventType: "credits_funded", provider: "stripe", success: true, amountUSD: this.usd(confirmedMicros) });
  }

  private async handleStripeCheckoutExpired(event: StripeWebhookEvent): Promise<void> {
    const obj = event.data.object;
    const topupReference = readString(obj.metadata, "rafidTopupReference") ?? (typeof obj.client_reference_id === "string" ? obj.client_reference_id : null);
    if (!topupReference) return;
    const payment = await this.deps.store.getExternalPayment(topupReference);
    if (!payment || payment.provider !== "stripe" || payment.status !== "created") return;
    await this.deps.store.updateExternalPayment(payment.id, { status: "failed", providerEventId: event.id, metadata: { ...payment.metadata, failureReason: "checkout_session_expired" } });
    this.emit({ eventType: "stripe_payment_failed", provider: "stripe", success: false, amountUSD: this.usd(payment.amountAtomic) });
  }

  private async handleStripePaymentFailed(event: StripeWebhookEvent): Promise<void> {
    const obj = event.data.object;
    const topupReference = readString(obj.metadata, "rafidTopupReference");
    if (!topupReference) return; // No metadata means this PaymentIntent wasn't created by createStripeCheckout.
    const payment = await this.deps.store.getExternalPayment(topupReference);
    if (!payment || payment.provider !== "stripe" || payment.status !== "created") return;
    const lastError = obj.last_payment_error && typeof obj.last_payment_error === "object" ? (obj.last_payment_error as Record<string, unknown>).message : undefined;
    await this.deps.store.updateExternalPayment(payment.id, { status: "failed", providerEventId: event.id, metadata: { ...payment.metadata, failureReason: typeof lastError === "string" ? lastError : "payment_intent.payment_failed" } });
    this.emit({ eventType: "stripe_payment_failed", provider: "stripe", success: false, amountUSD: this.usd(payment.amountAtomic) });
  }

  /**
   * Section 5's refund rule: a refund of the ORIGINAL charge never blindly drives the balance
   * negative. If the account currently holds at least the refunded amount, the refund is safe to
   * mirror as a ledger reversal (the money was never spent, or enough of it remains); otherwise —
   * some of it was already consumed by paid capability calls — the row is flagged
   * "requires_review" and NO ledger entry is written, so a human decides how to reconcile it
   * rather than this code silently under- or over-correcting the customer's balance.
   */
  private async handleStripeRefund(event: StripeWebhookEvent): Promise<void> {
    const obj = event.data.object;
    const paymentIntentId = typeof obj.payment_intent === "string" ? obj.payment_intent : null;
    const amountRefundedCents = typeof obj.amount_refunded === "number" ? obj.amount_refunded : (typeof obj.amount === "number" ? obj.amount : null);
    if (!paymentIntentId || amountRefundedCents === null) return;
    // No dedicated index for "find by Stripe PaymentIntent id" — this mirrors the rest of this
    // codebase's convention of fetching a bounded window and filtering in plain JS (see
    // store.ts's doc comment on listExternalPayments) rather than adding a new column/index for a
    // rarely-hit path.
    const candidates = await this.deps.store.listExternalPayments({ since: null, provider: "stripe", status: "confirmed" });
    const payment = candidates.find(p => p.metadata.stripePaymentIntentId === paymentIntentId);
    if (!payment) return;
    if (payment.status !== "confirmed") return; // already refunded/under review — replay, no-op
    const refundedMicros = amountRefundedCents * 10_000;
    const account = await this.deps.engine.billingBalanceView(payment.accountId);
    const availableMicros = usdToMicros(account.availableUSD);
    if (availableMicros >= refundedMicros) {
      await this.deps.engine.adjustCredit({ accountId: payment.accountId, amount: `-${formatMicros(refundedMicros)}`, reason: `Stripe refund of payment ${payment.id}`, externalTransactionId: `stripe_refund:${event.id}` });
      await this.deps.store.updateExternalPayment(payment.id, { status: "refunded", metadata: { ...payment.metadata, refundedMicros, refundEventId: event.id } });
      this.emit({ eventType: "stripe_refund", provider: "stripe", success: true, amountUSD: this.usd(refundedMicros) });
    } else {
      await this.deps.store.updateExternalPayment(payment.id, { status: "requires_review", metadata: { ...payment.metadata, refundedMicros, refundEventId: event.id, reviewReason: "refund exceeds currently available balance — some credit already consumed" } });
      this.emit({ eventType: "stripe_refund", provider: "stripe", success: false, amountUSD: this.usd(refundedMicros) });
    }
  }

  // ==== USDC on Base ==============================================================================

  /** POST /api/v1/billing/topup/usdc. See usdcTopup.ts's doc comment for the amount-tagging
   *  correlation strategy this implements — `amountUsdcAtomic` (returned as `amountUSDC`) is the
   *  EXACT amount the customer must transfer; a transfer of any other amount will not match. */
  async createUsdcTopupIntent(input: { accountId: string; amountUSD: unknown }): Promise<{
    topupId: string; network: string; chainId: number; asset: "USDC"; amountUSDC: string; recipient: string; reference: string; expiresAt: string;
  }> {
    if (!this.deps.config.usdc.enabled) throw new BillingAdminError(503, "usdc_unavailable", "USDC top-ups are not configured on this deployment");
    const cfg = this.deps.config.usdc;
    const requestedAmountAtomic = this.parseBoundedUsd(input.amountUSD, cfg.minUsd, cfg.maxUsd, "amountUSD");
    const recipient = cfg.receivingAddress!;
    const amountUsdcAtomic = await pickUniqueUsdcAmount(this.deps.store, recipient, requestedAmountAtomic);
    const expiresAt = new Date(this.now().getTime() + this.deps.config.topupExpiryMinutes * 60_000).toISOString();
    const id = newExternalId("topup");
    const intent = await this.deps.store.createTopupIntent({
      id, accountId: input.accountId, requestedAmountAtomic, amountUsdcAtomic, network: cfg.network, chainId: cfg.chainId,
      asset: "USDC", recipient, status: "pending", transactionHash: null, externalPaymentId: null, expiresAt, metadata: {}
    });
    this.emit({ eventType: "usdc_topup_created", provider: "usdc_base", success: true, amountUSD: this.usd(requestedAmountAtomic) });
    return { topupId: intent.id, network: "Base", chainId: intent.chainId, asset: "USDC", amountUSDC: formatMicros(intent.amountUsdcAtomic), recipient: intent.recipient, reference: intent.id, expiresAt: intent.expiresAt };
  }

  /**
   * POST /api/v1/billing/topup/usdc/:topupId/confirm. Never trusts `transactionHash`'s amount,
   * recipient or network — verifyUsdcTransfer() independently re-derives all of that from the
   * chain itself (see usdcTopup.ts). Only a "confirmed" outcome ever calls
   * BillingEngine.fundExternalCredit(); every other outcome is reported back without touching the
   * ledger, so a client can safely poll this endpoint as many times as it wants.
   */
  async confirmUsdcTopup(input: { accountId: string; topupId: string; transactionHash?: unknown }): Promise<{
    status: "pending" | "confirmed" | "failed" | "expired"; confirmations: number | null; detail: string; balanceUSD?: string;
  }> {
    if (!this.deps.config.usdc.enabled || !this.deps.rpcCall) throw new BillingAdminError(503, "usdc_unavailable", "USDC top-ups are not configured on this deployment");
    const intent = await this.deps.store.getTopupIntent(input.topupId);
    if (!intent || intent.accountId !== input.accountId) throw new BillingAdminError(404, "topup_not_found", "No such USDC top-up intent for this account");

    if (intent.status === "confirmed") {
      const balance = await this.deps.engine.billingBalanceView(intent.accountId);
      return { status: "confirmed", confirmations: null, detail: "Already confirmed", balanceUSD: balance.availableUSD.toFixed(2) };
    }
    if (intent.status === "failed") return { status: "failed", confirmations: null, detail: "This top-up's transaction did not succeed on-chain" };

    const txHash = typeof input.transactionHash === "string" && input.transactionHash ? input.transactionHash : intent.transactionHash;
    if (intent.status === "expired") return this.handleLateUsdcConfirm(intent, txHash);
    if (!txHash) return { status: "pending", confirmations: null, detail: "No transactionHash submitted yet" };

    // Global uniqueness (Section 9/24): a transaction hash can fund at most one top-up, ever.
    const clash = await this.deps.store.findExternalPaymentByTransactionHash("usdc_base", txHash);
    if (clash && clash.topupId !== intent.id) return { status: "failed", confirmations: null, detail: "This transaction hash has already been used to fund a different top-up" };
    if (clash && clash.topupId === intent.id) {
      const balance = await this.deps.engine.billingBalanceView(intent.accountId);
      return { status: "confirmed", confirmations: null, detail: "Already confirmed", balanceUSD: balance.availableUSD.toFixed(2) };
    }

    if (txHash !== intent.transactionHash) await this.deps.store.updateTopupIntent(intent.id, { transactionHash: txHash });
    const cfg = this.deps.config.usdc;
    const result = await verifyUsdcTransfer({
      rpcCall: this.deps.rpcCall, transactionHash: txHash, expectedChainId: cfg.chainId, usdcContract: cfg.usdcContract!,
      expectedRecipient: cfg.receivingAddress!, expectedAmountUsdcAtomic: intent.amountUsdcAtomic, requiredConfirmations: cfg.confirmations
    });

    if (result.outcome === "pending") return { status: "pending", confirmations: result.confirmations, detail: result.detail };
    if (result.outcome === "failed") {
      await this.deps.store.updateTopupIntent(intent.id, { status: "failed" });
      this.emit({ eventType: "usdc_topup_failed", provider: "usdc_base", success: false, amountUSD: this.usd(intent.amountUsdcAtomic) });
      return { status: "failed", confirmations: result.confirmations, detail: result.detail };
    }
    if (result.outcome !== "confirmed") {
      // wrong_network / wrong_recipient / wrong_amount / wrong_token / not_found / error: report
      // as "failed" for THIS attempt but leave the intent "pending" — the customer may have
      // pasted the wrong hash and can retry confirm with the correct one before it expires.
      this.emit({ eventType: "usdc_topup_failed", provider: "usdc_base", success: false, amountUSD: this.usd(intent.amountUsdcAtomic) });
      return { status: "failed", confirmations: result.confirmations, detail: result.detail };
    }

    let payment: ExternalPayment;
    try {
      payment = await this.deps.store.createExternalPayment({
        id: newExternalId("extpay"), accountId: intent.accountId, provider: "usdc_base", providerPaymentId: txHash,
        providerEventId: null, topupId: intent.id, amountAtomic: Number(result.actualAmountUsdcAtomic), currency: "USD",
        network: intent.network, asset: "USDC", transactionHash: txHash, status: "confirmed", confirmedAt: this.now().toISOString(),
        metadata: { confirmations: result.confirmations }
      });
    } catch (e) {
      if (e instanceof ExternalPaymentStoreError && e.code === "duplicate_transaction_hash") {
        const balance = await this.deps.engine.billingBalanceView(intent.accountId);
        return { status: "confirmed", confirmations: result.confirmations, detail: "Already confirmed", balanceUSD: balance.availableUSD.toFixed(2) };
      }
      throw e;
    }
    await this.deps.store.updateTopupIntent(intent.id, { status: "confirmed", transactionHash: txHash, externalPaymentId: payment.id });
    this.emit({ eventType: "usdc_topup_confirmed", provider: "usdc_base", success: true, amountUSD: this.usd(payment.amountAtomic) });
    await this.deps.engine.fundExternalCredit({ accountId: intent.accountId, amountMicros: payment.amountAtomic, externalPaymentId: payment.id, reason: "USDC on Base top-up" });
    this.emit({ eventType: "credits_funded", provider: "usdc_base", success: true, amountUSD: this.usd(payment.amountAtomic) });
    const balance = await this.deps.engine.billingBalanceView(intent.accountId);
    return { status: "confirmed", confirmations: result.confirmations, detail: result.detail, balanceUSD: balance.availableUSD.toFixed(2) };
  }

  /** Section 23: an expired intent's tagged amount may have been reissued to a different, later
   *  intent — so a late transfer is NEVER auto-credited, even if it verifies perfectly on-chain.
   *  When a hash is presented against an expired intent, it is independently verified anyway so a
   *  genuine late payment isn't silently lost: a verified match is recorded as "requires_review"
   *  (visible to admins — see http.ts's admin listing) rather than credited or discarded. */
  private async handleLateUsdcConfirm(intent: TopupIntent, txHash: string | null): Promise<{ status: "expired"; confirmations: number | null; detail: string }> {
    if (!txHash) return { status: "expired", confirmations: null, detail: "This top-up intent expired before a transaction was submitted" };
    const cfg = this.deps.config.usdc;
    const result = await verifyUsdcTransfer({
      rpcCall: this.deps.rpcCall!, transactionHash: txHash, expectedChainId: cfg.chainId, usdcContract: cfg.usdcContract!,
      expectedRecipient: cfg.receivingAddress!, expectedAmountUsdcAtomic: intent.amountUsdcAtomic, requiredConfirmations: cfg.confirmations
    });
    if (result.outcome === "confirmed") {
      const existing = await this.deps.store.findExternalPaymentByTransactionHash("usdc_base", txHash);
      if (!existing) {
        await this.deps.store.createExternalPayment({
          id: newExternalId("extpay"), accountId: intent.accountId, provider: "usdc_base", providerPaymentId: txHash,
          providerEventId: null, topupId: intent.id, amountAtomic: Number(result.actualAmountUsdcAtomic), currency: "USD",
          network: intent.network, asset: "USDC", transactionHash: txHash, status: "requires_review", confirmedAt: null,
          metadata: { confirmations: result.confirmations, reviewReason: "verified on-chain transfer arrived after this top-up intent expired" }
        }).catch(e => { if (!(e instanceof ExternalPaymentStoreError)) throw e; });
      }
      return { status: "expired", confirmations: result.confirmations, detail: "This top-up intent expired, but a matching transfer was found and flagged for manual review — it was NOT automatically credited." };
    }
    return { status: "expired", confirmations: result.confirmations, detail: "This top-up intent has expired" };
  }

  /** `accountId` omitted lists across every account — used only by the admin routes
   *  (billing/external/http.ts's createExternalPaymentsAdminRoutes); the customer-facing surface
   *  never calls this without an accountId. */
  async listTopupIntents(opts: { accountId?: string; status?: TopupIntent["status"]; limit?: number } = {}) {
    return this.deps.store.listTopupIntents(opts);
  }
  async listExternalPayments(opts: { accountId?: string; provider?: ExternalPaymentProvider; since?: Date | null; limit?: number } = {}) {
    return this.deps.store.listExternalPayments({ since: opts.since ?? null, accountId: opts.accountId, provider: opts.provider, limit: opts.limit });
  }
  /** Maintenance action (mirrors BillingEngine.releaseStale()) — transitions overdue "pending"
   *  USDC top-up intents to "expired". Safe to call repeatedly; never touches confirmed rows. */
  async expireStaleTopups() { return { expired: await this.deps.store.expireStaleTopupIntents(this.now()) }; }

  /** Section 18 (optional): Stripe's own available/pending balance via the official API — internal
   *  visibility only, never a bank withdrawal, never exposed on any public/customer-facing route.
   *  Deliberately NOT included in the main dashboard's per-request build (buildDashboardData runs
   *  on every dashboard page load; a live Stripe API round trip there would slow every load and
   *  could fail the whole dashboard on a Stripe outage) — exposed instead as its own on-demand
   *  admin endpoint (GET /api/internal/billing/stripe-balance in http.ts). Returns null when
   *  Stripe isn't configured, never throws for that reason. */
  async stripeBalance(): Promise<{ availableUsd: number; pendingUsd: number } | null> {
    if (!this.deps.stripe || !this.deps.config.stripe.enabled) return null;
    return this.deps.stripe.retrieveBalance();
  }

  private parseBoundedUsd(value: unknown, minUsd: number, maxUsd: number, field: string): number {
    if (typeof value !== "number" && typeof value !== "string") throw new BillingAdminError(400, "invalid_amount", `${field} is required`);
    let micros: number;
    try { micros = usdToMicros(value as string | number); } catch { throw new BillingAdminError(400, "invalid_amount", `${field} must be a decimal USD amount`); }
    const minMicros = usdToMicros(minUsd);
    const maxMicros = usdToMicros(maxUsd);
    if (micros < minMicros || micros > maxMicros) throw new BillingAdminError(400, "invalid_amount", `${field} must be between $${minUsd} and $${maxUsd}`);
    return micros;
  }
}

function readString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const v = (metadata as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}
