import type { Request, RequestHandler } from "express";
import { ApiError } from "../utils/errors.js";

export interface RateLimitOptions {
  /** Fixed-window size in milliseconds. */
  windowMs: number;
  /** Requests allowed per key, per window. */
  max: number;
  /** Defaults to the caller's IP address (X-Forwarded-For's first hop, or the socket address). */
  keyGenerator?: (req: Request) => string;
  /** Overrides the default `next(new ApiError(429, "RATE_LIMITED", ...))` behavior for a limited
   *  request — used by preview/rateLimit.ts to return the Free Preview's own documented 429 body
   *  shape (`{"error":"preview_rate_limited","retryAfterSeconds":N}`) instead of this app's
   *  generic `{"error":{"code":...}}` envelope. Standard rate-limit headers (X-RateLimit-*,
   *  Retry-After) are already set on `res` before this is called; the hook is responsible for
   *  actually sending the response (or calling `next(...)` itself) — this function does nothing
   *  further once `onLimited` returns. */
  onLimited?: (req: Request, res: import("express").Response, info: { limit: number; windowMs: number; retryAfterSeconds: number }) => void;
}

/**
 * A simple, in-memory, fixed-window rate limiter for public, unauthenticated agent endpoints
 * (discovery, x402, remote MCP — see api/app.ts for where each is mounted). Every call to this
 * factory creates its own independent counter map, so giving each route group its own limiter
 * instance gives each group its own budget: a burst of x402 calls can't lock an agent out of
 * discovery or remote MCP, and vice versa.
 *
 * This is a per-process, best-effort default, not a distributed limiter: on a serverless
 * platform running several concurrent instances (Vercel), each instance enforces the limit
 * independently, so the effective ceiling across a whole deployment can be a multiple of `max`
 * during traffic spread across instances. That is an honest trade-off for a "reasonable
 * configurable default" with no new infrastructure dependency, not a claim of a hard global
 * cap — a production deployment expecting many concurrent instances should swap this for a
 * shared-store limiter (e.g. Upstash Redis) behind the same `RequestHandler` shape; nothing
 * else in this app needs to change to do that.
 */
export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  const { windowMs, max } = options;
  const keyGenerator = options.keyGenerator ?? defaultKeyGenerator;
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const key = keyGenerator(req);
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - entry.count)));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));
    if (entry.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      if (options.onLimited) { options.onLimited(req, res, { limit: max, windowMs, retryAfterSeconds }); return; }
      next(new ApiError(429, "RATE_LIMITED", "Too many requests; slow down and retry later"));
      return;
    }
    // Bounded, occasional sweep of expired entries so long-running processes don't leak memory
    // for keys that stop sending traffic — cheaper than a timer, and only runs once the map has
    // grown large enough to matter.
    if (hits.size > 10000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    next();
  };
}

function defaultKeyGenerator(req: Request): string {
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? "unknown";
}

/** A no-op middleware, used when RATE_LIMIT_ENABLED=false (development/tests). */
export const disabledRateLimiter: RequestHandler = (_req, _res, next) => next();
