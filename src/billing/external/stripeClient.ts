import Stripe from "stripe";

/**
 * Thin, injectable wrapper over the official `stripe` npm SDK — the ONLY file in this codebase
 * that imports it. Kept this narrow so tests can supply a fully in-memory fake (see
 * tests/external-payments.test.ts) without ever making a real network call or needing a live
 * Stripe test-mode key, exactly like revenue/chainVerifier.ts's injectable JsonRpcCall does for
 * on-chain reads.
 *
 * Server-determined amount: createCheckoutSession never accepts a Stripe price/product id from
 * the caller — it builds the line item's `price_data` from the already-validated, already-bounded
 * `amountUsd` itself (see service.ts's createStripeCheckout(), which enforces
 * STRIPE_TOPUP_MIN_USD/MAX_USD BEFORE this is ever called).
 */
export interface StripeCheckoutSession {
  id: string;
  url: string | null;
}

/** The minimal shape this codebase reads off a Stripe webhook event — never the full SDK type,
 *  so nothing outside this file needs to depend on Stripe's types. `data.object` is read only for
 *  the specific, documented-safe fields service.ts's handlers destructure (id, payment_status,
 *  payment_intent, currency, amount_total, metadata, status) — never logged or stored whole. */
export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export interface StripeClient {
  createCheckoutSession(input: { amountUsd: number; accountId: string; topupReference: string; successUrl: string; cancelUrl: string }): Promise<StripeCheckoutSession>;
  /** Official signature verification (Stripe SDK's `stripe.webhooks.constructEvent`) — throws if
   *  the signature is invalid or the payload was tampered with. `payload` MUST be the raw request
   *  body bytes (never a re-serialized/parsed-then-stringified JSON object — Stripe's HMAC is
   *  computed over the exact bytes it sent). */
  constructWebhookEvent(payload: Buffer, signature: string, webhookSecret: string): StripeWebhookEvent;
  /** Optional (spec section 18): Stripe's own available/pending balance, for internal-only
   *  visibility — never a bank withdrawal, never exposed publicly. Read-only. */
  retrieveBalance(): Promise<{ availableUsd: number; pendingUsd: number }>;
}

export class RealStripeClient implements StripeClient {
  private readonly stripe: Stripe;
  constructor(secretKey: string) {
    this.stripe = new Stripe(secretKey);
  }

  async createCheckoutSession(input: { amountUsd: number; accountId: string; topupReference: string; successUrl: string; cancelUrl: string }): Promise<StripeCheckoutSession> {
    const unitAmountCents = Math.round(input.amountUsd * 100);
    const metadata = { rafidAccountId: input.accountId, rafidTopupReference: input.topupReference };
    const session = await this.stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        price_data: { currency: "usd", product_data: { name: "Rafid prepaid credit top-up" }, unit_amount: unitAmountCents },
        quantity: 1
      }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.topupReference,
      metadata,
      // Mirrored onto the PaymentIntent Checkout creates under the hood so a
      // payment_intent.payment_failed webhook — which never sees the Checkout Session object,
      // only the PaymentIntent — can still be correlated back to this top-up (see service.ts's
      // handleStripeWebhookEvent()). Without this, a failed-attempt-inside-Checkout event would
      // be unattributable to any account or topup reference.
      payment_intent_data: { metadata }
    });
    return { id: session.id, url: session.url };
  }

  constructWebhookEvent(payload: Buffer, signature: string, webhookSecret: string): StripeWebhookEvent {
    const event = this.stripe.webhooks.constructEvent(payload, signature, webhookSecret);
    return { id: event.id, type: event.type, data: { object: event.data.object as unknown as Record<string, unknown> } };
  }

  async retrieveBalance(): Promise<{ availableUsd: number; pendingUsd: number }> {
    const balance = await this.stripe.balance.retrieve();
    const sumUsd = (items: { amount: number; currency: string }[]) => items.filter(i => i.currency === "usd").reduce((s, i) => s + i.amount, 0) / 100;
    return { availableUsd: sumUsd(balance.available), pendingUsd: sumUsd(balance.pending) };
  }
}
