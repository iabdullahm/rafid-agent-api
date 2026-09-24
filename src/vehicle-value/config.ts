/**
 * vehicle_value_estimate — deployment configuration, read from process.env (the same pattern as
 * src/business-data/config.ts and src/domain/oman/config.ts: the static capability registry's
 * execute(input) carries no Config).
 *
 * Default: NO market-data provider. The capability then answers every call with an honest
 * `insufficient_market_data` result (never a fabricated estimate) until an operator configures a
 * real evidence source.
 */
export type VehicleMarketDataMode = "none" | "database";
const MODES: readonly VehicleMarketDataMode[] = ["none", "database"];

export function getVehicleMarketDataMode(env: NodeJS.ProcessEnv = process.env): VehicleMarketDataMode {
  const raw = (env.VEHICLE_MARKET_DATA_MODE ?? "none").trim().toLowerCase();
  if ((MODES as readonly string[]).includes(raw)) return raw as VehicleMarketDataMode;
  throw new Error(`Invalid VEHICLE_MARKET_DATA_MODE "${raw}"; expected one of ${MODES.join(", ")}`);
}

export function getVehicleMarketDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.VEHICLE_MARKET_DATABASE_URL || env.DATABASE_URL || undefined;
}

/** ISO alpha-2 codes the imported evidence covers ("OM,AE"), or "*" for any country. Empty =
 *  the database provider claims no coverage (explicit opt-in per market). */
export function getVehicleMarketCountries(env: NodeJS.ProcessEnv = process.env): readonly string[] | "*" {
  const raw = (env.VEHICLE_MARKET_COUNTRIES ?? "").trim();
  if (raw === "*") return "*";
  return raw.split(",").map(s => s.trim().toUpperCase()).filter(s => /^[A-Z]{2}$/.test(s));
}

const positive = (raw: string | undefined, fallback: number) => { const n = Number(raw); return Number.isFinite(n) && n > 0 ? n : fallback; };

/** Per-provider timeout (ms). */
export const getVehicleProviderTimeoutMs = (env: NodeJS.ProcessEnv = process.env) => positive(env.VEHICLE_MARKET_PROVIDER_TIMEOUT_MS, 4000);
/** Provider search-result cache TTL (ms). Used-car listings move daily; 6 hours by default. */
export const getVehicleSearchCacheTtlMs = (env: NodeJS.ProcessEnv = process.env) => positive(env.VEHICLE_MARKET_CACHE_TTL_MS, 6 * 60 * 60 * 1000);
/** Evidence older than this (days before the valuation date) is not used at all. */
export const getVehicleMaxListingAgeDays = (env: NodeJS.ProcessEnv = process.env) => positive(env.VEHICLE_MARKET_MAX_LISTING_AGE_DAYS, 365);
