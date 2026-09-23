import { getRiskLiveChecksEnabled } from "../intelligence/config.js";

/**
 * Env-var configuration for oman_supplier_check — same plain `process.env` pattern as
 * src/intelligence/config.ts / src/business-data/config.ts, with every live/networked source OFF
 * by default so a fresh deployment and `npm test`'s generic per-capability loops (which call
 * `c.execute(c.example)` with no way to inject mocks) never make a real network call.
 *
 * Live sources reuse the switches operators already set for the Rafid Agent Intelligence
 * capabilities — no new "turn it on" flag to forget:
 *  - Website inspection + sanctions lists:  RISK_LIVE_CHECKS_ENABLED=true
 *  - Public-web risk signals:               WEB_SEARCH_PROVIDER=tavily (+ TAVILY_API_KEY)
 *  - Company identity:                      OMAN_BUSINESS_DATA_MODE (the existing registry switch)
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function ttl(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name] ? Number(env[name]) : NaN;
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** Cache TTLs per evidence type (spec: identity 7–30 days, website 1–7 days, sanctions shorter). */
export function getSupplierCacheTtls(env: NodeJS.ProcessEnv = process.env) {
  return {
    identityMs: ttl(env, "SUPPLIER_IDENTITY_CACHE_TTL_MS", 7 * DAY),
    websiteMs: ttl(env, "SUPPLIER_WEBSITE_CACHE_TTL_MS", 3 * DAY),
    sanctionsMs: ttl(env, "SUPPLIER_SANCTIONS_CACHE_TTL_MS", 12 * HOUR),
    publicRiskMs: ttl(env, "SUPPLIER_PUBLIC_RISK_CACHE_TTL_MS", 1 * DAY)
  };
}

export function getSupplierWebsiteChecksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getRiskLiveChecksEnabled(env);
}

// Sanctions-list configuration moved to src/shared/sanctions/config.ts (shared with
// company_reputation_check); re-exported unchanged for existing callers.
export { getSanctionsProviderIds, getUnSanctionsListUrl, getCslApiUrl, getCslApiKey, type SanctionsProviderId } from "../shared/sanctions/config.js";

/** Evidence cache backend: "postgres" when a database URL is available (SUPPLIER_EVIDENCE_DATABASE_URL,
 *  falling back to DATABASE_URL — same fallback convention as ANALYTICS_DATABASE_URL), else
 *  in-process memory. SUPPLIER_EVIDENCE_STORE=memory forces memory. */
export function getSupplierEvidenceDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  if ((env.SUPPLIER_EVIDENCE_STORE ?? "").trim().toLowerCase() === "memory") return null;
  return env.SUPPLIER_EVIDENCE_DATABASE_URL?.trim() || env.DATABASE_URL?.trim() || null;
}
