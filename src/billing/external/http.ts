import express, { type Request, type RequestHandler, type Response, Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { BillingAdminError, type BillingEngine } from "../unified/engine.js";
import { billingAdminBasePath, fail, requireBillingKey } from "../unified/http.js";
import type { BillingAccount } from "../unified/types.js";
import { buildExternalPaymentsReconciliation } from "./reconciliation.js";
import type { ExternalPaymentsService } from "./service.js";
import type { ExternalPaymentProvider, ExternalPaymentStatus, TopupIntentStatus } from "./types.js";

export const externalBillingBasePath = "/api/v1/billing";

const send = (res: Response, data: unknown, status = 200) => res.status(status).json({ success: true, data, meta: { requestId: res.locals.requestId } });
const handle = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => async (req, res, next) => {
  try { await fn(req, res); }
  catch (error) {
    if (error instanceof BillingAdminError) return fail(res, error.status, error.code, error.message);
    next(error);
  }
};

const PROVIDERS: readonly ExternalPaymentProvider[] = ["stripe", "usdc_base"];
const PAYMENT_STATUSES: readonly ExternalPaymentStatus[] = ["created", "pending", "confirmed", "failed", "refunded", "requires_review"];
const TOPUP_STATUSES: readonly TopupIntentStatus[] = ["pending", "confirmed", "failed", "expired"];
const oneOf = <T extends string>(values: readonly T[], v: unknown): T | undefined => (typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : undefined);

/**
 * Customer-facing external-payment-collection routes: Stripe Checkout + USDC-on-Base top-ups,
 * plus GET /api/v1/billing/balance. Reuses the EXISTING Rafid API-key system for authentication
 * (requireBillingKey, imported from billing/unified/http.ts — never a new auth mechanism) and the
 * existing BillingEngine for the actual balance the customer sees. This module owns no balance
 * state of its own; every credit is written by ExternalPaymentsService through
 * BillingEngine.fundExternalCredit() (see service.ts's doc comment).
 *
 * Mounted regardless of whether Stripe/USDC are configured — an unconfigured rail answers 503
 * from inside ExternalPaymentsService itself (see createStripeCheckout()/createUsdcTopupIntent()),
 * exactly like createBillingAdminRoutes() answers 503 until BILLING_ADMIN_SECRET is set. When
 * unified billing itself is entirely disabled (no BillingEngine at all — `engine`/`service` are
 * both null), every route here answers a single consistent 503 rather than 404ing, so a client
 * probing payment-options never gets an inconsistent picture of what exists.
 */
export function createExternalPaymentsRoutes(deps: {
  engine: BillingEngine | null;
  service: ExternalPaymentsService | null;
  stripeCheckoutLimiter: RequestHandler;
  usdcTopupLimiter: RequestHandler;
  usdcConfirmLimiter: RequestHandler;
  balanceLimiter: RequestHandler;
  webhookLimiter: RequestHandler;
}): Router {
  const router = Router();
  const b = externalBillingBasePath;
  if (!deps.engine || !deps.service) {
    const unavailable: RequestHandler = (_req, res) => fail(res, 503, "external_payments_unavailable", "External payment collection (Stripe/USDC top-ups) is disabled on this deployment (API_CREDITS_ENABLED / SUBSCRIPTIONS_ENABLED).");
    router.post(b + "/topup/stripe", unavailable);
    router.post(b + "/webhooks/stripe", unavailable);
    router.post(b + "/topup/usdc", unavailable);
    router.post(b + "/topup/usdc/:topupId/confirm", unavailable);
    router.get(b + "/balance", unavailable);
    return router;
  }
  const engine = deps.engine;
  const service = deps.service;
  const auth = requireBillingKey(engine);
  const acct = (res: Response) => (res.locals.billingAccount as BillingAccount).id;
  const bodyOf = (req: Request): Record<string, unknown> => (req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {});

  router.post(b + "/topup/stripe", deps.stripeCheckoutLimiter, auth, express.json({ limit: "4kb" }), handle(async (req, res) =>
    send(res, await service.createStripeCheckout({ accountId: acct(res), amountUSD: bodyOf(req).amountUSD }), 201)));

  // Stripe webhook: intentionally NOT behind requireBillingKey — the caller is Stripe, not a
  // Rafid customer. Authenticated purely by its own HMAC signature (Stripe-Signature header,
  // verified inside service.handleStripeWebhookEvent -> StripeClient.constructWebhookEvent).
  // express.raw() here (not express.json()) is required: Stripe's signature is computed over the
  // exact request bytes it sent, and re-serializing a parsed JSON object would invalidate it.
  router.post(b + "/webhooks/stripe", deps.webhookLimiter, express.raw({ type: "application/json", limit: "256kb" }), handle(async (req, res) => {
    const signature = req.header("stripe-signature");
    if (!signature) return fail(res, 400, "missing_signature", "Stripe-Signature header is required");
    if (!Buffer.isBuffer(req.body)) return fail(res, 400, "invalid_body", "Expected the raw Stripe webhook payload");
    try {
      send(res, await service.handleStripeWebhookEvent(req.body, signature));
    } catch (error) {
      if (error instanceof BillingAdminError) throw error;
      // Stripe's SDK throws a plain Error (StripeSignatureVerificationError) on a bad signature —
      // always a 400 (the caller's problem), never a 5xx that would make Stripe retry forever.
      fail(res, 400, "invalid_signature", "Stripe webhook signature verification failed");
    }
  }));

  router.post(b + "/topup/usdc", deps.usdcTopupLimiter, auth, express.json({ limit: "4kb" }), handle(async (req, res) =>
    send(res, await service.createUsdcTopupIntent({ accountId: acct(res), amountUSD: bodyOf(req).amountUSD }), 201)));

  router.post(b + "/topup/usdc/:topupId/confirm", deps.usdcConfirmLimiter, auth, express.json({ limit: "4kb" }), handle(async (req, res) =>
    send(res, await service.confirmUsdcTopup({ accountId: acct(res), topupId: String(req.params.topupId), transactionHash: bodyOf(req).transactionHash }))));

  router.get(b + "/balance", deps.balanceLimiter, auth, handle(async (_req, res) => send(res, await engine.billingBalanceView(acct(res)))));

  return router;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * Internal admin visibility for external payments and USDC top-up intents (spec section 19) —
 * provider, customer, amount, status, timestamp, tx hash / Stripe session reference, review
 * flags. Deliberately minimal (list + one maintenance action), never a finance ERP.
 *
 * Protected by the SAME BILLING_ADMIN_SECRET credential as unified billing's own admin API
 * (billing/unified/http.ts's createBillingAdminRoutes) — this mirrors that function's auth check
 * exactly (same env var, same `X-Billing-Admin-Key`/`Authorization: Bearer` headers, same
 * constant-time comparison) rather than introducing a second admin credential, per the spec's
 * "reuse existing admin authentication" requirement. It is a separate Express Router (Express
 * happily layers several routers under the same path prefix), so unified billing's admin routes
 * are untouched.
 */
export function createExternalPaymentsAdminRoutes(deps: { service: ExternalPaymentsService | null; engine: BillingEngine | null; adminSecret: string | null; limiter: RequestHandler; usdcNetwork: string; usdcAsset: string }): Router {
  const router = Router();
  const expected = deps.adminSecret ? digest(deps.adminSecret) : null;
  const base = billingAdminBasePath;
  router.use(base, deps.limiter, (req, res, next) => {
    if (!expected || !deps.service) return fail(res, 503, "billing_admin_unavailable", !deps.service ? "External payment collection is disabled on this deployment." : "Billing admin is not configured (BILLING_ADMIN_SECRET is unset).");
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.header("authorization") ?? "")?.[1];
    const presented = digest(req.header("x-billing-admin-key") ?? bearer ?? "");
    if (!timingSafeEqual(presented, expected)) return fail(res, 401, "unauthorized", "A valid billing admin key is required");
    next();
  }, express.json({ limit: "16kb" }));
  const service = () => deps.service!;

  router.get(base + "/external-payments", handle(async (req, res) => send(res, await service().listExternalPayments({
    accountId: typeof req.query.accountId === "string" ? req.query.accountId : undefined,
    provider: oneOf(PROVIDERS, req.query.provider),
    since: typeof req.query.since === "string" ? new Date(req.query.since) : null,
    limit: req.query.limit ? Number(req.query.limit) : undefined
  }).then(rows => oneOf(PAYMENT_STATUSES, req.query.status) ? rows.filter(r => r.status === req.query.status) : rows))));

  router.get(base + "/topups", handle(async (req, res) => send(res, await service().listTopupIntents({
    accountId: typeof req.query.accountId === "string" ? req.query.accountId : undefined,
    status: oneOf(TOPUP_STATUSES, req.query.status),
    limit: req.query.limit ? Number(req.query.limit) : undefined
  }))));

  router.post(base + "/maintenance/expire-stale-topups", handle(async (_req, res) => send(res, await service().expireStaleTopups())));

  // Section 18 (optional, internal-only): Stripe's own available/pending balance — see
  // service.ts's stripeBalance() doc comment for why this is its own on-demand route rather than
  // part of the main dashboard payload. null (not an error) when Stripe isn't configured.
  router.get(base + "/stripe-balance", handle(async (_req, res) => send(res, await service().stripeBalance())));

  // Section 24: cross-checks rafid_external_payments against the unified billing ledger's
  // credit_purchase rows — GET-only, never auto-corrects anything (see reconciliation.ts's doc
  // comment). `since` bounds the window like every other reporting endpoint in this codebase;
  // omitted means "everything ever recorded".
  router.get(base + "/reconciliation", handle(async (req, res) => {
    if (!deps.engine) return fail(res, 503, "billing_admin_unavailable", "Unified billing is disabled.");
    const since = typeof req.query.since === "string" ? new Date(req.query.since) : null;
    const [payments, creditPurchases] = await Promise.all([
      service().listExternalPayments({ since }),
      deps.engine.store.listCreditPurchases(since)
    ]);
    send(res, { anomalies: buildExternalPaymentsReconciliation({ payments, creditPurchases, expectedUsdcNetwork: deps.usdcNetwork, expectedUsdcAsset: deps.usdcAsset }), since: since?.toISOString() ?? null, paymentsChecked: payments.length, creditPurchasesChecked: creditPurchases.length });
  }));

  return router;
}
