import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { ApiError } from "../utils/errors.js";
import type { PartnerRepository, PropertyDataPartner } from "../domain/oman/partners.js";

/**
 * Section 4: authenticates a partner's ingestion request via a per-partner bearer token in the
 * `X-Partner-Token` header — deliberately NOT the normal customer `X-API-Key` (middleware/auth.ts)
 * or the `X-Internal-Api-Key` used by the internal status/partners endpoints below. A partner
 * token authenticates ONLY as that one partner and can only ever act on that partner's own
 * records (its partnerId is taken from the authenticated result, never from the request body —
 * see importPipeline.ts's doc comment on why attribution is never trusted from row data).
 *
 * Sets `res.locals.partner` (a `PropertyDataPartner` — never the token or its digest) for the
 * route handler.
 */
export function requirePartnerAuth(partnerRepository: PartnerRepository): RequestHandler {
  return async (req, res, next) => {
    const token = req.header("x-partner-token");
    if (!token) { next(new ApiError(401, "UNAUTHORIZED", "A valid X-Partner-Token header is required")); return; }
    try {
      const partner = await partnerRepository.authenticate(token);
      if (!partner) { next(new ApiError(401, "UNAUTHORIZED", "Invalid, disabled or revoked partner token")); return; }
      res.locals.partner = partner satisfies PropertyDataPartner;
      next();
    } catch {
      next(new ApiError(503, "SERVICE_UNAVAILABLE", "Partner storage unavailable"));
    }
  };
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * Section 9/11: a single, shared secret (`MARKET_DATA_INTERNAL_API_KEY`) gating the internal
 * aggregate-status and per-partner-health endpoints — deliberately distinct from every partner
 * token (a partner should never be able to see cross-partner aggregate data or any other
 * partner's health) and from the normal customer API key (this is infrastructure, not a billed
 * agent capability — Section 15). Compares by digest with a constant-time comparison, exactly
 * like middleware/auth.ts's apiKeyAuth(), so neither the key's length nor its value can be
 * inferred from response timing.
 */
export function requireInternalAuth(internalApiKey: string | null): RequestHandler {
  const expected = internalApiKey ? digest(internalApiKey) : null;
  return (req, res, next) => {
    if (!expected) { next(new ApiError(503, "SERVICE_UNAVAILABLE", "Internal market-data endpoints are not configured (MARKET_DATA_INTERNAL_API_KEY is unset)")); return; }
    const presented = digest(req.header("x-internal-api-key") ?? "");
    if (!timingSafeEqual(presented, expected)) { next(new ApiError(401, "UNAUTHORIZED", "A valid X-Internal-Api-Key header is required")); return; }
    next();
  };
}
