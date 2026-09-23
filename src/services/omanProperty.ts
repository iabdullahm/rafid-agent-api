import { omanPropertyInput } from "../schemas/omanInputs.js";
import { normalizeLocation } from "../domain/oman/locations.js";
import { selectComparables, selectSaleComparables, selectRecentSaleRecords, computeRangeStats, MIN_COMPARABLES } from "../domain/oman/comparables.js";
import { computeConfidence, type ConfidenceResult } from "../domain/oman/confidence.js";
import {
  CompositeOmanPropertyDataProvider, DatabaseOmanPropertyDataProvider, ListingDataProvider,
  ManualDatasetProvider, OfficialOmanDataProvider, type OmanPropertyDataProvider
} from "../domain/oman/dataProviders.js";
import { RENTAL_FIXTURES, SALE_FIXTURES } from "../domain/oman/fixtures.js";
import { normalizedMonthlyRent, type ComparableRecordBase, type OmanPropertyQuery, type SourceType } from "../domain/oman/types.js";
import { round } from "../domain/financial.js";
import {
  getNcsiApiBaseUrl, getNcsiCacheTtlMs, getNcsiFieldMap, getNcsiRealEstateDatasetId, getNcsiRequestTimeoutMs,
  getOmanMarketCacheTtlMs, getOmanMarketDatabaseUrl, getOmanMarketStaleDays, getOmanPropertyDataMode, getOmanRecentSalesDays
} from "../domain/oman/config.js";
import { MemoryComparableCache } from "../domain/oman/cache.js";
import { MemoryOfficialMarketContextCache } from "../domain/oman/officialContextCache.js";
import { unavailableOfficialContext, type OfficialMarketContext } from "../domain/oman/officialContext.js";
import { PostgresPropertyMarketRepository } from "../db/marketStore.js";
import { NcsiClient } from "./ncsi/ncsiClient.js";
import type { CapabilityPreviewBody } from "../preview/types.js";

/**
 * Phase 6: builds the provider this capability actually queries, from OMAN_PROPERTY_DATA_MODE:
 *  - "manual" (default): only the curated fixture dataset (plus the always-empty Official/Listing
 *    seams) — identical behavior to this capability's original MVP.
 *  - "database": only the production PropertyMarketRepository-backed provider (plus the
 *    always-empty seams) — no demo data is ever mixed in.
 *  - "composite": the database provider first, the manual/demo provider last, so real records win
 *    on an id collision (see CompositeOmanPropertyDataProvider's dedupe-by-id, first-occurrence-
 *    wins) and demo data only fills genuine gaps.
 *
 * Constructed once at module load, exactly like the original single-provider setup — a
 * `pg.Pool` (inside PostgresPropertyMarketRepository) does not open a connection until a query
 * actually runs, so this is safe to construct even when the database is not currently reachable;
 * a query failure is caught per-provider by CompositeOmanPropertyDataProvider and degrades to "no
 * records from that provider" rather than crashing the whole analysis (see its doc comment).
 */
/**
 * NCSI integration: builds the OfficialOmanDataProvider used for both the (always-empty)
 * comparable seam and the real `getMarketContext` official-statistics lookup. Only wired up to a
 * live NcsiClient when BOTH `NCSI_REAL_ESTATE_DATASET_ID` and `NCSI_FIELD_MAP_JSON` are configured
 * (see config.ts's doc comments on why neither has a default) — otherwise `getMarketContext`
 * always resolves to `unavailableOfficialContext(..., "ncsi_not_configured")`, honestly, with no
 * network call attempted at all.
 */
function buildOfficialProvider(): OfficialOmanDataProvider {
  const datasetId = getNcsiRealEstateDatasetId();
  const fieldMap = getNcsiFieldMap();
  const client = datasetId && fieldMap
    ? new NcsiClient({ baseUrl: getNcsiApiBaseUrl(), timeoutMs: getNcsiRequestTimeoutMs() })
    : null;
  const cacheTtlMs = getNcsiCacheTtlMs();
  const cache = cacheTtlMs > 0 ? new MemoryOfficialMarketContextCache(cacheTtlMs) : undefined;
  return new OfficialOmanDataProvider({ client, datasetId, fieldMap, cache });
}

