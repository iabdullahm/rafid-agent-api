/**
 * Phase 6: configuration for which Oman property data source(s) are actually queried, and Phase 7's
 * staleness threshold and Phase 9's cache TTL. Read directly from process.env — the same pattern
 * this project already uses for database-backed pieces outside the central request-time Config
 * (src/admin.ts reads DATABASE_URL directly; src/db/store.ts's tests read TEST_DATABASE_URL
 * directly) — rather than threading a new parameter through the static capability registry's
 * `execute(input)` signature, which every capability shares and which does not carry a Config.
 */
import { ncsiFieldMapSchema, type NcsiFieldMap } from "./officialContext.js";

export type OmanPropertyDataMode = "manual" | "database" | "composite";

const VALID_MODES: readonly OmanPropertyDataMode[] = ["manual", "database", "composite"];

export function getOmanPropertyDataMode(env: NodeJS.ProcessEnv = process.env): OmanPropertyDataMode {
  const raw = (env.OMAN_PROPERTY_DATA_MODE ?? "manual").trim().toLowerCase();
  if ((VALID_MODES as readonly string[]).includes(raw)) return raw as OmanPropertyDataMode;
  throw new Error(`Invalid OMAN_PROPERTY_DATA_MODE "${raw}"; expected one of ${VALID_MODES.join(", ")}`);
}

/** OMAN_MARKET_DATABASE_URL lets the market data layer point at a different database than the
 *  customer/billing store (DATABASE_URL) — e.g. a separate read replica or a dedicated market-data
 *  instance. Falls back to DATABASE_URL when unset, since most deployments will use one database
 *  for everything. */
export function getOmanMarketDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.OMAN_MARKET_DATABASE_URL || env.DATABASE_URL || undefined;
}

/** Phase 7: a comparable sample whose median age exceeds this many days is reported as
 *  `staleMarketData: true` in addition to (not instead of) comparables.ts's own, longer
 *  MAX_DATA_AGE_DAYS recency cutoff (which excludes truly ancient records from the pool
 *  entirely). Deliberately shorter than that cutoff: data can be "in scope" for an estimate while
 *  still being stale enough that an agent should discount it. */
export function getOmanMarketStaleDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OMAN_MARKET_STALE_DAYS);
  // Default of one year sits well inside comparables.ts's own 540-day hard recency cutoff
  // (records older than that are excluded from the candidate pool entirely, see
  // comparables.ts's MAX_DATA_AGE_DAYS) — "in scope but old enough to discount" rather than
  // "too old to use at all".
  return Number.isFinite(raw) && raw > 0 ? raw : 365;
}

/** Phase 9: TTL for the in-memory comparable-query cache, milliseconds. 0 or unset disables
 *  caching entirely (every DatabaseOmanPropertyDataProvider call queries the repository fresh),
 *  which is always correct, just uncached. */
export function getOmanMarketCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OMAN_MARKET_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** Al Mouj historical-sales production-readiness pass (Section 7): the window, in days, a sale
 *  record must fall within to count as a "recent comparable sale" for historicalSalesContext's
 *  `recentComparableSales`/`recentMedianPricePerSqmOMR` — kept out of the analysis logic itself so
 *  it can be tuned per deployment without a code change, exactly like getOmanMarketStaleDays/
 *  getPartnerFeedStaleDays above. Default of 730 days (~2 years) is wider than
 *  comparables.ts's own 540-day MAX_DATA_AGE_DAYS cutoff used for CURRENT market estimates,
 *  deliberately: "recent" for a long-lived historical sales feed (spanning 2006-2026 in the Al
 *  Mouj dataset) is a looser bar than "eligible as a live comparable" — this window governs a
 *  separate, clearly-labeled historical-context field, never the current comparable-selection
 *  path in comparables.ts. */
export function getOmanRecentSalesDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OMAN_RECENT_SALES_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 730;
}

/**
 * Partner Data Feed layer config (Section 4/9/11) — read directly from process.env for the same
 * reason as the getters above: this is infrastructure config, not part of the per-request Config
 * every capability's `execute(input)` shares.
 */

/** The shared secret gating GET /api/v1/internal/market-data/status and .../partners (Section 9)
 *  — deliberately distinct from every per-partner ingestion token (src/domain/oman/partners.ts)
 *  and from the normal customer X-API-Key. Returns null (never a default) when unset, so those
 *  routes fail closed (503) rather than accepting no credential at all — see
 *  middleware/partnerAuth.ts's requireInternalAuth(). */
export function getMarketDataInternalApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.MARKET_DATA_INTERNAL_API_KEY?.trim();
  return raw ? raw : null;
}

/** Partner Operations layer (Section 5): a partner feed with no accepted record newer than this
 *  many days is reported `stale: true` by GET /api/v1/internal/market-data/partners — a per-partner
 *  monitoring signal only. "Do not mark the whole market stale just because one partner is stale":
 *  this never gates ingestion, analyze_oman_property, or any other partner's own staleness (see
 *  partners.ts's doc comment on PropertyDataPartnerWithStats). Renamed from the prior phase's
 *  MARKET_PARTNER_STALE_DAYS/getMarketPartnerStaleDays (default 30) to the spec's explicit
 *  PARTNER_FEED_STALE_DAYS, default 7. */
export function getPartnerFeedStaleDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PARTNER_FEED_STALE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 7;
}

/**
 * NCSI (Oman National Centre for Statistics and Information) integration config — see
 * src/services/ncsi/ncsiClient.ts and src/domain/oman/officialContext.ts. Read directly from
 * process.env for the same reason as the getters above.
 */

/** Verified live against https://map.ncsi.gov.om/ODPAPI/swagger/v1/swagger.json (see
 *  ncsiClient.ts's header) — the only base URL confirmed to serve NCSI's real "Explore Api"
 *  contract as of this integration. Overridable for a future NCSI API version/host. */
export function getNcsiApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.NCSI_API_BASE_URL || "https://map.ncsi.gov.om/ODPAPI";
}

export function getNcsiRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.NCSI_REQUEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 8000;
}

/** Official statistics are published on a quarterly/annual cadence, not continuously — a 6 hour
 *  default keeps every paid analyze_oman_property call from hitting NCSI while still refreshing
 *  well within any plausible publication schedule. 0 or unset disables caching. */
export function getNcsiCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.NCSI_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 6 * 60 * 60 * 1000;
}

/** The NCSI dataset id to query for official real-estate market context. Deliberately has no
 *  default: no dataset id could be verified against the live catalog during development (the
 *  catalog-listing endpoint returned HTTP 500 for every request attempted — see this feature's
 *  completion report), so shipping a guessed id here would risk silently querying the wrong
 *  dataset or none at all. Unset until an operator runs `npm run ncsi:discover` (or otherwise
 *  confirms a dataset id with NCSI directly) and configures it here. */
export function getNcsiRealEstateDatasetId(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.NCSI_REAL_ESTATE_DATASET_ID?.trim();
  return raw ? raw : null;
}

/** Maps this capability's official-context concepts (governorate, period, price index, ...) to
 *  the actual field names in the configured NCSI dataset's records — see officialContext.ts's
 *  NcsiFieldMap doc comment for why this is never hardcoded. Returns null (never throws) when
 *  unset or invalid, so a misconfiguration degrades to "official context unavailable" rather than
 *  crashing the capability. */
export function getNcsiFieldMap(env: NodeJS.ProcessEnv = process.env): NcsiFieldMap | null {
  const raw = env.NCSI_FIELD_MAP_JSON?.trim();
  if (!raw) return null;
  try {
    return ncsiFieldMapSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
