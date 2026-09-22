/**
 * Revenue ledger config — read directly from process.env, exactly like analytics/config.ts and
 * domain/oman/config.ts's getMarketDataInternalApiKey()/getOmanMarketDatabaseUrl(): infrastructure
 * config, not part of the per-request Config every capability's execute(input) shares (see
 * config/env.ts — deliberately not added to envSchema there).
 *
 * A DEDICATED internal key, not a reuse of ANALYTICS_INTERNAL_API_KEY: this is real financial
 * data with a materially different blast radius than usage/traffic-shape analytics (a leaked
 * analytics key exposes coarse traffic patterns; a leaked revenue key exposes exact settled
 * amounts, wallet addresses and transaction hashes) — matching this codebase's own established
 * precedent of scoping internal keys by blast radius (MARKET_DATA_INTERNAL_API_KEY vs
 * ANALYTICS_INTERNAL_API_KEY are already deliberately distinct for the same reason).
 */
export function getRevenueInternalApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.REVENUE_INTERNAL_API_KEY?.trim();
  return raw ? raw : null;
}

/** REVENUE_DATABASE_URL lets the revenue ledger point at a different database than every other
 *  store. Falls back to DATABASE_URL when unset, since most deployments use one database for
 *  everything. When neither is set, settlements still record (to an in-process
 *  MemoryRevenueLedger — see api/app.ts) rather than being disabled; only durability across
 *  restarts/redeploys requires a real database. */
export function getRevenueDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.REVENUE_DATABASE_URL || env.DATABASE_URL || undefined;
}
