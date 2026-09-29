import { z } from "zod";
import {
  ACCIDENT_HISTORIES, BODY_TYPES, CONDITIONS, CONFIDENCE_LEVELS, DRIVETRAINS, FALLBACK_LEVELS, FUEL_TYPES, MARKET_POSITIONS,
  RISK_FLAGS, SERVICE_HISTORIES, TRANSMISSIONS
} from "../vehicle-value/types.js";

/**
 * vehicle_value_estimate output — strict, deterministic, machine-first. Every key is present in
 * every response (null where not applicable), so an agent never has to probe for fields.
 *
 * status "estimated": a valuation anchored on comparable-market evidence.
 * status "insufficient_market_data": no defensible valuation could be produced from the market
 * evidence available to this deployment — estimatedValue and every derived price are null (never
 * guessed), confidence is very_low, and riskFlags/assumptions say why.
 */

const money = z.number();
const nullableMoney = money.nullable();
const unit = z.number().min(0).max(1);

const adjustment = z.strictObject({
  factor: z.string(),
  impactAmount: money,
  impactPercent: z.number(),
  /** market_derived: estimated from the comparables themselves. heuristic: a capped, conservative
   *  market default used because the evidence could not support a derived figure. */
  basis: z.enum(["market_derived", "heuristic"]),
  reason: z.string()
});

const comparable = z.strictObject({
  make: z.string(), model: z.string(), year: z.number().int(), trim: z.string().nullable(), mileageKm: z.number().nullable(),
  askingPrice: money, currency: z.string(), originalAskingPrice: money, originalCurrency: z.string(),
  country: z.string(), city: z.string().nullable(), sourceName: z.string(), sourceUrl: z.string().nullable(),
  observedAt: z.string().nullable(), priceType: z.enum(["listing", "sale"]), similarityScore: unit
});

