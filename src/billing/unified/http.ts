import express, { type Request, type RequestHandler, type Response, Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import type { z } from "zod";
import { ApiError } from "../../utils/errors.js";
import { bearerBillingKey, looksLikeBillingKey } from "./apiKeys.js";
import { BillingAdminError, subscriptionView, type AuthResult, type BillingEngine } from "./engine.js";
import { enabledPaymentMethodIds, paymentMethodsPath, paymentOptionsObject, railAvailability, type RailDiscoveryConfig } from "./discovery.js";
import { requestHash, runBilledCall, validIdempotencyKey } from "./execution.js";
import { money } from "./money.js";
import { detectCredentials, selectPayment, type ExternalRail } from "./selection.js";
import { PAYMENT_METHOD_HEADER, type ApiKeyRecord, type BillingAccount } from "./types.js";

export interface BillableCapability {
  name: string;
  path: string;
  input: z.ZodType;
  execute: (input: unknown) => Promise<unknown>;
  requestBodyLimit?: string;
}

export const accountBasePath = "/api/v1/account";
export const billingAdminBasePath = "/api/internal/billing";
/** Response headers carrying billing metadata (also exposed via CORS in app.ts). */
export const BILLING_RESPONSE_HEADERS = ["X-Rafid-Billing-Rail", "X-Rafid-Charge", "X-Rafid-Balance-Remaining", "X-Rafid-Subscription-Remaining", "X-Rafid-Transaction-Id"];

const run = (mw: RequestHandler, req: Request, res: Response) =>
  new Promise<void>((resolve, reject) => { void mw(req, res, (err?: unknown) => (err ? reject(err) : resolve())); });

function fail(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.status(status).json({ success: false, error: { code, message }, ...extra, meta: { requestId: res.locals.requestId } });
}

function authFailure(res: Response, auth: Extract<AuthResult, { ok: false }>) {
  fail(res, auth.status, auth.code, auth.message, {}, auth.status === 401 ? { "WWW-Authenticate": `Bearer realm="rafid", error="invalid_token"` } : {});
}

function setBillingHeaders(res: Response, billing: Record<string, unknown> | undefined) {
  if (!billing) return;
  if (billing.rail) res.setHeader("X-Rafid-Billing-Rail", String(billing.rail));
  if (billing.amount) res.setHeader("X-Rafid-Charge", String(billing.amount));
  if (billing.remainingBalance) res.setHeader("X-Rafid-Balance-Remaining", String(billing.remainingBalance));
  if (billing.subscriptionRemaining) res.setHeader("X-Rafid-Subscription-Remaining", String(billing.subscriptionRemaining));
  if (billing.transactionId) res.setHeader("X-Rafid-Transaction-Id", String(billing.transactionId));
}

/**
 * The unified entry point for every paid capability's canonical REST route
 * (POST /api/v1/<tool-path> and its /v1 alias). Mounted in app.ts BEFORE those routes. It decides
 * the payment rail (selection.ts) and then either:
 *  - "legacy":   calls next() — the pre-existing X-API-Key route handles the request, unchanged;
 *  - "external": re-dispatches the request internally to the existing, protocol-correct rail
 *                route (x402 → /api/v1/x402/<path>, L402 → /api/v1/l402/<path>, MPP →
 *                /api/v1/mpp/charge/<tool>) by rewriting req.url and calling next(). The x402 /
 *                L402 / MPP gates therefore still produce their exact standards-compliant 402
 *                challenges and verify/settle exactly as before; nothing about them is duplicated;
 *  - "account":  authenticates the Rafid API key and runs the shared billed-call path
 *                (execution.ts) for subscription allowance / prepaid credits;
 *  - "payment_required": 402 with discovery of every enabled rail.
 */
export function createPaymentDispatcher(deps: {
  engine: BillingEngine | null;
  config: RailDiscoveryConfig;
  capabilities: readonly BillableCapability[];
  priceUsd: (tool: string) => number;
  bodyParserFor: (c: BillableCapability) => RequestHandler;
  rateLimiter?: RequestHandler;
  externalPath: (rail: ExternalRail, c: BillableCapability) => string;
  /** The rail's own rate limiter, applied before an internal re-dispatch (the rail route family's
   *  prefix-mounted limiter was already passed by the time the canonical path is rewritten). */
  externalLimiters?: Partial<Record<ExternalRail, RequestHandler>>;
  classifyResult?: (tool: string, data: unknown) => unknown;
}): RequestHandler {
  const byPath = new Map<string, BillableCapability>();
  for (const c of deps.capabilities) for (const prefix of ["/api/v1", "/v1"]) byPath.set((prefix + c.path).toLowerCase(), c);
  const availability = railAvailability(deps.config);
  const fallback = deps.config.billing?.subscriptionCreditFallback ?? true;
  const priceView = (c: BillableCapability) => money(deps.engine ? deps.engine.priceMicros(c.name) : Math.round(deps.priceUsd(c.name) * 1e6));

  const rewrite = (req: Request, res: Response, rail: ExternalRail, c: BillableCapability) => {
    delete res.locals.toolName; delete res.locals.channel; delete res.locals.customerId; delete res.locals.billingNotCharged;
    res.locals.paymentDispatch = { rail, from: req.path };
    const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    req.url = deps.externalPath(rail, c) + query;
  };

  return async (req, res, next) => {
    if (req.method !== "POST") return next();
    const c = byPath.get(req.path.replace(/\/+$/, "").toLowerCase());
    if (!c) return next();
    try {
      const creds = detectCredentials(name => req.header(name));
      // Zero-priced tools are free on the unified path: no account or payment is required.
      if (availability.billing && deps.engine && deps.engine.priceMicros(c.name) === 0) {
        res.locals.toolName = c.name; res.locals.channel = "free";
        if (!req.is("application/json")) throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json");
        await run(deps.bodyParserFor(c), req, res);
        const data = await c.execute(c.input.parse(req.body));
        res.setHeader("X-Rafid-Billing-Rail", "free"); res.setHeader("X-Rafid-Charge", "0.00");
        res.json({ success: true, data, meta: { requestId: res.locals.requestId, tool: c.name, price: 0, currency: "USD", billing: { rail: "free", amount: "0.00", currency: "USD" } } });
        return;
      }
      const decision = selectPayment(req.header(PAYMENT_METHOD_HEADER), creds, availability, fallback);
      if (decision.kind === "legacy") return next();
      if (decision.kind === "external") {
        const limiter = deps.externalLimiters?.[decision.rail];
        if (limiter) await run(limiter, req, res);
        rewrite(req, res, decision.rail, c); return next();
      }
      if (decision.kind === "error") {
        return fail(res, decision.status, decision.code, decision.message, decision.code === "payment_method_unavailable" || decision.code === "invalid_payment_method" ? { paymentOptions: enabledPaymentMethodIds(deps.config), paymentMethods: paymentMethodsPath } : {});
      }
      if (decision.kind === "payment_required") {
        return fail(res, 402, "payment_required", `Payment is required to call ${c.name}. Choose one of the enabled payment options.`, {
          tool: c.name, price: priceView(c), paymentOptions: paymentOptionsObject(deps.config), paymentMethods: paymentMethodsPath
        });
      }
      // decision.kind === "account"
      const engine = deps.engine!;
      const auth = await engine.authenticate(decision.apiKey);
      if (!auth.ok) return authFailure(res, auth);
      res.locals.toolName = c.name; res.locals.channel = "api_credits"; res.locals.customerId = `billing:${auth.account.id}`;
      if (deps.rateLimiter) await run(deps.rateLimiter, req, res);
      if (!req.is("application/json")) throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json");
      await run(deps.bodyParserFor(c), req, res);
      const toolInput = c.input.parse(req.body);
      const idemHeader = req.header("idempotency-key");
      if (idemHeader !== undefined && !validIdempotencyKey(idemHeader)) return fail(res, 400, "invalid_idempotency_key", "Idempotency-Key must be 1-255 visible ASCII characters");
      const result = await runBilledCall({
        engine, tool: c, priceUsd: deps.priceUsd(c.name), toolInput, account: auth.account, key: auth.key,
        rails: decision.rails, subscriptionFallback: decision.subscriptionFallback, requestId: res.locals.requestId,
        idempotency: idemHeader ? { key: idemHeader, requestHash: requestHash(c.name, req.body) } : undefined
      });
      if (result.kind !== "success") res.locals.billingNotCharged = true;
      switch (result.kind) {
        case "success":
          res.locals.channel = result.authorization.rail;
          if (deps.classifyResult) res.locals.dataSource = deps.classifyResult(c.name, result.data);
          setBillingHeaders(res, result.body.meta.billing);
          res.json(result.body);
          return;
        case "replay":
          res.locals.billingNotCharged = true;
          res.setHeader("Idempotent-Replay", "true");
          setBillingHeaders(res, (result.body as { meta?: { billing?: Record<string, unknown> } })?.meta?.billing);
          res.status(result.status).json(result.body);
          return;
        case "failed":
          res.locals.channel = result.authorization.rail;
          res.locals.billingNotCharged = true;
          res.setHeader("X-Rafid-Billing-Rail", result.authorization.rail);
          res.setHeader("X-Rafid-Charge", "0.00");
          if (result.refunded && result.authorization.transactionId) res.setHeader("X-Rafid-Refunded-Transaction-Id", result.authorization.transactionId);
          throw result.error;
        case "idempotency_conflict":
          return fail(res, 409, "idempotency_conflict", "This Idempotency-Key was already used for this tool with a different request body.");
        case "idempotency_in_progress":
          return fail(res, 409, "idempotency_in_progress", "A request with this Idempotency-Key is still being processed; retry shortly.", {}, { "Retry-After": "1" });
        case "insufficient":
          if (decision.externalFallback) { rewrite(req, res, decision.externalFallback, c); return next(); }
          return fail(res, 402, result.reason, result.reason === "insufficient_credits"
            ? `The account balance does not cover ${c.name}. Add prepaid credit or pay with another enabled method.`
            : result.reason === "no_active_subscription" ? "This account has no active subscription." : "The subscription allowance for this billing period is exhausted.", {
            tool: c.name, price: money(result.priceMicros), balance: money(result.balanceMicros),
            ...(result.subscription ? { subscription: subscriptionView(result.subscription) } : {}),
            paymentOptions: enabledPaymentMethodIds(deps.config), paymentMethods: paymentMethodsPath
          });
      }
    } catch (error) { next(error); }
  };
}

/** Authenticates `Authorization: Bearer raf_…` for the customer account endpoints. */
function requireBillingKey(engine: BillingEngine): RequestHandler {
  return async (req, res, next) => {
    try {
      const alt = req.header("x-rafid-api-key");
      const key = bearerBillingKey(req.header("authorization")) ?? (alt && looksLikeBillingKey(alt) ? alt : undefined);
      if (!key) return fail(res, 401, "api_key_required", "Send Authorization: Bearer raf_live_…", {}, { "WWW-Authenticate": `Bearer realm="rafid"` });
      const auth = await engine.authenticate(key);
      if (!auth.ok) return authFailure(res, auth);
      res.locals.billingAccount = auth.account satisfies BillingAccount;
      res.locals.billingKey = auth.key satisfies ApiKeyRecord;
      next();
    } catch (error) { next(error); }
  };
}

const send = (res: Response, data: unknown, status = 200) => res.status(status).json({ success: true, data, meta: { requestId: res.locals.requestId } });
const handle = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => async (req, res, next) => {
  try { await fn(req, res); }
  catch (error) {
    if (error instanceof BillingAdminError) return fail(res, error.status, error.code, error.message);
    next(error);
  }
};

/** GET /api/v1/account/{balance,usage,transactions} — the caller's own account, by API key. */
export function createAccountRoutes(deps: { engine: BillingEngine; limiter: RequestHandler }): Router {
  const router = Router();
  const auth = requireBillingKey(deps.engine);
  const acct = (res: Response) => (res.locals.billingAccount as BillingAccount).id;
  router.get(accountBasePath + "/balance", deps.limiter, auth, handle(async (_req, res) => send(res, await deps.engine.balanceView(acct(res)))));
  router.get(accountBasePath + "/usage", deps.limiter, auth, handle(async (req, res) => send(res, await deps.engine.usageView(acct(res), typeof req.query.since === "string" ? req.query.since : undefined))));
  router.get(accountBasePath + "/transactions", deps.limiter, auth, handle(async (req, res) => send(res, await deps.engine.ledgerView(acct(res), {
    limit: typeof req.query.limit === "string" ? Number(req.query.limit) || 50 : 50,
    before: typeof req.query.before === "string" ? req.query.before : undefined
  }))));
  return router;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * Internal billing administration. Protected by BILLING_ADMIN_SECRET (≥32 chars), presented as
 * `X-Billing-Admin-Key: <secret>` or `Authorization: Bearer <secret>` and compared in constant
 * time. Answers 503 until the secret is configured — never unauthenticated. Not part of the
 * public OpenAPI document, the capability registry, MCP or any discovery surface.
 */
export function createBillingAdminRoutes(deps: { engine: BillingEngine | null; adminSecret: string | null; limiter: RequestHandler }): Router {
  const router = Router();
  const expected = deps.adminSecret ? digest(deps.adminSecret) : null;
  router.use(billingAdminBasePath, deps.limiter, (req, res, next) => {
    if (!expected || !deps.engine) return fail(res, 503, "billing_admin_unavailable", !deps.engine ? "Unified billing is disabled (API_CREDITS_ENABLED / SUBSCRIPTIONS_ENABLED)." : "Billing admin is not configured (BILLING_ADMIN_SECRET is unset).");
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.header("authorization") ?? "")?.[1];
    const presented = digest(req.header("x-billing-admin-key") ?? bearer ?? "");
    if (!timingSafeEqual(presented, expected)) return fail(res, 401, "unauthorized", "A valid billing admin key is required");
    next();
  }, express.json({ limit: "16kb" }));
  const e = () => deps.engine!;
  const p = (req: Request, name: string) => String(req.params[name]);
  const body = (req: Request) => (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, any>;
  const b = billingAdminBasePath;
  router.post(b + "/accounts", handle(async (req, res) => send(res, await e().createAccount({ name: body(req).name, email: body(req).email, metadata: body(req).metadata }), 201)));
  router.get(b + "/accounts/:accountId", handle(async (req, res) => send(res, { ...(await e().balanceView(p(req, "accountId"))), apiKeys: await e().listApiKeys(p(req, "accountId")) })));
  router.post(b + "/accounts/:accountId/status", handle(async (req, res) => {
    const status = body(req).status;
    if (!["active", "suspended", "closed"].includes(status)) throw new BillingAdminError(400, "invalid_input", "status must be active, suspended or closed");
    const account = await e().store.getAccount(p(req, "accountId"));
    if (!account) throw new BillingAdminError(404, "account_not_found", "Billing account not found");
    await e().store.setAccountStatus(account.id, status);
    send(res, await e().balanceView(account.id));
  }));
  router.post(b + "/accounts/:accountId/api-keys", handle(async (req, res) => send(res, await e().createApiKey({ accountId: p(req, "accountId"), name: body(req).name, environment: body(req).environment, expiresAt: body(req).expiresAt }), 201)));
  router.get(b + "/accounts/:accountId/api-keys", handle(async (req, res) => send(res, await e().listApiKeys(p(req, "accountId")))));
  router.post(b + "/accounts/:accountId/api-keys/:keyId/revoke", handle(async (req, res) => send(res, await e().revokeApiKey(p(req, "accountId"), p(req, "keyId")))));
  router.post(b + "/accounts/:accountId/credits", handle(async (req, res) => send(res, await e().addCredit({ accountId: p(req, "accountId"), amount: String(body(req).amount ?? ""), reason: body(req).reason, externalTransactionId: body(req).externalTransactionId }), 201)));
  router.post(b + "/accounts/:accountId/adjustments", handle(async (req, res) => send(res, await e().adjustCredit({ accountId: p(req, "accountId"), amount: String(body(req).amount ?? ""), reason: String(body(req).reason ?? ""), externalTransactionId: body(req).externalTransactionId }), 201)));
  router.get(b + "/accounts/:accountId/ledger", handle(async (req, res) => send(res, await e().ledgerView(p(req, "accountId"), { limit: Number(req.query.limit) || 50, before: typeof req.query.before === "string" ? req.query.before : undefined }))));
  router.get(b + "/accounts/:accountId/usage", handle(async (req, res) => send(res, await e().usageView(p(req, "accountId"), typeof req.query.since === "string" ? req.query.since : undefined))));
  router.put(b + "/accounts/:accountId/subscription", handle(async (req, res) => send(res, await e().assignSubscription({ accountId: p(req, "accountId"), plan: String(body(req).plan ?? ""), includedUsd: body(req).includedUsd === undefined ? undefined : String(body(req).includedUsd) }))));
  router.delete(b + "/accounts/:accountId/subscription", handle(async (req, res) => send(res, await e().cancelSubscription(p(req, "accountId")))));
  router.post(b + "/maintenance/release-stale", handle(async (_req, res) => send(res, await e().releaseStale())));
  return router;
}
