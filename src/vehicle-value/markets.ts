/**
 * vehicle_value_estimate — market (country) configuration.
 *
 * VALUATION support and PROVIDER support are reported separately on purpose:
 *   - a market listed here has valuation PARAMETERS (default currency, expected annual mileage,
 *     dealer/private-sale spreads, conservative fallbacks) — that is all "configured" means;
 *   - whether any live market EVIDENCE exists for it depends entirely on which providers are
 *     configured on the deployment (see providers/registry.ts and the `marketCoverage` block of
 *     every response). Nothing in this file implies that a market has live data.
 *
 * Every number here is a deliberately conservative default, used only where the comparable
 * evidence itself cannot supply the figure (see valuation.ts). Spreads are RANGES; the engine
 * picks a deterministic point inside each range from the confidence of the estimate.
 */

export type MarketRegion = "gcc" | "north_america" | "uk" | "europe" | "oceania" | "other";

export interface MarketParameters {
  /** ISO 3166-1 alpha-2. */
  countryCode: string;
  countryName: string;
  region: MarketRegion;
  /** Default result currency when the request does not specify one. */
  defaultCurrency: string | null;
  /** Typical annual distance for a passenger vehicle in this market (km) — used to judge whether
   *  a vehicle's mileage is high or low for its age. */
  expectedAnnualKm: number;
  /** Countries whose listings are a valid regional fallback for this market (never used unless
   *  local evidence is insufficient; always flagged REGIONAL_FALLBACK_USED). */
  regionalCountries: readonly string[];
  /** Discount a dealer typically applies below fair value when acquiring (trade-in). [min, max]. */
  dealerBuyDiscountRange: readonly [number, number];
  /** Private-sale price relative to fair value. [min, max]. */
  privateSaleAdjustmentRange: readonly [number, number];
  /** Dealer retail markup above fair value (reconditioning, warranty, margin). [min, max]. */
  dealerRetailMarkupRange: readonly [number, number];
  /** Typical gap between listing asking prices and agreed prices (asking → fair value). */
  listingNegotiationDiscount: number;
  /** Conservative fallback depreciation per model year, used ONLY when comparables cannot
   *  support a market-derived year effect. */
  fallbackAnnualDepreciation: number;
  /** Conservative fallback mileage effect (fraction of value per 10,000 km), used ONLY when
   *  comparables cannot support a market-derived mileage effect. */
  fallbackValuePer10000Km: number;
}

const GCC = ["OM", "AE", "SA", "QA", "BH", "KW"] as const;
const EUROZONE = ["DE", "FR", "IT", "ES", "NL", "BE", "AT", "IE", "PT", "FI"] as const;

type Base = Omit<MarketParameters, "countryCode" | "countryName" | "defaultCurrency" | "regionalCountries" | "region">;

const GCC_BASE: Base = {
  expectedAnnualKm: 25_000,
  dealerBuyDiscountRange: [0.10, 0.18], privateSaleAdjustmentRange: [-0.02, 0.02], dealerRetailMarkupRange: [0.05, 0.12],
  listingNegotiationDiscount: 0.03, fallbackAnnualDepreciation: 0.12, fallbackValuePer10000Km: 0.010
};
const NA_BASE: Base = {
  expectedAnnualKm: 20_000,
  dealerBuyDiscountRange: [0.08, 0.16], privateSaleAdjustmentRange: [-0.02, 0.02], dealerRetailMarkupRange: [0.06, 0.12],
  listingNegotiationDiscount: 0.03, fallbackAnnualDepreciation: 0.13, fallbackValuePer10000Km: 0.012
};
const EU_BASE: Base = {
  expectedAnnualKm: 14_000,
  dealerBuyDiscountRange: [0.10, 0.18], privateSaleAdjustmentRange: [-0.03, 0.02], dealerRetailMarkupRange: [0.06, 0.14],
  listingNegotiationDiscount: 0.04, fallbackAnnualDepreciation: 0.14, fallbackValuePer10000Km: 0.015
};