function buildProviders(): { comparableProvider: OmanPropertyDataProvider; officialProvider: OfficialOmanDataProvider } {
  const mode = getOmanPropertyDataMode();
  const official = buildOfficialProvider();
  const listing = new ListingDataProvider();
  const manual = new ManualDatasetProvider(RENTAL_FIXTURES, SALE_FIXTURES);
  if (mode === "manual") return { comparableProvider: new CompositeOmanPropertyDataProvider([official, listing, manual]), officialProvider: official };

  const databaseUrl = getOmanMarketDatabaseUrl();
  if (!databaseUrl) throw new Error(`OMAN_PROPERTY_DATA_MODE=${mode} requires DATABASE_URL or OMAN_MARKET_DATABASE_URL to be set`);
  const cacheTtlMs = getOmanMarketCacheTtlMs();
  const cache = cacheTtlMs > 0 ? new MemoryComparableCache(cacheTtlMs) : undefined;
  const database = new DatabaseOmanPropertyDataProvider(new PostgresPropertyMarketRepository(databaseUrl), cache);
  const comparableProvider = mode === "database"
    ? new CompositeOmanPropertyDataProvider([official, listing, database])
    : new CompositeOmanPropertyDataProvider([official, listing, database, manual]);
  return { comparableProvider, officialProvider: official };
}

const { comparableProvider: provider, officialProvider } = buildProviders();

/** How close the subject's asking price per sqm must be to the observed sale-comparable median
 *  to be reported as "at_market" rather than below/above it. */
const AT_MARKET_BAND_PCT = 0.10;

/** Section 8: a phase is only ever reported in historicalSalesContext.phaseBreakdown once it has
 *  at least this many records — reuses comparables.ts's existing MIN_COMPARABLES threshold rather
 *  than inventing a second "is this sample big enough" number, so "do not claim a phase trend when
 *  the sample is insufficient" means exactly the same thing here as it does for market.*. */
const PHASE_BREAKDOWN_MIN_SAMPLE = MIN_COMPARABLES;
/** Keeps the phaseBreakdown array bounded (Al Mouj alone has 29 phases) — the busiest phases are
 *  the ones worth surfacing; an agent that needs every phase can query the underlying data
 *  directly rather than every analyze_oman_property response carrying an unbounded array. */
const PHASE_BREAKDOWN_LIMIT = 10;

interface HistoricalSalesContext {
  available: boolean;
  recordsAvailable: number;
  recentComparableSales: number;
  medianHistoricalPricePerSqmOMR: number | null;
  recentMedianPricePerSqmOMR: number | null;
  oldestRecordDate: string | null;
  latestRecordDate: string | null;
  sourceTypes: string[];
  priceSemantics: string[];
  phaseBreakdown: {
    phaseName: string; recordCount: number; medianPriceOMR: number; medianPricePerSqmOMR: number;
    oldestRecordDate: string; latestRecordDate: string;
  }[];
}

/** Section 6: the honest "no historical sales intelligence available" shape — used both when a
 *  location has no comparable coverage at all (the `!location.supported` early return) and when a
 *  supported location's provider chain simply has no real transaction-level history for it (e.g.
 *  manual/demo mode, or a database with no partner feed for this area/type yet). Never `null`
 *  itself, so a consumer can always destructure historicalSalesContext.* without a null check. */
const EMPTY_HISTORICAL_SALES_CONTEXT: HistoricalSalesContext = {
  available: false, recordsAvailable: 0, recentComparableSales: 0,
  medianHistoricalPricePerSqmOMR: null, recentMedianPricePerSqmOMR: null,
  oldestRecordDate: null, latestRecordDate: null, sourceTypes: [], priceSemantics: [], phaseBreakdown: []
};

