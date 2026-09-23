import express, { type RequestHandler } from "express";
import { capabilities } from "../domain/capabilities.js";
import { runCapabilityPreview } from "../preview/service.js";
import { ApiError } from "../utils/errors.js";

/**
 * Free Preview (src/preview/) REST route family: `POST /api/v1/preview/:capability` (and
 * `POST /v1/preview/:capability`, for prefix parity with the paid REST routes registered in
 * app.ts). One generic route handles every capability — never a per-capability
 * `<tool>_preview` route — by delegating straight to runCapabilityPreview() (src/preview/service.ts),
 * which looks the capability up in the single `capabilities` registry and calls its optional
 * `preview()` function.
 *
 * Deliberately entirely unauthenticated and FREE: no `apiKeyAuth`, no `store.admit`/`complete`,
 * no `billing.authorize`, and no x402/L402/MPP payment gate. This module never imports
 * BillingService or any payment-gate builder — a preview call can never trigger payment,
 * blockchain settlement, invoice creation or paid usage consumption, by construction (there is
 * nothing here that could).
 */
export const previewBasePath = "/api/v1/preview";

const defaultJsonParser = express.json({ limit: "32kb" });
const jsonParsersByLimit = new Map<string, RequestHandler>();
function jsonParserForLimit(limit: string): RequestHandler {
  if (limit === "32kb") return defaultJsonParser;
  if (!jsonParsersByLimit.has(limit)) jsonParsersByLimit.set(limit, express.json({ limit }));
  return jsonParsersByLimit.get(limit)!;
}

/** Per-capability JSON body limit (AgentCapability.requestBodyLimit), resolved dynamically from
 *  the `:capability` route param — mirrors app.ts's parseJsonFor(c), but this one route family
 *  serves every capability behind a single path, so the right limit can't be chosen until the
 *  request arrives. An unrecognized capability name falls back to the default 32kb parser;
 *  runCapabilityPreview() itself reports 404 for it once the body has been read. */
const parseJsonForCapability: RequestHandler = (req, res, next) => {
  const capability = capabilities.find(c => c.name === req.params.capability);
  return jsonParserForLimit(capability?.requestBodyLimit ?? "32kb")(req, res, next);
};

/** Rejects a non-JSON body the same way the paid REST routes do (415), but — unlike those routes
 *  — only when a body was actually sent: many previews (e.g. a company-name lookup) have nothing
 *  to post beyond the same JSON the paid capability takes, but a caller doing a bodiless
 *  preview-existence probe should not be forced to send `Content-Type: application/json` with an
 *  empty body. */
const requireJsonIfPresent: RequestHandler = (req, _res, next) => {
  const hasBody = (req.header("content-length") ?? "0") !== "0";
  if (!hasBody || req.is("application/json")) return next();
  next(new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json"));
};

/** Mounts the generic preview route under both `/api/v1` and `/v1`. `options.limiter` is an
 *  independent rate-limiter instance (app.ts creates one per route group, e.g. discoveryLimiter/
 *  x402Limiter) so a burst of preview calls can never exhaust another route family's budget, and
 *  vice versa. */
export function createPreviewRoutes(options: { limiter: RequestHandler }): express.Router {
  const router = express.Router();
  for (const prefix of ["/api/v1", "/v1"]) {
    router.post(`${prefix}/preview/:capability`, options.limiter, requireJsonIfPresent, parseJsonForCapability,
      async (req, res, next) => {
        try {
          const result = await runCapabilityPreview(String(req.params.capability), req.body ?? {});
          res.json({ success: true, data: result, meta: { requestId: res.locals.requestId } });
        } catch (error) { next(error); }
      });
  }
  return router;
}
