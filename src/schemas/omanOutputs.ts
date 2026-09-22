import { z } from "zod";
import { PROPERTY_TYPES, FURNISHED_STATUSES, SOURCE_TYPES } from "../domain/oman/types.js";

const n = z.number();
const rangeStats = z.strictObject({ low: n, median: n, high: n });

export const omanPropertyOutput = z.strictObject({
  normalizedLocation: z.strictObject({
    governorate: z.string(),
    wilayat: z.string(),
    area: z.string(),
    inputArea: z.string(),
    matchType: z.enum(["exact", "alias", "unmatched"]),
    supported: z.boolean()
  }),
  subjectProperty: z.strictObject({
    propertyType: z.enum(PROPERTY_TYPES),
    bedrooms: n.nullable(),
    bathrooms: n.nullable(),
    sizeSqm: n,
    askingPriceOMR: n,
    furnished: z.enum([...FURNISHED_STATUSES, "unspecified"])
  }),
  market: z.strictObject({
    estimatedMonthlyRentOMR: rangeStats.nullable(),
    estimatedAnnualRentOMR: n.nullable(),
    comparableCount: z.number().int(),
    sampleSizeUsed: z.number().int(),
    dataFreshnessDays: z.number().int().nullable()
  }),
  investment: z.strictObject({
    grossYieldPct: n.nullable(),
    estimatedOperatingCostOMR: n,
    estimatedNetIncomeOMR: n.nullable(),
    netYieldPct: n.nullable()
  }),
  pricePosition: z.strictObject({
    askingPricePerSqmOMR: n,
    observedComparableRange: rangeStats.nullable(),
    marketPosition: z.enum(["below_market", "at_market", "above_market", "insufficient_data"])
  }),
  comparablesSummary: z.strictObject({
    medianRentPerSqm: n, lowRentPerSqm: n, highRentPerSqm: n
  }).nullable(),
  riskFlags: z.array(z.string()),
  confidence: z.strictObject({
    score: n.min(0).max(1),
    level: z.enum(["insufficient", "low", "medium", "high"]),
    reasons: z.array(z.string())
  }),
  provenance: z.array(z.strictObject({
    sourceType: z.enum(SOURCE_TYPES),
    sourceName: z.string(),
    sourceDate: z.string(),
    recordCount: z.number().int()
  })),
  assumptions: z.array(z.string()),
  insufficientMarketData: z.boolean(),
  unavailableOutputs: z.array(z.string()),
  currency: z.literal("OMR"),
  // Phase 7: freshness/provenance-at-a-glance, independent of which specific market.* figures
  // ended up computable. sourceTypes/staleMarketData let an agent decide how much to trust a
  // result without having to interpret riskFlags/provenance prose itself.
  dataQuality: z.strictObject({
    latestDataDate: z.string().nullable(),
    dataFreshnessDays: z.number().int().nullable(),
    sampleSize: z.number().int(),
    sourceTypes: z.array(z.enum(SOURCE_TYPES)),
    staleMarketData: z.boolean()
  }),
  // Al Mouj historical-sales production-readiness pass (Section 6/7/8): a separate, additive
  // enrichment — NEVER mixed into market/pricePosition/comparablesSummary/confidence above, which
  // remain driven exclusively by the current-comparable pool. Lets an agent distinguish live
  // comparable evidence from long-term historical sales intelligence (e.g. a multi-year partner
  // feed) rather than the two being silently blended into one figure. Not a new public capability
  // — purely an additive field on this existing capability's output.
  historicalSalesContext: z.strictObject({
    available: z.boolean(),
    recordsAvailable: z.number().int(),
    // Section 7: matched on area/propertyType/size similarity/bedrooms (where available) within
    // the configurable OMAN_RECENT_SALES_DAYS window — never "every historical sale in range".
    recentComparableSales: z.number().int(),
    medianHistoricalPricePerSqmOMR: n.nullable(),
    recentMedianPricePerSqmOMR: n.nullable(),
    oldestRecordDate: z.string().nullable(),
    latestRecordDate: z.string().nullable(),
    sourceTypes: z.array(z.string()),
    // Distinct metadata.saleRecordType values found (e.g. "contracted_unit_price") — reports only
    // what the source actually recorded, never verified_conveyance_price/
    // government_registered_transaction/final_title_transfer_price unless the source itself says so.
    priceSemantics: z.array(z.string()),
    // Section 8: only phases meeting the minimum sample size are ever listed here — "do not claim
    // a phase trend when the sample is insufficient" — capped to the busiest few phases.
    phaseBreakdown: z.array(z.strictObject({
      phaseName: z.string(),
      recordCount: z.number().int(),
      medianPriceOMR: n,
      medianPricePerSqmOMR: n,
      oldestRecordDate: z.string(),
      latestRecordDate: z.string()
    }))
  }),
  // NCSI integration: aggregate, governorate-level official statistics — deliberately a separate
  // object from market/pricePosition/comparablesSummary (which are all derived from property-level
  // comparables) and carrying its own `confidence`, never merged into the top-level `confidence`
  // above. See src/domain/oman/officialContext.ts.
  officialMarketContext: z.strictObject({
    available: z.boolean(),
    reason: z.enum(["ncsi_not_configured", "no_data_for_governorate", "ncsi_timeout", "ncsi_malformed_response", "official_source_temporarily_unavailable"]).nullable(),
    source: z.string(),
    sourceType: z.literal("official_statistics"),
    governorate: z.string(),
    period: z.string().nullable(),
    realEstatePriceIndex: z.strictObject({ value: n.nullable(), period: z.string().nullable() }),
    marketActivity: z.strictObject({
      tradedValueOMR: n.nullable(),
      saleContracts: z.number().int().nullable(),
      mortgageContracts: z.number().int().nullable()
    }),
    dataFreshnessDays: z.number().int().nullable(),
    confidence: z.strictObject({
      level: z.enum(["unavailable", "low", "medium", "high"]),
      reasons: z.array(z.string())
    }),
    provenance: z.strictObject({
      source: z.string(),
      sourceType: z.literal("official_statistics"),
      datasetId: z.string().nullable(),
      datasetTitle: z.string().nullable(),
      retrievedAt: z.string().nullable(),
      publishedAt: z.string().nullable(),
      sourceUrl: z.string().nullable(),
      license: z.string()
    })
  })
});
