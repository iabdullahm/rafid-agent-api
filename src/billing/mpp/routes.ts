import { Router, type Request, type RequestHandler, type Response } from "express";
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
  sessionClose: mppBasePath + "/sessions/:sessionId/close"
} as const;

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
export function createMppRoutes(deps: { service: MppService; limiter: RequestHandler }): Router {
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

  router.post(mppRoutes.charge, deps.limiter, mppJsonBody(), handle((req, res) => service.charge({
    tool: String(req.params.tool), body: req.body, authorization: paymentAuthorization(req), url: requestUrl(req), requestId: requestIdOf(res)
  })));
  router.post(mppRoutes.sessions, deps.limiter, mppJsonBody(), handle((req, res) => service.createSession({
    body: req.body, authorization: paymentAuthorization(req), url: requestUrl(req), requestId: requestIdOf(res)
  })));
  router.get(mppRoutes.session, deps.limiter, handle((req, res) => service.getSession({ sessionId: String(req.params.sessionId), requestId: requestIdOf(res) })));
  router.post(mppRoutes.sessionTool, deps.limiter, mppJsonBody(), handle((req, res) => service.callTool({
    sessionId: String(req.params.sessionId), tool: String(req.params.tool), body: req.body,
    authorization: paymentAuthorization(req), idempotencyKey: req.header("idempotency-key"), url: requestUrl(req), requestId: requestIdOf(res)
  })));
  router.post(mppRoutes.sessionClose, deps.limiter, mppJsonBody({ optional: true }), handle((req, res) => service.closeSession({
    sessionId: String(req.params.sessionId), authorization: paymentAuthorization(req), requestId: requestIdOf(res)
  })));
  return router;
}

export function createMppDisabledRoutes(): Router {
  const router = Router();
  router.all(mppBasePath + "/*path", (_req, res) => {
    res.status(404).json({ success: false, error: { code: "MPP_DISABLED", message: "MPP (Machine Payments Protocol) payments are not enabled on this deployment. See GET /api/v1/mpp/status; use x402 or L402 instead." }, meta: { requestId: res.locals.requestId } });
  });
  return router;
}