/**
 * Section 6/7/8: a separate, additive enrichment of analyze_oman_property's output — never mixed
 * into market/pricePosition/comparablesSummary/confidence above, which remain driven exclusively
 * by selectComparables()'s current-comparable pool (MAX_DATA_AGE_DAYS=540) exactly as before. This
 * exists purely so an agent can distinguish "current comparable evidence" from "long-term
 * historical sales intelligence" (e.g. Al Mouj's 2006-2026 partner feed) without the two being
 * silently blended into one number.
 *
 * `recentComparableSales`/`recentMedianPricePerSqmOMR` still respect area/propertyType/size
 * similarity/bedrooms (comparables.ts's selectRecentSaleRecords, reusing the same tolerances as
 * current-comparable selection) — never "every historical sale within N days", per Section 7.
 */
async function buildHistoricalSalesContext(
  activeProvider: OmanPropertyDataProvider,
  query: OmanPropertyQuery,
  recentSalesDays: number
): Promise<HistoricalSalesContext> {
  const [historicalStats, recentRawPool] = await Promise.all([
    activeProvider.getHistoricalSaleStatistics(
      { area: query.area, propertyType: query.propertyType },
      { minPhaseSampleSize: PHASE_BREAKDOWN_MIN_SAMPLE, phaseBreakdownLimit: PHASE_BREAKDOWN_LIMIT }
    ),
    activeProvider.findRecentRawSaleRecords(query, recentSalesDays)
  ]);
  if (!historicalStats) return EMPTY_HISTORICAL_SALES_CONTEXT;

  const recentSelection = selectRecentSaleRecords(recentRawPool, query, recentSalesDays);
  const recentUsed = recentSelection.used;
  const recentPerSqmStats = computeRangeStats(recentUsed.map(r => r.priceOMR / r.sizeSqm));

  return {
    available: true,
    recordsAvailable: historicalStats.recordsAvailable,
    recentComparableSales: recentUsed.length,
    medianHistoricalPricePerSqmOMR: historicalStats.medianPricePerSqmOMR,
    recentMedianPricePerSqmOMR: recentPerSqmStats ? round(recentPerSqmStats.median) : null,
    oldestRecordDate: historicalStats.oldestRecordDate,
    latestRecordDate: historicalStats.latestRecordDate,
    sourceTypes: historicalStats.sourceTypes,
    priceSemantics: historicalStats.priceSemantics,
    phaseBreakdown: historicalStats.phaseBreakdown
  };
}

interface ProvenanceEntry { sourceType: SourceType; sourceName: string; sourceDate: string; recordCount: number }

/** Section 8: groups the records that actually backed this analysis by (sourceType, sourceName),
 *  reporting the most recent sourceDate in each group as "as of". Every market estimate in the
 *  response is traceable back to one or more of these entries — an agent can tell official
 *  statistics, listing asking prices, manual benchmark data and partner feeds apart even when
 *  several are merged together by CompositeOmanPropertyDataProvider. */
function buildProvenance(records: readonly { sourceType: SourceType; sourceName: string; sourceDate: string }[]): ProvenanceEntry[] {
  const groups = new Map<string, ProvenanceEntry>();
  for (const r of records) {
    const key = `${r.sourceType}::${r.sourceName}`;
    const existing = groups.get(key);
    if (existing) {
      existing.recordCount++;
      if (r.sourceDate > existing.sourceDate) existing.sourceDate = r.sourceDate;
    } else {
      groups.set(key, { sourceType: r.sourceType, sourceName: r.sourceName, sourceDate: r.sourceDate, recordCount: 1 });
    }
  }
  return [...groups.values()];
}

interface DataQuality {
  latestDataDate: string | null;
  dataFreshnessDays: number | null;
  sampleSize: number;
  sourceTypes: SourceType[];
  staleMarketData: boolean;
}

/** Phase 7: freshness/provenance-at-a-glance over the rental comparable sample — the sample that
 *  drives the headline market/investment figures (pricePosition has its own sale-comparable range
 *  reported separately). Computed even when the sample is below MIN_COMPARABLES, so an agent can
 *  see exactly what little data existed rather than a blanket null (Phase 7: "do not hide stale
 *  data"). */
