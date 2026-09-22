/**
 * Configuration for which Oman business-intelligence data source(s) are actually queried — the
 * same pattern src/domain/oman/config.ts already uses for the property domain: read directly from
 * process.env rather than threaded through the static capability registry's execute(input), which
 * every capability shares and which carries no Config.
 */
export type OmanBusinessDataMode = "manual" | "database" | "composite";
const VALID_MODES: readonly OmanBusinessDataMode[] = ["manual", "database", "composite"];

export function getOmanBusinessDataMode(env: NodeJS.ProcessEnv = process.env): OmanBusinessDataMode {
  const raw = (env.OMAN_BUSINESS_DATA_MODE ?? "manual").trim().toLowerCase();
  if ((VALID_MODES as readonly string[]).includes(raw)) return raw as OmanBusinessDataMode;
  throw new Error(`Invalid OMAN_BUSINESS_DATA_MODE "${raw}"; expected one of ${VALID_MODES.join(", ")}`);
}

/** OMAN_BUSINESS_DATABASE_URL lets the business-data layer point at a different database than the
 *  customer/billing store (DATABASE_URL) or the property market-data layer
 *  (OMAN_MARKET_DATABASE_URL) — e.g. a dedicated business-data instance. Falls back to
 *  DATABASE_URL when unset, since most deployments use one database for everything. */
export function getOmanBusinessDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.OMAN_BUSINESS_DATABASE_URL || env.DATABASE_URL || undefined;
}

/** Section 19: company-search result cache TTL (ms). 0 or unset disables caching — always
 *  correct, just uncached. Mirrors src/domain/oman/config.ts's getOmanMarketCacheTtlMs. */
export function getBusinessSearchCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OMAN_BUSINESS_SEARCH_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60 * 1000; // 15 minutes default
}

/** Section 19: company-profile cache TTL (ms). Longer than search — profile facts change less
 *  often than a search's relevance ranking. */
export function getBusinessProfileCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OMAN_BUSINESS_PROFILE_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60 * 60 * 1000; // 1 hour default
}

/** Section 7: a company younger than this many months earns the "very recent registration" risk
 *  flag. */
export function getRecentRegistrationMonths(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OMAN_BUSINESS_RECENT_REGISTRATION_MONTHS);
  return Number.isFinite(raw) && raw > 0 ? raw : 6;
}

/** Section 19: a source fact older than this many days is treated as stale for risk/confidence
 *  purposes — mirrors src/domain/oman/config.ts's getOmanMarketStaleDays default reasoning
 *  (long enough to have real coverage, short enough that "current" data isn't secretly years old). */
export function getBusinessStaleDataDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OMAN_BUSINESS_STALE_DATA_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 365;
}