function market(countryCode: string, countryName: string, region: MarketRegion, defaultCurrency: string, regional: readonly string[], base: Base, overrides: Partial<Base> = {}): MarketParameters {
  return { countryCode, countryName, region, defaultCurrency, regionalCountries: regional.filter(c => c !== countryCode), ...base, ...overrides };
}

export const MARKETS: Readonly<Record<string, MarketParameters>> = Object.freeze({
  OM: market("OM", "Oman", "gcc", "OMR", GCC, GCC_BASE),
  AE: market("AE", "United Arab Emirates", "gcc", "AED", GCC, GCC_BASE, { expectedAnnualKm: 22_000 }),
  SA: market("SA", "Saudi Arabia", "gcc", "SAR", GCC, GCC_BASE, { expectedAnnualKm: 27_000 }),
  QA: market("QA", "Qatar", "gcc", "QAR", GCC, GCC_BASE, { expectedAnnualKm: 22_000 }),
  BH: market("BH", "Bahrain", "gcc", "BHD", GCC, GCC_BASE, { expectedAnnualKm: 18_000 }),
  KW: market("KW", "Kuwait", "gcc", "KWD", GCC, GCC_BASE, { expectedAnnualKm: 22_000 }),
  US: market("US", "United States", "north_america", "USD", ["CA"], NA_BASE),
  CA: market("CA", "Canada", "north_america", "CAD", ["US"], NA_BASE),
  GB: market("GB", "United Kingdom", "uk", "GBP", [], EU_BASE, { expectedAnnualKm: 12_000, fallbackAnnualDepreciation: 0.15 }),
  AU: market("AU", "Australia", "oceania", "AUD", ["NZ"], EU_BASE, { expectedAnnualKm: 13_000, fallbackAnnualDepreciation: 0.12 }),
  ...Object.fromEntries(([
    ["DE", "Germany"], ["FR", "France"], ["IT", "Italy"], ["ES", "Spain"], ["NL", "Netherlands"], ["BE", "Belgium"],
    ["AT", "Austria"], ["IE", "Ireland"], ["PT", "Portugal"], ["FI", "Finland"]
  ] as const).map(([code, name]) => [code, market(code, name, "europe", "EUR", EUROZONE, EU_BASE)])),
  SE: market("SE", "Sweden", "europe", "SEK", [], EU_BASE),
  DK: market("DK", "Denmark", "europe", "DKK", [], EU_BASE),
  PL: market("PL", "Poland", "europe", "PLN", [], EU_BASE),
  CH: market("CH", "Switzerland", "europe", "CHF", [], EU_BASE)
});

/** Parameters for a recognized country with no dedicated configuration: valuation still works
 *  from comparables when a provider covers it, with generic conservative defaults and no regional
 *  fallback. The caller must supply `currency` (there is no default to guess). */
export function genericMarket(countryCode: string, countryName: string): MarketParameters {
  return {
    countryCode, countryName, region: "other", defaultCurrency: null, regionalCountries: [],
    expectedAnnualKm: 18_000,
    dealerBuyDiscountRange: [0.10, 0.20], privateSaleAdjustmentRange: [-0.03, 0.02], dealerRetailMarkupRange: [0.05, 0.14],
    listingNegotiationDiscount: 0.04, fallbackAnnualDepreciation: 0.13, fallbackValuePer10000Km: 0.012
  };
}

export function marketFor(countryCode: string, countryName: string): { params: MarketParameters; configured: boolean } {
  const configured = MARKETS[countryCode];
  return configured ? { params: configured, configured: true } : { params: genericMarket(countryCode, countryName), configured: false };
}

/** The list of configured markets, for discovery/documentation. */
export const CONFIGURED_MARKET_CODES = Object.freeze(Object.keys(MARKETS).sort());