function computeDataQuality(used: readonly ComparableRecordBase[], staleDays: number): DataQuality {
  if (used.length === 0) return { latestDataDate: null, dataFreshnessDays: null, sampleSize: 0, sourceTypes: [], staleMarketData: false };
  const sortedAges = used.map(r => r.listedDaysAgo).sort((a, b) => a - b);
  const mid = Math.floor(sortedAges.length / 2);
  const dataFreshnessDays = sortedAges.length % 2 === 0 ? Math.round((sortedAges[mid - 1]! + sortedAges[mid]!) / 2) : sortedAges[mid]!;
  const latestDataDate = used.reduce((latest, r) => (r.sourceDate > latest ? r.sourceDate : latest), used[0]!.sourceDate);
  const sourceTypes = [...new Set(used.map(r => r.sourceType))];
  return { latestDataDate, dataFreshnessDays, sampleSize: used.length, sourceTypes, staleMarketData: dataFreshnessDays > staleDays };
}

/**
 * Section 9: the single deterministic pipeline behind the analyze_oman_property capability.
 * Nothing here is an LLM call or a heuristic guess — every number is a documented, testable
 * formula over the input and the comparable sample selected by selectComparables(). See:
 *  - src/domain/oman/locations.ts for location normalization (Section 5)
 *  - src/domain/oman/comparables.ts for comparable selection/outlier removal (Section 6)
 *  - src/domain/oman/confidence.ts for the confidence engine (Section 7)
 *  - src/domain/oman/dataProviders.ts + fixtures.ts/marketStore.ts for where the data comes from
 *    (Section 4/15, Phase 5/6)
 *
 * Now async (Phase 1): every provider call is awaited, so a genuinely asynchronous data source
 * (DatabaseOmanPropertyDataProvider) fits the exact same pipeline as the synchronous fixture
 * provider used to.
 *
 * Split into `runOmanPropertyAnalysis(input, provider)` (the actual pipeline, taking an explicit
 * provider) and `analyzeOmanProperty(input)` (the capability's real entry point, which always
 * uses the module-level `provider` built from OMAN_PROPERTY_DATA_MODE at load time) purely for
 * testability: Phase 11's provider-mode/database/staleness tests call
 * `runOmanPropertyAnalysis` directly with a test-constructed provider (e.g. a
 * DatabaseOmanPropertyDataProvider over an in-memory repository), which needs no environment
 * variables, no live Postgres, and no module-reload trickery — while production behavior through
 * `analyzeOmanProperty`/the capability registry is completely unchanged.
 */
