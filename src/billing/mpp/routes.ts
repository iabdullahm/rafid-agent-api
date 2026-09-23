import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request, type RequestHandler, type Response } from "express";
import { createRateLimiter } from "../../middleware/rateLimit.js";
import { capabilities } from "../../domain/capabilities.js";
import { classifyDataSource } from "../../analytics/dataSource.js";
import type { CapabilityName } from "../catalog.js";
import { describeMppConfig, type MppConfig } from "./config.js";
import { mppJsonBody, paymentAuthorization, requestIdOf, requestUrl, sendMppResult } from "./middleware.js";
import type { MppResult, MppService } from "./service.js";

export const mppBasePath = "/api/v1/mpp";

/** Route templates, defined once so app.ts, OpenAPI and discovery never disagree. */
export const mppRoutes = {
  info: mppBasePath,
  status: mppBasePath + "/status",
  charge: mppBasePath + "/charge/:tool",
  sessions: mppBasePath + "/sessions",
  session: mppBasePath + "/sessions/:sessionId",
  sessionTool: mppBasePath + "/sessions/:sessionId/tools/:tool",
  sessionClose: mppBasePath + "/sessions/:sessionId/close",
  /** Internal, secret-protected maintenance (Vercel Cron). Not part of the public API/OpenAPI. */
  maintenance: mppBasePath + "/internal/maintenance"
} as const;

/** The caller's network address (X-Forwarded-For first hop behind Vercel, else the socket). */
export function clientAddress(req: Request): string {
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? "unknown";
}

/** Pseudonymous client key for the pending-session abuse cap: HMAC(secret, address). The raw
 *  IP is never stored; a wallet address is never used (it is unproven before the channel opens). */
export function mppClientKey(secret: string, req: Request): string {
  return createHmac("sha256", secret).update("rafid:mpp:client:" + clientAddress(req)).digest("hex").slice(0, 32);
}

/** Per-client limiter for POST /api/v1/mpp/sessions (MPP_SESSION_CREATE_RATE_LIMIT_MAX per
 *  minute), built on the app's existing fixed-window limiter. */
export function createMppSessionCreateLimiter(config: MppConfig): RequestHandler {
  return createRateLimiter({ windowMs: 60_000, max: config.sessionCreateRateLimitMax, keyGenerator: clientAddress });
}

