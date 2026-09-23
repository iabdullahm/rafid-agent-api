import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { previewCostTier } from "./classification.js";

/**
 * Free Preview — dedicated rate limiting.
 *
 * POST /api/v1/preview/:capability is intentionally free and unauthenticated (see
 * api/previewRoutes.ts's doc comment) — which is exactly why it needs its OWN request budget,
 * entirely isolated from every paid route group's limiter (discoveryLimiter/x402Limiter/
 * mcpLimiter/l402Limiter/mppLimiter in api/app.ts, and the paid REST capability routes'
 * options.rateLimiter): a burst of free preview traffic must never be able to exhaust a paid
 * capability's budget, and a customer legitimately hammering the paid API must never be throttled
 * by preview traffic sharing its counter.
 *
 * Two independent windows apply together (both must pass), reusing middleware/rateLimit.ts's
 * existing fixed-window limiter factory for each: a short one (default 60/min) that catches
 * bursts, and a longer one (default 300/hour) that catches sustained abuse a caller could otherwise
 * spread thin enough to dodge the per-minute window. Both are configurable
 * (PREVIEW_RATE_LIMIT_PER_MINUTE / PREVIEW_RATE_LIMIT_PER_HOUR — config/env.ts).
 *
 * A third, narrower limiter applies only to "expensive"-tier capabilities (currently
 * document_facts_extract and invoice_anomaly_check — see classification.ts): its own tighter
 * budget, keyed per-capability so one expensive capability's abuse can't spend another's budget,
 * and per-client, on top of (never instead of) the two global windows above.
 */

const PREVIEW_RATE_LIMITED_BODY = { error: "preview_rate_limited" } as const;

export type PreviewLimitedHook = (req: Request, retryAfterSeconds: number) => void;

function sendPreviewRateLimited(res: import("express").Response, retryAfterSeconds: number): void {
  res.status(429).json({ ...PREVIEW_RATE_LIMITED_BODY, retryAfterSeconds });
}

/**
 * Client identity for the preview rate limiter, in priority order:
 *   1. A valid, configured X-API-Key (this repo's existing REST credential — see
 *      middleware/auth.ts's apiKeyAuth) if one is presented. Preview never REQUIRES a key (it
 *      stays unauthenticated), but honoring one when present gives a real customer sharing a
 *      corporate NAT/gateway IP their own budget instead of sharing one bucket with every other
 *      caller behind that IP.
 *   2. The caller's IP address (X-Forwarded-For's first hop, or the socket address) — the same
 *      convention middleware/rateLimit.ts's own defaultKeyGenerator already uses for every other
 *      route group in this app (see attribution.ts's clientIp() doc comment for why trusting
 *      X-Forwarded-For's first hop is this deployment's documented, intentional choice, not an
 *      oversight).
 *
 * Deliberately does NOT key on any other self-reported, spoofable header (e.g. X-Client-Name) as
 * a "trusted agent identity" tier: unlike an X-API-Key (verified against this deployment's actual
 * configured keys), a self-reported client name is exactly the kind of header the spec's own
 * caution ("do not blindly trust spoofable headers") warns against trusting for a rate-limit KEY
 * — keying on it would let an attacker multiply their effective budget for free by rotating a
 * fake identity on every request, which is the opposite of what this limiter exists to prevent.
 */
export function createPreviewClientKeyGenerator(apiKeys: readonly string[]): (req: Request) => string {
  const digest = (key: string) => createHash("sha256").update(key).digest();
  const accepted = apiKeys.map(digest);
  return (req: Request): string => {
    const presented = req.header("x-api-key");
    if (presented) {
      const presentedDigest = digest(presented);
      for (const key of accepted) {
        if (timingSafeEqual(presentedDigest, key)) return `apikey:${presentedDigest.toString("hex").slice(0, 16)}`;
      }
    }
    const forwarded = req.header("x-forwarded-for");
    const ip = forwarded ? forwarded.split(",")[0]!.trim() : (req.socket.remoteAddress ?? "unknown");
    return `ip:${ip}`;
  };
}

export interface PreviewRateLimitConfig {
  perMinute: number;
  perHour: number;
  apiKeys: readonly string[];
}

/** The two global windows (per-minute, per-hour), both keyed by the same client-identity
 *  priority above, both isolated in their own Map (see middleware/rateLimit.ts) from every other
 *  limiter in this app. Returns the exact `{"error":"preview_rate_limited","retryAfterSeconds":N}`
 *  body the Free Preview production-readiness spec asks for, with a Retry-After header (already
 *  set by createRateLimiter before onLimited runs). */
export function createPreviewGlobalRateLimiters(config: PreviewRateLimitConfig, onPreviewLimited?: PreviewLimitedHook): RequestHandler[] {
  const keyGenerator = createPreviewClientKeyGenerator(config.apiKeys);
  const onLimited = (req: Request, res: import("express").Response, info: { retryAfterSeconds: number }) => {
    sendPreviewRateLimited(res, info.retryAfterSeconds);
    onPreviewLimited?.(req, info.retryAfterSeconds);
  };
  return [
    createRateLimiter({ windowMs: 60_000, max: config.perMinute, keyGenerator, onLimited }),
    createRateLimiter({ windowMs: 3_600_000, max: config.perHour, keyGenerator, onLimited })
  ];
}

/** "expensive"-tier capabilities (document_facts_extract, invoice_anomaly_check — see
 *  classification.ts) get a materially tighter budget on top of the global windows above, keyed
 *  per-capability so hammering one never spends another's budget. Not configurable via env
 *  (deliberately: this is an internal abuse-protection multiplier, not an operator-facing knob —
 *  see the Free Preview production-readiness report for why "don't over-engineer" applies here). */
const EXPENSIVE_TIER_PER_MINUTE = 15;
const EXPENSIVE_TIER_PER_HOUR = 100;

export function createPreviewExpensiveTierRateLimiter(config: Pick<PreviewRateLimitConfig, "apiKeys">, onPreviewLimited?: PreviewLimitedHook): RequestHandler {
  const baseKeyGenerator = createPreviewClientKeyGenerator(config.apiKeys);
  const keyGenerator = (req: Request): string => `${baseKeyGenerator(req)}:${req.params.capability ?? "unknown"}`;
  const onLimited = (req: Request, res: import("express").Response, info: { retryAfterSeconds: number }) => {
    sendPreviewRateLimited(res, info.retryAfterSeconds);
    onPreviewLimited?.(req, info.retryAfterSeconds);
  };
  const perMinute = createRateLimiter({ windowMs: 60_000, max: EXPENSIVE_TIER_PER_MINUTE, keyGenerator, onLimited });
  const perHour = createRateLimiter({ windowMs: 3_600_000, max: EXPENSIVE_TIER_PER_HOUR, keyGenerator, onLimited });
  // Only applies to expensive-tier capabilities; every other capability passes straight through —
  // a single middleware so previewRoutes.ts doesn't need capability-aware branching of its own.
  return (req, res, next) => {
    const capability = typeof req.params.capability === "string" ? req.params.capability : "";
    if (previewCostTier(capability) !== "expensive") return next();
    perMinute(req, res, error => { if (error) return next(error); perHour(req, res, next); });
  };
}