export async function runOmanPropertyAnalysis(input: unknown, activeProvider: OmanPropertyDataProvider, activeOfficialProvider: OfficialOmanDataProvider = officialProvider) {
  const p = omanPropertyInput.parse(input);
  const location = normalizeLocation({ governorate: p.governorate, wilayat: p.wilayat, area: p.area });
  const staleDays = getOmanMarketStaleDays();

  // NCSI integration: fetched in parallel with everything else below and awaited just before each
  // return point. Independent of `location.supported` — NCSI's own governorate coverage is not
  // bounded by this MVP's Muscat-area comparable coverage (Section 5: official context and
  // property-level comparables are separate concepts) — and never throws (see
  // OfficialOmanDataProvider.getMarketContext's doc comment), so a defensive `.catch` here is
  // belt-and-braces, not load-bearing.
  const officialMarketContextPromise = activeOfficialProvider
    .getMarketContext(location.governorate)
    .catch(() => unavailableOfficialContext(location.governorate, "official_source_temporarily_unavailable"));

  const assumptions: string[] = [];
  const riskFlags: string[] = [];
  const unavailableOutputs: string[] = [];

  if (location.wilayatMismatch) {
    riskFlags.push("wilayat_mismatch");
    assumptions.push(`Supplied wilayat "${p.wilayat}" did not match the recognized area's registry wilayat ("${location.wilayat}"); the area-level match was used.`);
  }

  const serviceCharge = p.optionalAnnualServiceChargeOMR;
  const maintenance = p.optionalAnnualMaintenanceOMR;
  const operatingCost = round((serviceCharge ?? 0) + (maintenance ?? 0));
  if (serviceCharge === undefined) assumptions.push("No annual service charge supplied; treated as 0 OMR in operating cost.");
  if (maintenance === undefined) assumptions.push("No annual maintenance cost supplied; treated as 0 OMR in operating cost.");

  const askingPricePerSqmOMR = round(p.askingPriceOMR / p.sizeSqm);
  const subjectProperty = {
    propertyType: p.propertyType,
    bedrooms: p.bedrooms ?? null,
    bathrooms: p.bathrooms ?? null,
    sizeSqm: p.sizeSqm,
    askingPriceOMR: p.askingPriceOMR,
    furnished: p.furnished ?? ("unspecified" as const)
  };
  const normalizedLocation = {
    governorate: location.governorate, wilayat: location.wilayat, area: location.area,
    inputArea: location.inputArea, matchType: location.matchType, supported: location.supported
  };

  // Section 10: an unsupported governorate or an unrecognized area means there is no comparable
  // data to look up at all — fail honestly rather than guessing. Deterministic figures that need
  // no market data (operating cost, asking price per sqm) are still returned.
  if (!location.supported) {
    riskFlags.push("unsupported_location");
    unavailableOutputs.push(
      "market.estimatedMonthlyRentOMR", "market.estimatedAnnualRentOMR",
      "investment.grossYieldPct", "investment.estimatedNetIncomeOMR", "investment.netYieldPct",
      "pricePosition.observedComparableRange", "pricePosition.marketPosition", "comparablesSummary"
    );
    assumptions.push(location.matchType === "unmatched"
      ? `Area "${location.inputArea}" is not in this MVP's supported Muscat area list; no comparable data is available for it.`
      : `Governorate "${p.governorate}" is not supported by this MVP; only Muscat governorate is covered.`);
    return {
      normalizedLocation, subjectProperty,
      market: { estimatedMonthlyRentOMR: null, estimatedAnnualRentOMR: null, comparableCount: 0, sampleSizeUsed: 0, dataFreshnessDays: null },
      investment: { grossYieldPct: null, estimatedOperatingCostOMR: operatingCost, estimatedNetIncomeOMR: null, netYieldPct: null },
      pricePosition: { askingPricePerSqmOMR, observedComparableRange: null, marketPosition: "insufficient_data" as const },
      comparablesSummary: null,
      riskFlags: [...new Set(riskFlags)],
      confidence: { score: 0, level: "insufficient" as const, reasons: ["Location is outside this MVP's supported coverage; no comparable data could be retrieved."] },
      provenance: [], assumptions, insufficientMarketData: true, unavailableOutputs, currency: "OMR" as const,
      dataQuality: { latestDataDate: null, dataFreshnessDays: null, sampleSize: 0, sourceTypes: [], staleMarketData: false },
      historicalSalesContext: EMPTY_HISTORICAL_SALES_CONTEXT,
      officialMarketContext: await officialMarketContextPromise
    };
  }

  const query: OmanPropertyQuery = { area: location.area, propertyType: p.propertyType, bedrooms: p.bedrooms, sizeSqm: p.sizeSqm, furnished: p.furnished };

  // Section 6: kicked off in parallel with the rental/sale comparable fetches below and awaited
  // just before the return — an entirely separate data path (never contributes to market/
  // pricePosition/comparablesSummary/confidence), so there is no ordering dependency on them.
  const historicalSalesContextPromise = buildHistoricalSalesContext(activeProvider, query, getOmanRecentSalesDays());

  // Rental side (drives market.* and investment.*)
  const rentalPool = await activeProvider.findRentalComparables(query);
  const rentalSelection = selectComparables(rentalPool, query, normalizedMonthlyRent);
  const rentalUsed = rentalSelection.used;
  const rentPerSqmValues = rentalUsed.map(r => normalizedMonthlyRent(r) / r.sizeSqm);
  const rentPerSqmStats = computeRangeStats(rentPerSqmValues);
  const insufficientRental = rentalUsed.length < MIN_COMPARABLES;

  if (rentalSelection.bedroomToleranceApplied) { riskFlags.push("bedroom_tolerance_applied"); assumptions.push("Bedroom-count tolerance (±1) was applied to the rental comparable sample because too few exact-bedroom matches were available."); }
  if (rentalSelection.furnishedFilterRelaxed) { riskFlags.push("furnished_filter_relaxed"); assumptions.push("Furnished-status filter was relaxed to any status for the rental comparable sample because too few exact-match records were available."); }
  if (rentalSelection.outliersRemoved > 0) { riskFlags.push("outliers_removed"); assumptions.push(`${rentalSelection.outliersRemoved} statistical outlier(s) were removed from the rental comparable sample.`); }

  // Phase 7: computed whenever there is any used sample at all, independent of whether it clears
  // MIN_COMPARABLES for a full market estimate — see computeDataQuality's doc comment.
  const dataQuality = computeDataQuality(rentalUsed, staleDays);
  const dataFreshnessDays = dataQuality.dataFreshnessDays;
  if (dataQuality.staleMarketData) {
    riskFlags.push("stale_market_data");
    assumptions.push(`The comparable sample's median data age (${dataFreshnessDays} day(s)) exceeds this deployment's staleness threshold (${staleDays} days); confidence was reduced accordingly.`);
  }

  const market = insufficientRental
    ? { estimatedMonthlyRentOMR: null, estimatedAnnualRentOMR: null, comparableCount: rentalSelection.candidatePool.length, sampleSizeUsed: rentalUsed.length, dataFreshnessDays: null }
    : {
        estimatedMonthlyRentOMR: {
          low: round(rentPerSqmStats!.low * p.sizeSqm), median: round(rentPerSqmStats!.median * p.sizeSqm), high: round(rentPerSqmStats!.high * p.sizeSqm)
        },
        estimatedAnnualRentOMR: round(rentPerSqmStats!.median * p.sizeSqm * 12),
        comparableCount: rentalSelection.candidatePool.length, sampleSizeUsed: rentalUsed.length, dataFreshnessDays
      };

  if (insufficientRental) {
    riskFlags.push("insufficient_rental_market_data");
    unavailableOutputs.push("market.estimatedMonthlyRentOMR", "market.estimatedAnnualRentOMR", "investment.grossYieldPct", "investment.estimatedNetIncomeOMR", "investment.netYieldPct", "comparablesSummary");
    assumptions.push(`Fewer than ${MIN_COMPARABLES} rental comparables were found for ${location.area} (${p.propertyType}); rent, yield and net-income figures are withheld rather than estimated from an inadequate sample.`);
  }

  const comparablesSummary = insufficientRental ? null : {
    medianRentPerSqm: round(rentPerSqmStats!.median), lowRentPerSqm: round(rentPerSqmStats!.low), highRentPerSqm: round(rentPerSqmStats!.high)
  };

  const grossYieldPct = market.estimatedAnnualRentOMR !== null ? round(market.estimatedAnnualRentOMR / p.askingPriceOMR * 100) : null;
  const estimatedNetIncomeOMR = market.estimatedAnnualRentOMR !== null ? round(market.estimatedAnnualRentOMR - operatingCost) : null;
  const netYieldPct = estimatedNetIncomeOMR !== null ? round(estimatedNetIncomeOMR / p.askingPriceOMR * 100) : null;
  const investment = { grossYieldPct, estimatedOperatingCostOMR: operatingCost, estimatedNetIncomeOMR, netYieldPct };

  // Sale side (drives pricePosition.*). Al Mouj production-readiness fix (furnished-null sale
  // comparables): uses selectSaleComparables(), NOT selectComparables() — furnished is never a
  // mandatory/exclusionary filter for sale comparables (see comparables.ts's doc comments), so a
  // real partner sale record with furnished: null (true of every Al Mouj sale) is no longer
  // dropped from pricePosition/observedComparableRange purely for missing furnishing data.
  const salePool = await activeProvider.findSaleComparables(query);
  const saleSelection = selectSaleComparables(salePool, query, r => r.askingPriceOMR);
  const saleUsed = saleSelection.used;
  if (saleSelection.outliersRemoved > 0 && !riskFlags.includes("outliers_removed")) { riskFlags.push("outliers_removed"); assumptions.push(`${saleSelection.outliersRemoved} statistical outlier(s) were removed from the sale comparable sample.`); }
  const salePerSqmStats = computeRangeStats(saleUsed.map(r => r.askingPriceOMR / r.sizeSqm));
  const insufficientSale = saleUsed.length < MIN_COMPARABLES;

  let observedComparableRange: { low: number; median: number; high: number } | null = null;
  let marketPosition: "below_market" | "at_market" | "above_market" | "insufficient_data" = "insufficient_data";
  if (insufficientSale) {
    riskFlags.push("insufficient_sale_market_data");
    unavailableOutputs.push("pricePosition.observedComparableRange", "pricePosition.marketPosition");
  } else {
    observedComparableRange = { low: round(salePerSqmStats!.low), median: round(salePerSqmStats!.median), high: round(salePerSqmStats!.high) };
    const lowerBand = salePerSqmStats!.median * (1 - AT_MARKET_BAND_PCT);
    const upperBand = salePerSqmStats!.median * (1 + AT_MARKET_BAND_PCT);
    marketPosition = askingPricePerSqmOMR < lowerBand ? "below_market" : askingPricePerSqmOMR > upperBand ? "above_market" : "at_market";
  }
  const pricePosition = { askingPricePerSqmOMR, observedComparableRange, marketPosition };

  // Phase 6: "demo_dataset_not_live_market_data" is preserved only when manual/demo data actually
  // contributed to the used samples that back this specific answer; a database-only (or
  // database-only-actually-returned-data) analysis never carries it, so an agent can tell a real
  // production answer apart from a demo one without inspecting every provenance entry by hand.
  const usedRecords = [...rentalUsed, ...saleUsed];
  const contributingSourceTypes = new Set(usedRecords.map(r => r.sourceType));
  if (contributingSourceTypes.has("manual_benchmark")) {
    riskFlags.push("demo_dataset_not_live_market_data");
    assumptions.push("Some or all comparable figures come from a curated demo/MVP benchmark dataset (see provenance); they are illustrative, not sourced from live listings or completed transactions.");
  }
  if ([...contributingSourceTypes].some(t => t === "listing_asking_price")) {
    assumptions.push("Listing-sourced comparable figures are asking prices, not confirmed completed-transaction prices.");
  }

  // Confidence (Section 7) — deterministic, based on the rental sample that actually drives
  // the headline market/investment figures. Al Mouj production-readiness fix (furnished-null sale
  // comparables): confidence is fed ONLY rentalSelection's factors, never anything from
  // saleSelection/saleUsed — sale-comparable furnished status (present, absent, or relaxed) has
  // never been a confidence input and still is not, so unknown sale furnishing is structurally
  // neutral here, exactly as required.
  const sizeDeviationRatios = rentalUsed.map(r => Math.abs(r.sizeSqm - p.sizeSqm) / p.sizeSqm);
  const bedroomExactMatchRatio = p.bedrooms !== undefined && rentalUsed.length > 0
    ? rentalUsed.filter(r => r.bedrooms === p.bedrooms).length / rentalUsed.length
    : null;
  const confidence: ConfidenceResult = computeConfidence({
    sampleSizeUsed: rentalUsed.length,
    dataFreshnessDays,
    perSqmValues: rentPerSqmValues,
    sizeDeviationRatios,
    bedroomExactMatchRatio,
    wilayatMismatch: location.wilayatMismatch,
    bedroomToleranceApplied: rentalSelection.bedroomToleranceApplied,
    furnishedFilterRelaxed: rentalSelection.furnishedFilterRelaxed,
    outliersRemoved: rentalSelection.outliersRemoved,
    stale: dataQuality.staleMarketData
  });

  const provenance = buildProvenance(usedRecords);
  const officialMarketContext: OfficialMarketContext = await officialMarketContextPromise;
  const historicalSalesContext = await historicalSalesContextPromise;

  return {
    normalizedLocation, subjectProperty, market, investment, pricePosition, comparablesSummary,
    riskFlags: [...new Set(riskFlags)], confidence, provenance, assumptions,
    insufficientMarketData: insufficientRental, unavailableOutputs, currency: "OMR" as const,
    dataQuality, historicalSalesContext, officialMarketContext
  };
}