export const vehicleValueEstimateOutput = z.strictObject({
  status: z.enum(["estimated", "insufficient_market_data"]),
  vehicle: z.strictObject({
    make: z.string(), model: z.string(), year: z.number().int(), trim: z.string().nullable(), mileageKm: z.number().nullable(),
    condition: z.enum(CONDITIONS), country: z.string(), countryCode: z.string(), city: z.string().nullable(),
    fuelType: z.enum(FUEL_TYPES).nullable(), transmission: z.enum(TRANSMISSIONS).nullable(), bodyType: z.enum(BODY_TYPES).nullable(),
    drivetrain: z.enum(DRIVETRAINS).nullable(), engine: z.string().nullable(), accidentHistory: z.enum(ACCIDENT_HISTORIES),
    serviceHistory: z.enum(SERVICE_HISTORIES), owners: z.number().int().nullable(), color: z.string().nullable(), options: z.array(z.string()),
    ageYears: z.number(), expectedMileageKm: z.number().nullable(), mileageVsExpectedPercent: z.number().nullable()
  }),
  valuationDate: z.string(),
  currency: z.string(),
  estimatedValue: z.strictObject({ low: money, mid: money, high: money, currency: z.string() }).nullable(),
  estimatedPrivateSalePrice: nullableMoney,
  estimatedDealerBuyPrice: nullableMoney,
  estimatedDealerRetailPrice: nullableMoney,
  askingPriceAnalysis: z.strictObject({
    askingPrice: money, differenceFromMid: money, differencePercent: z.number(), marketPosition: z.enum(MARKET_POSITIONS),
    withinEstimatedRange: z.boolean(),
    thresholdsPercent: z.strictObject({ wellBelow: z.number(), below: z.number(), above: z.number(), wellAbove: z.number() })
  }).nullable(),
  depreciation: z.strictObject({
    estimatedOriginalPrice: nullableMoney,
    originalPriceSource: z.string().nullable(),
    totalDepreciationAmount: nullableMoney,
    totalDepreciationPercent: z.number().nullable(),
    estimatedAnnualDepreciationPercent: z.number().nullable(),
    /** Year-over-year value change implied by the comparables themselves (market_derived only). */
    marketImpliedAnnualDepreciationPercent: z.number().nullable()
  }),
  adjustments: z.array(adjustment),
  marketComparables: z.array(comparable),
  marketStats: z.strictObject({
    comparableCount: z.number().int(), comparablesConsidered: z.number().int(), outliersExcluded: z.number().int(),
    medianPrice: nullableMoney, averagePrice: nullableMoney, medianMileageKm: z.number().nullable(),
    priceDispersionPercent: z.number().nullable(), recentListingCount: z.number().int(),
    /** Market-derived value change per additional 1,000 km in the result currency; null when not derivable. */
    pricePerKmAdjustment: z.number().nullable(),
    currencyExcludedCount: z.number().int()
  }),
  methodology: z.strictObject({
    fallbackLevel: z.enum(FALLBACK_LEVELS).nullable(),
    fallbackLevelDescription: z.string().nullable(),
    outlierMethod: z.string(),
    yearEffect: z.strictObject({ basis: z.enum(["market_derived", "heuristic", "not_needed"]), annualPercent: z.number().nullable() }),
    mileageEffect: z.strictObject({ basis: z.enum(["market_derived", "heuristic", "not_applied"]), percentPer10000Km: z.number().nullable() }),
    rangeHalfWidthPercent: z.number().nullable(),
    dealerBuyDiscountPercent: z.number().nullable(),
    privateSaleAdjustmentPercent: z.number().nullable(),
    dealerRetailMarkupPercent: z.number().nullable(),
    listingNegotiationDiscountPercent: z.number().nullable()
  }),
  confidence: z.strictObject({
    score: unit,
    level: z.enum(CONFIDENCE_LEVELS),
    reasons: z.array(z.string()),
    factors: z.record(z.string(), unit)
  }),
  riskFlags: z.array(z.enum(RISK_FLAGS)),
  assumptions: z.array(z.string()),
  dataFreshness: z.strictObject({
    latestComparableAt: z.string().nullable(), oldestComparableAt: z.string().nullable(),
    medianComparableAgeDays: z.number().nullable(), recentListingCount: z.number().int(), recentWindowDays: z.number().int()
  }),
  marketCoverage: z.strictObject({
    countryCode: z.string(),
    country: z.string(),
    region: z.string(),
    /** True when Rafid has valuation parameters for this market — says nothing about live data. */
    valuationParametersConfigured: z.boolean(),
    /** Providers configured on this deployment that cover this market (or its regional fallback). */
    marketDataProviders: z.array(z.strictObject({
      id: z.string(), status: z.enum(["ok", "empty", "timeout", "error"]), comparablesReturned: z.number().int()
    })),
    liveMarketDataAvailable: z.boolean(),
    regionalFallbackCountries: z.array(z.string())
  }),
  /** null when no VIN was supplied. The VIN itself is never returned — only a masked form. */
  vinCheck: z.strictObject({
    vinMasked: z.string(),
    wmiRegion: z.enum(["north_america", "south_america", "europe", "asia", "africa", "oceania", "unknown"]),
    checkDigit: z.enum(["valid", "invalid", "not_applicable"]),
    decoder: z.string(),
    decodeStatus: z.enum(["decoded", "not_decoded", "unavailable", "not_configured"]),
    decoded: z.strictObject({
      make: z.string().nullable(), model: z.string().nullable(), modelYear: z.number().int().nullable(), trim: z.string().nullable(),
      bodyClass: z.string().nullable(), fuelType: z.string().nullable(), driveType: z.string().nullable(), transmission: z.string().nullable(), engine: z.string().nullable()
    }),
    matches: z.strictObject({ make: z.boolean().nullable(), model: z.boolean().nullable(), year: z.boolean().nullable() }),
    enrichedFields: z.array(z.string()),
    notes: z.array(z.string())
  }).nullable(),
  /** Every currency conversion applied to the evidence, with its dated source. */
  currencyConversion: z.strictObject({
    resultCurrency: z.string(),
    sourcesConfigured: z.array(z.string()),
    conversions: z.array(z.strictObject({ from: z.string(), to: z.string(), rate: z.number().positive(), source: z.string(), rateDate: z.string().nullable() }))
  }),
  disclaimer: z.string()
});

export type VehicleValueEstimateOutput = z.infer<typeof vehicleValueEstimateOutput>;