/** Constant-time Bearer check for the maintenance endpoint. */
export function maintenanceAuthorized(secret: string, header: string | undefined): boolean {
  if (!secret || !header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const a = createHmac("sha256", "rafid:mpp:maint").update(m[1]!).digest();
  const b = createHmac("sha256", "rafid:mpp:maint").update(secret).digest();
  return timingSafeEqual(a, b);
}

/** GET /api/v1/mpp — protocol + pricing information, always mounted (like GET /api/v1/x402 and
 *  GET /api/v1/l402), so an agent can learn how to pay before deciding to. Prices come from the
 *  capability registry; no secret is ever included. */
export function buildMppInfo(config: MppConfig, priceUsd: (tool: CapabilityName) => number) {
  const d = describeMppConfig(config);
  return {
    protocol: "mpp",
    name: "Machine Payments Protocol",
    spec: "https://mpp.dev",
    httpAuthScheme: "Payment (IETF draft-ryan-httpauth-payment)",
    sdk: "mppx",
    enabled: config.enabled,
    modes: d.modes,
    currency: "USD",
    charge: d.charge,
    session: d.session,
    authorization: "Authorization: Payment <credential>",
    receiptHeader: "Payment-Receipt",
    idempotency: "Idempotency-Key header on session tool calls (required unless MPP_REQUIRE_IDEMPOTENCY=false).",
    endpoints: {
      charge: "POST " + mppBasePath + "/charge/{tool}",
      createSession: "POST " + mppBasePath + "/sessions",
      getSession: "GET " + mppBasePath + "/sessions/{sessionId}",
      callTool: "POST " + mppBasePath + "/sessions/{sessionId}/tools/{tool}",
      closeSession: "POST " + mppBasePath + "/sessions/{sessionId}/close"
    },
    tools: capabilities.map(c => ({ name: c.name, price: priceUsd(c.name), currency: "USD", chargeEndpoint: `${mppBasePath}/charge/${c.name}` }))
  };
}

/** GET /api/v1/mpp/status — small, factual, secret-free runtime status. */
export function buildMppStatus(config: MppConfig) {
  const d = describeMppConfig(config);
  return {
    enabled: config.enabled,
    configured: config.enabled,
    provider: d.provider,
    modes: d.modes,
    chargeMethods: d.charge ? d.charge.methods.map(m => `${m.method}/${m.intent}`) : [],
    sessionMethod: d.session ? "tempo/session" : null,
    tempoNetwork: config.enabled ? config.tempo.network : null,
    testnet: config.enabled ? config.tempo.testnet : null,
    secretKeyConfigured: Buffer.byteLength(config.secretKey, "utf8") >= 32,
    payeeKeyConfigured: Boolean(config.tempo.privateKey),
    mcp: d.mcp,
    paymentEnforcement: config.enabled
  };
}

/**
 * Mounts the MPP route family. Only called by app.ts when MPP_ENABLED=true; when disabled, a
 * small router answering every /api/v1/mpp/* path (except the always-on info/status routes)
 * with a clear 404 MPP_DISABLED is mounted instead (createMppDisabledRoutes below).
 *
 * Usage/analytics: a route marks res.locals.toolName/channel only when a paid tool actually ran
 * (the gate-first-then-mark discipline x402 and L402 already follow), so an unpaid 402 challenge
 * is never recorded as a failed tool invocation.
 */
export function createMppRoutes(deps: { service: MppService; limiter: RequestHandler; sessionCreateLimiter?: RequestHandler; bodyLimitFor?: (tool: string) => string | undefined }): Router {
  const toolBody = mppJsonBody({ limitFor: req => deps.bodyLimitFor?.(String(req.params.tool)) });
  const router = Router();
  const { service } = deps;

  const finish = (res: Response, result: MppResult) => {
    if (result.executed) {
      res.locals.toolName = result.executed.tool;
      res.locals.channel = result.executed.channel;
      if (result.executed.success && result.executed.data !== undefined) res.locals.dataSource = classifyDataSource(result.executed.tool as CapabilityName, result.executed.data);
    }
    sendMppResult(res, result);
  };
  const handle = (fn: (req: Request, res: Response) => Promise<MppResult>): RequestHandler => async (req, res, next) => {
    try { finish(res, await fn(req, res)); } catch (error) { next(error); }
  };

  // mppx's session client sends management credentials (close) as a body-less POST to the last
  // URL it used — so every session route recognizes them BEFORE body parsing. A management
  // credential never runs a tool.
  const management = (withSessionId: boolean): RequestHandler => async (req, res, next) => {
    try {
      const result = await service.sessionManagement({
        sessionId: withSessionId ? String(req.params.sessionId) : undefined,
        authorization: paymentAuthorization(req), url: requestUrl(req), requestId: requestIdOf(res)
      });
      if (result) { sendMppResult(res, result); return; }
      next();
    } catch (error) { next(error); }
  };
  // Session creation writes a row before any payment, so it gets its own, tighter limiter (on
  // top of the route-family limiter) plus the per-client pending cap enforced in the service.
  const createLimiter = deps.sessionCreateLimiter ?? createMppSessionCreateLimiter(service.config);

  router.post(mppRoutes.charge, deps.limiter, toolBody, handle((req, res) => service.charge({
    tool: String(req.params.tool), body: req.body, authorization: paymentAuthorization(req), url: requestUrl(req), requestId: requestIdOf(res)
  })));
  router.post(mppRoutes.sessions, deps.limiter, management(false), createLimiter, mppJsonBody(), handle((req, res) => service.createSession({
    body: req.body, authorization: paymentAuthorization(req), url: requestUrl(req), requestId: requestIdOf(res),
    clientKey: mppClientKey(service.config.secretKey, req)
  })));
  router.get(mppRoutes.session, deps.limiter, handle((req, res) => service.getSession({ sessionId: String(req.params.sessionId), requestId: requestIdOf(res) })));
  router.post(mppRoutes.sessionTool, deps.limiter, management(true), toolBody, handle((req, res) => service.callTool({
    sessionId: String(req.params.sessionId), tool: String(req.params.tool), body: req.body,
    authorization: paymentAuthorization(req), idempotencyKey: req.header("idempotency-key"), url: requestUrl(req), requestId: requestIdOf(res)
  })));
  router.post(mppRoutes.sessionClose, deps.limiter, mppJsonBody({ optional: true }), handle((req, res) => service.closeSession({
    sessionId: String(req.params.sessionId), authorization: paymentAuthorization(req), requestId: requestIdOf(res), url: requestUrl(req)
  })));
  // Maintenance: expire overdue pending/active sessions, reconcile settlements, purge old unpaid
  // rows. Vercel Cron calls it with GET + "Authorization: Bearer $CRON_SECRET". Idempotent and
  // safe to run concurrently; no in-process scheduler exists.
  const maintenance: RequestHandler = async (req, res, next) => {
    const secret = service.config.maintenanceSecret;
    const requestId = requestIdOf(res);
    res.setHeader("Cache-Control", "no-store");
    if (!secret) { res.status(503).json({ success: false, error: { code: "MPP_MAINTENANCE_NOT_CONFIGURED", message: "Set MPP_MAINTENANCE_SECRET (or CRON_SECRET) to enable MPP maintenance." }, meta: { requestId } }); return; }
    if (!maintenanceAuthorized(secret, req.header("authorization"))) { res.status(401).json({ success: false, error: { code: "MPP_MAINTENANCE_UNAUTHORIZED", message: "Unauthorized." }, meta: { requestId } }); return; }
    try { res.status(200).json({ success: true, data: await service.maintenance(), meta: { requestId } }); } catch (error) { next(error); }
  };
  router.get(mppRoutes.maintenance, deps.limiter, maintenance);
  router.post(mppRoutes.maintenance, deps.limiter, maintenance);
  return router;
}

export function createMppDisabledRoutes(): Router {
  const router = Router();
  router.all(mppBasePath + "/*path", (_req, res) => {
    res.status(404).json({ success: false, error: { code: "MPP_DISABLED", message: "MPP (Machine Payments Protocol) payments are not enabled on this deployment. See GET /api/v1/mpp/status; use x402 or L402 instead." }, meta: { requestId: res.locals.requestId } });
  });
  return router;
}