/** The capability's real entry point (src/domain/capabilities.ts's `analyze_oman_property`
 *  execute()) — always runs against the module-level provider built from
 *  OMAN_PROPERTY_DATA_MODE. See runOmanPropertyAnalysis's doc comment for why the pipeline itself
 *  is a separate, provider-parameterized function. */
export async function analyzeOmanProperty(input: unknown) {
  return runOmanPropertyAnalysis(input, provider, officialProvider);
}

/** Free Preview (src/preview/) for analyze_oman_property. Cheap and REAL, not a stubbed-out
 *  execute(): normalizes the location (Section 5, pure/local) and looks up the same rental/sale
 *  comparable CANDIDATE POOLS the full pipeline selects from (`findRentalComparables`/
 *  `findSaleComparables` — a local/fixture or single indexed database query, exactly like
 *  search_oman_company's identity lookup) — but stops there: no outlier removal, no confidence
 *  scoring, no historicalSalesContext (2 extra provider calls), no NCSI official-context fetch,
 *  and none of the yield/price/operating-cost arithmetic. The preview reports how many comparable
 *  records exist and how fresh the newest one is — never the estimated market value, expected
 *  rent, yield, operating cost, comparable prices, or any investment recommendation, all of which
 *  stay exclusively in the paid result. */
