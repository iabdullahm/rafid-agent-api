import express, { type RequestHandler } from "express";
import { capabilities } from "../domain/capabilities.js";
import { runCapabilityPreview, type PreviewRuntimeOptions } from "../preview/service.js";
import type { CapabilityPreviewResult, CapabilityPreviewStatus } from "../preview/types.js";
import { ApiError } from "../utils/errors.js";
import { ZodError } from "zod";
import { hasFingerprintSupport, computePreviewFingerprint } from "../preview/fingerprint.js";
import { previewCacheKey, previewCacheTtlSeconds, type PreviewCache } from "../preview/cache.js";
import { recordPreviewEvent } from "../preview/analytics.js";
import { extractClientContext } from "../analytics/attribution.js";
import type { AnalyticsRepository, PreviewEventType } from "../analytics/types.js";

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
 *
 * Production hardening (rate limiting, response caching, funnel analytics) is layered on here
 * without touching that guarantee: `options.limiters` are applied before any of this route's own
 * logic runs (see preview/rateLimit.ts), the cache (preview/cache.ts) stores and replays already-
 * computed CapabilityPreviewResult objects rather than changing what gets computed, and analytics
 * recording (preview/analytics.ts) is fire-and-forget and fails open — the cache and analytics
 * layers are also entirely optional (a `createPreviewRoutes()` call with neither still serves
 * correct, uncached, unrecorded previews).
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

/** Maps a completed (non-throwing) CapabilityPreviewResult's status to the funnel event it
 *  represents — see analytics/types.ts's PreviewEventType doc comment. */
function eventTypeForStatus(status: CapabilityPreviewStatus): PreviewEventType | null {
  if (status === "available") return "preview_available";
  if (status === "limited") return "preview_limited";
  if (status === "unavailable") return "preview_unavailable";
  return null; // "invalid_input" never reaches here — schema validation throws before a status exists.
}

export interface CreatePreviewRoutesOptions {
  /** Rate-limit middleware to run before anything else — app.ts supplies the dedicated Free
   *  Preview limiters (preview/rateLimit.ts): the two global windows plus the expensive-tier
   *  limiter, or an empty array when RATE_LIMIT_ENABLED=false. Applied in order; any one of them
   *  can end the request with a 429 before the rest of this route ever runs. */
  limiters: RequestHandler[];
  /** Optional response cache (preview/cache.ts) — omit to always compute a fresh preview. */
  cache?: PreviewCache;
  /** Overrides every capability's cache TTL bucket uniformly (config/env.ts's
   *  PREVIEW_CACHE_TTL_SECONDS); null (default) uses each capability's own bucket. */
  cacheTtlOverrideSeconds?: number | null;
  /** HMAC key for preview/fingerprint.ts's computePreviewFingerprint(); null (default) falls back
   *  to a plain SHA-256. */
  fingerprintSecret?: string | null;
  /** Optional analytics repository — omit to skip all Free Preview funnel event recording. */
  analyticsRepository?: AnalyticsRepository;
  /** Passed straight through to runCapabilityPreview() so fullResult.paymentMethods reflects real,
   *  currently-enabled payment rails (see preview/service.ts, billing/paymentMethods.ts). */
  previewOptions?: PreviewRuntimeOptions;
  /** Called once per successful ("available"/"limited") preview response whose capability supports
   *  fingerprinting — lets app.ts feed preview/analytics.ts's PreviewConversionIndex without this
   *  route module needing to know that index exists. */
  onPreviewSeen?: (capabilityName: string, fingerprint: string) => void;
}

/** Mounts the generic preview route under both `/api/v1` and `/v1`. */
export function createPreviewRoutes(options: CreatePreviewRoutesOptions): express.Router {
  const router = express.Router();
  const cacheTtlOverride = options.cacheTtlOverrideSeconds ?? null;
  const fingerprintSecret = options.fingerprintSecret ?? null;
  for (const prefix of ["/api/v1", "/v1"]) {
    router.post(`${prefix}/preview/:capability`, ...options.limiters, requireJsonIfPresent, parseJsonForCapability,
      async (req, res, next) => {
        const capabilityName = String(req.params.capability);
        const repo = options.analyticsRepository;
        const client = repo ? extractClientContext(req) : undefined;
        if (repo) recordPreviewEvent(repo, { eventType: "preview_requested", toolName: capabilityName, client });

        // Fingerprinting/caching/conversion-tracking must never be able to turn into a 500 for
        // what would otherwise be a perfectly good preview — every one of the three is wrapped in
        // its own try/catch, independent of the try/catch around the actual preview computation
        // below, so a throwing cache or a throwing onPreviewSeen hook degrades to "run this
        // preview as if caching/correlation weren't configured at all", never an error response.
        const cacheable = Boolean(options.cache) && hasFingerprintSupport(capabilityName);
        let fingerprint: string | null = null;
        if (cacheable) {
          try { fingerprint = computePreviewFingerprint(capabilityName, req.body ?? {}, fingerprintSecret); }
          catch { fingerprint = null; }
        }
        const cacheKey = fingerprint ? previewCacheKey(capabilityName, fingerprint) : null;

        try {
          let result: CapabilityPreviewResult | undefined;
          let servedFromCache = false;
          if (cacheKey && options.cache) {
            let cached: CapabilityPreviewResult | undefined;
            try { cached = options.cache.get(cacheKey) as CapabilityPreviewResult | undefined; }
            catch { cached = undefined; } // cache unavailable -> fail open, treat exactly like a miss
            if (cached) {
              result = cached;
              servedFromCache = true;
              if (repo) recordPreviewEvent(repo, { eventType: "preview_cache_hit", toolName: capabilityName, requestFingerprint: fingerprint, client });
            } else if (repo) {
              recordPreviewEvent(repo, { eventType: "preview_cache_miss", toolName: capabilityName, requestFingerprint: fingerprint, client });
            }
          }

          if (!result) {
            result = await runCapabilityPreview(capabilityName, req.body ?? {}, options.previewOptions);
            if (cacheKey && options.cache) {
              try { options.cache.set(cacheKey, result, previewCacheTtlSeconds(capabilityName, cacheTtlOverride)); }
              catch { /* cache unavailable -> fail open; the response below is unaffected */ }
            }
          }

          res.setHeader("X-Preview-Cache", cacheable ? (servedFromCache ? "hit" : "miss") : "bypass");
          if (repo) {
            const eventType = eventTypeForStatus(result.status);
            if (eventType) recordPreviewEvent(repo, { eventType, toolName: capabilityName, requestFingerprint: fingerprint, client });
          }
          if (fingerprint && (result.status === "available" || result.status === "limited")) {
            try { options.onPreviewSeen?.(capabilityName, fingerprint); }
            catch { /* conversion-index unavailable -> fail open; never affects this response */ }
          }
          res.json({ success: true, data: result, meta: { requestId: res.locals.requestId } });
        } catch (error) {
          // "invalid" is specifically an input-validation failure (the same ZodError/400 a paid
          // route's own c.input.parse() would throw) — a 404 CAPABILITY_NOT_FOUND or any other
          // error is a different, unrelated outcome and is left unrecorded here (still returned to
          // the caller unchanged via next(error) either way).
          const isInvalidInput = error instanceof ZodError || (error instanceof ApiError && error.status === 400);
          if (repo && isInvalidInput) recordPreviewEvent(repo, { eventType: "preview_invalid", toolName: capabilityName, requestFingerprint: fingerprint, client });
          next(error);
        }
      });
  }
  return router;
}
