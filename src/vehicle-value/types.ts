/**
 * vehicle_value_estimate — shared domain types.
 *
 * The valuation core (comparables.ts, valuation.ts, confidence.ts) only ever sees these
 * provider-independent shapes. A market-data provider (providers/*.ts) translates whatever its
 * upstream source returns into `VehicleComparable` — the core never knows which marketplace,
 * database or feed a comparable came from beyond its `sourceName`.
 */

export const CONDITIONS = ["excellent", "very_good", "good", "fair", "poor", "unknown"] as const;
export type Condition = (typeof CONDITIONS)[number];

export const FUEL_TYPES = ["petrol", "diesel", "hybrid", "plug_in_hybrid", "electric", "lpg", "cng", "hydrogen", "other"] as const;
export type FuelType = (typeof FUEL_TYPES)[number];

export const TRANSMISSIONS = ["automatic", "manual", "cvt", "dct", "other"] as const;
export type Transmission = (typeof TRANSMISSIONS)[number];

export const BODY_TYPES = ["sedan", "hatchback", "suv", "crossover", "pickup", "coupe", "convertible", "wagon", "van", "minivan", "other"] as const;
export type BodyType = (typeof BODY_TYPES)[number];

export const DRIVETRAINS = ["fwd", "rwd", "awd", "4wd"] as const;
export type Drivetrain = (typeof DRIVETRAINS)[number];

/** `none` = no known accident; `reported` = an accident is declared but its severity is not stated. */
export const ACCIDENT_HISTORIES = ["none", "minor_cosmetic", "repaired", "structural", "reported", "unknown"] as const;
export type AccidentHistory = (typeof ACCIDENT_HISTORIES)[number];

export const SERVICE_HISTORIES = ["full", "partial", "none", "unknown"] as const;
export type ServiceHistory = (typeof SERVICE_HISTORIES)[number];

export const MARKET_POSITIONS = ["well_below_market", "below_market", "near_market", "above_market", "well_above_market"] as const;
export type MarketPosition = (typeof MARKET_POSITIONS)[number];

export const CONFIDENCE_LEVELS = ["high", "medium", "low", "very_low"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const RISK_FLAGS = [
  "INSUFFICIENT_COMPARABLES",
  "NO_MARKET_DATA_PROVIDER",
  "STALE_MARKET_DATA",
  "HIGH_PRICE_DISPERSION",
  "MILEAGE_UNKNOWN",
  "TRIM_UNKNOWN",
  "CONDITION_UNKNOWN",
  "ACCIDENT_HISTORY_UNKNOWN",
  "ACCIDENT_SEVERITY_UNVERIFIED",
  "STRUCTURAL_DAMAGE_REPORTED",
  "HIGH_MILEAGE_FOR_AGE",
  "ASKING_PRICE_SIGNIFICANTLY_ABOVE_MARKET",
  "ASKING_PRICE_SIGNIFICANTLY_BELOW_MARKET",
  "CURRENCY_CONVERSION_UNAVAILABLE",
  "REGIONAL_FALLBACK_USED",
  "BROADENED_COMPARABLE_SEARCH",
  "HEURISTIC_ADJUSTMENTS_USED",
  "PROVIDER_PARTIAL_FAILURE",
  "OUTLIERS_REMOVED"
] as const;
export type RiskFlag = (typeof RISK_FLAGS)[number];

/** Comparable-selection fallback ladder, narrowest first. Recorded on every response. */
export const FALLBACK_LEVELS = [
  "same_trim_same_year",
  "same_trim_year_plus_minus_1",
  "same_model_year_plus_minus_1",
  "same_model_year_plus_minus_2",
  "regional_same_model_year_plus_minus_2"
] as const;
export type FallbackLevel = (typeof FALLBACK_LEVELS)[number];

/** A normalized market observation (a listing's asking price, or a recorded sale). Vehicle and
 *  market evidence only — never a seller's name, phone number, e-mail address or VIN. */
export interface VehicleComparable {
  make: string;
  model: string;
  year: number;
  trim?: string;
  mileageKm?: number;
  condition?: Condition;
  fuelType?: FuelType;
  transmission?: Transmission;
  bodyType?: BodyType;
  drivetrain?: Drivetrain;
  /** Asking price (listing) or recorded price (sale), in `currency`. */
  askingPrice: number;
  currency: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  city?: string;
  sourceName: string;
  sourceRecordId?: string;
  sourceUrl?: string;
  /** ISO 8601 timestamp when the price was observed. Listings without it are treated as stale. */
  observedAt?: string;
  /** "listing" (asking price, default) or "sale" (a recorded transaction price). */
  priceType?: "listing" | "sale";
}

/** What the valuation core asks a provider for: a deliberately broad pool (same make/model, a
 *  ±2-year window, the subject's country plus its valid regional fallback countries). Narrowing
 *  (trim, exact year, locality) happens in-process so fallback levels are deterministic and
 *  provider-independent. */
export interface VehicleMarketQuery {
  makeKey: string;
  modelKey: string;
  make: string;
  model: string;
  yearMin: number;
  yearMax: number;
  /** ISO alpha-2 codes, subject country first. */
  countries: readonly string[];
  /** Listings observed before this ISO timestamp are not needed. */
  observedAfter: string;
}

/** Optional new-vehicle (original/MSRP) price reference. A provider returns null rather than
 *  guessing when it has no verified reference. */
export interface NewVehiclePriceReference {
  price: number;
  currency: string;
  sourceName: string;
}

export interface VehicleMarketProvider {
  /** Stable identifier, reported in responses and telemetry. */
  readonly id: string;
  /** True when this provider can return evidence for this market (country) — checked BEFORE any
   *  I/O, so a provider that cannot serve a market is never called. */
  supports(query: { country: string; regionalCountries: readonly string[] }): boolean;
  searchComparables(query: VehicleMarketQuery, signal: AbortSignal): Promise<VehicleComparable[]>;
  /** Optional: a verified original/new price for the exact make/model/year/trim in a country. */
  getNewVehiclePrice?(query: { makeKey: string; modelKey: string; year: number; trimKey: string | null; country: string }, signal: AbortSignal): Promise<NewVehiclePriceReference | null>;
}

export type ProviderRunStatus = "ok" | "empty" | "timeout" | "error";

export interface ProviderRun {
  providerId: string;
  status: ProviderRunStatus;
  comparablesReturned: number;
  fromCache: boolean;
  /** Wall-clock latency — telemetry only, never part of the (deterministic) API response. */
  durationMs: number;
}

/** Converts an amount between ISO 4217 currencies. Returns null (never a guess) when no reliable
 *  rate is available; the valuation then omits that comparable and flags it. */
export interface ExchangeRateProvider {
  convert(amount: number, from: string, to: string): number | null;
}