export async function previewOmanProperty(input: unknown): Promise<CapabilityPreviewBody> {
  const p = omanPropertyInput.parse(input);
  const location = normalizeLocation({ governorate: p.governorate, wilayat: p.wilayat, area: p.area });
  const entity = `${p.propertyType} in ${location.area || p.area}, ${location.governorate || p.governorate}`;
  // Real output-schema top-level section names (schemas/omanOutputs.ts) that the paid result
  // populates — a static list, independent of this call's input, so it can never leak a
  // per-request finding.
  const availableSections = ["market", "investment", "pricePosition", "comparablesSummary", "historicalSalesContext", "officialMarketContext"];

  if (!location.supported) {
    return {
      capability: "analyze_oman_property", status: "limited", inputRecognized: true,
      preview: { entity, entityType: "property_location", coverageScore: 0, dataCoverage: "low", availableSections, signals: { locationSupported: false } }
    };
  }

  const query: OmanPropertyQuery = { area: location.area, propertyType: p.propertyType, bedrooms: p.bedrooms, sizeSqm: p.sizeSqm, furnished: p.furnished };
  const [rentalPool, salePool] = await Promise.all([provider.findRentalComparables(query), provider.findSaleComparables(query)]);
  const combined = [...rentalPool, ...salePool];
  const sourcesFound = combined.length;
  const freshestSourceDate = combined.reduce<string | null>((latest, r) => (!latest || r.sourceDate > latest ? r.sourceDate : latest), null);
  const coverageScore = Math.round(Math.min(1, sourcesFound / (MIN_COMPARABLES * 2)) * 100) / 100;
  const dataCoverage: "low" | "medium" | "high" = coverageScore >= 0.66 ? "high" : coverageScore >= 0.33 ? "medium" : "low";
  const status = rentalPool.length >= MIN_COMPARABLES || salePool.length >= MIN_COMPARABLES ? "available" : "limited";

  return {
    capability: "analyze_oman_property", status, inputRecognized: true,
    preview: {
      entity, entityType: "property_location", sourcesFound,
      ...(freshestSourceDate ? { freshestSourceDate } : {}),
      coverageScore, dataCoverage, availableSections,
      signals: { rentalComparablesFound: rentalPool.length, saleComparablesFound: salePool.length, locationSupported: true }
    }
  };
}
