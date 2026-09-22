/**
 * Internal analytics layer config — read directly from process.env, exactly like
 * domain/oman/config.ts's getMarketDataInternalApiKey()/getOmanMarketDatabaseUrl() and
 * business-data/config.ts's getOmanBusinessDatabaseUrl(): this is infrastructure config, not
 * part of the per-request Config every capability's `execute(input)` shares (see config/env.ts —
 * deliberately NOT added to envSchema there).
 */

/** The shared secret gating GET /api/v1/internal/analytics/* (src/api/analyticsRoutes.ts) —
 *  deliberately distinct from MARKET_DATA_INTERNAL_API_KEY (a different internal surface with a
 *  different blast radius: analytics never exposes partner tokens or company data, but does
 *  expose coarse client-attribution and traffic-volume data an operator may want to scope
 *  separately) and from every customer/partner/admin credential. Returns null (never a default)
 *  when unset, so the analytics routes fail closed (503) rather than accepting no credential at
 *  all — see middleware/partnerAuth.ts's requireInternalAuth(), reused as-is here. */
export function getAnalyticsInternalApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.ANALYTICS_INTERNAL_API_KEY?.trim();
  return raw ? raw : null;
}

/** ANALYTICS_DATABASE_URL lets the analytics layer point at a different database than the
 *  customer/billing store, the property market-data layer, or the business-data layer. Falls
 *  back to DATABASE_URL when unset, since most deployments use one database for everything —
 *  same pattern as getOmanBusinessDatabaseUrl(). When neither is set, analytics still records
 *  (to an in-process MemoryAnalyticsRepository — see api/app.ts) rather than being disabled;
 *  only durability across restarts/redeploys requires a real database. */
export function getAnalyticsDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.ANALYTICS_DATABASE_URL || env.DATABASE_URL || undefined;
}
