import type { OmanMarketStatistics, OmanPropertyQuery, RawSaleRecord, RentalComparable, SaleComparable } from "./types.js";
import type { HistoricalSaleStatistics, MarketRecord, MarketRepositoryQuery, PropertyMarketRepository } from "./marketRepository.js";
import type { ComparableCache } from "./cache.js";
import { buildComparableCacheKey } from "./cache.js";
import { MAX_DATA_AGE_DAYS } from "./comparables.js";
import type { NcsiFieldMap } from "./officialContext.js";
import { findGovernorateRecord, mapNcsiRecordToContext, unavailableOfficialContext, type OfficialMarketContext } from "./officialContext.js";
import type { OfficialMarketContextCache } from "./officialContextCache.js";
import { NcsiApiError, NcsiClient } from "../../services/ncsi/ncsiClient.js";

/**
 * Section 4 / Phase 1: the seam between this capability's business logic (comparable selection,
 * normalization, confidence scoring — all in this same src/domain/oman/ directory) and wherever
 * comparable property records actually come from. Swapping the data source means writing a new
 * class that implements this interface and changing which provider(s)
 * CompositeOmanPropertyDataProvider is constructed with in src/services/omanProperty.ts — no
 * change to the selection algorithm, confidence engine, schemas, routes, MCP tool or any other
 * consumer.
 *
 * Every method here is now genuinely async (Phase 1's capability-execution contract widened to
 * `execute(input): Promise<output>` specifically to unblock this): DatabaseOmanPropertyDataProvider
 * below performs real database I/O; ManualDatasetProvider/OfficialOmanDataProvider/
 * ListingDataProvider still resolve synchronously-computed values, just wrapped in a Promise, so
 * every provider fits the exact same contract regardless of whether it actually awaits anything.
 */
export interface OmanPropertyDataProvider {
  /** Human-readable identity for logs/tests only — never surfaced to API callers directly. */
  readonly name: string;
  findRentalComparables(query: OmanPropertyQuery): Promise<readonly RentalComparable[]>;
  findSaleComparables(query: OmanPropertyQuery): Promise<readonly SaleComparable[]>;
  /** Pre-aggregated statistics, when a provider publishes them directly instead of (or as well
   *  as) raw records — e.g. an official dataset that only releases area-level medians. Returns
   *  null when the provider has no such aggregate. */
  getMarketStatistics(query: OmanPropertyQuery): Promise<OmanMarketStatistics | null>;
  /** Al Mouj historical-sales production-readiness pass (Section 6/8): accurate, DB-aggregated
   *  full-history figures for historicalSalesContext — see HistoricalSaleStatistics' doc comment.
   *  A provider with no genuine transaction-level record store (official statistics, the not-yet-
   *  integrated listing feed, the curated demo/MVP dataset) returns null: historicalSalesContext
   *  must never present demo/benchmark data as real historical sales intelligence. */
  getHistoricalSaleStatistics(
    query: Pick<OmanPropertyQuery, "area" | "propertyType">,
    options: { minPhaseSampleSize: number; phaseBreakdownLimit: number }
  ): Promise<HistoricalSaleStatistics | null>;
  /** Section 6/7 (continued): a raw, unfiltered-by-bedroom/furnished sale-record pool within
   *  `maxAgeDays` — feeds comparables.ts's selectRecentSaleRecords for historicalSalesContext's
   *  "recentComparableSales"/"recentMedianPricePerSqmOMR". Distinct from findSaleComparables()
   *  above (which excludes any record missing bedrooms/furnished, and applies comparables.ts's own
   *  fixed 540-day cutoff, not this operator-configurable window). Returns [] for a provider with
   *  no real record store, for the same reason as getHistoricalSaleStatistics above. */
  findRecentRawSaleRecords(query: OmanPropertyQuery, maxAgeDays: number): Promise<readonly RawSaleRecord[]>;
}

/** Governorate-record page size requested from NCSI when resolving official market context — the
 *  live API's documented max is 100 (see ncsiClient.ts's header); this MVP only ever needs to find
 *  one record matching "Muscat", but a single page keeps the query simple and well within that
 *  cap. */
const NCSI_GOVERNORATE_RECORDS_LIMIT = 100;

/**
 * Real integration with Oman's National Centre for Statistics and Information (NCSI) Open Data
 * Portal API (see src/services/ncsi/ncsiClient.ts). Two responsibilities are kept deliberately
 * separate:
 *
 *  - As an `OmanPropertyDataProvider` (the comparable-selection seam every other provider
 *    implements), it still always returns empty comparable arrays. NCSI publishes governorate-level
 *    aggregate statistics, never individual listing/transaction records — fabricating
 *    property-level comparables out of an aggregate price index would misrepresent the data
 *    (Section 3 of this feature's spec), so this half of the class is unchanged from the original
 *    always-empty seam.
 *  - `getMarketContext(governorate)` is the real, additive capability: it fetches NCSI's official
 *    aggregate statistics for the property's governorate and returns them as
 *    `OfficialMarketContext` (officialContext.ts) — surfaced in `analyze_oman_property`'s output as
 *    `officialMarketContext`, entirely separate from `market`/`pricePosition`/`comparablesSummary`.
 *
 * Never throws: any NCSI failure (misconfiguration, timeout, 5xx, malformed response, no matching
 * record) resolves to `unavailableOfficialContext(...)` rather than rejecting, so a temporarily
 * unreachable NCSI can never fail `analyze_oman_property` as a whole (Section 8 of this feature's
 * spec) — the comparable-based analysis proceeds exactly as it would if this provider did not
 * exist.
 */
export class OfficialOmanDataProvider implements OmanPropertyDataProvider {
  readonly name = "Official Oman statistics (National Centre for Statistics and Information)";
  private readonly client: NcsiClient | null;
  private readonly datasetId: string | null;
  private readonly fieldMap: NcsiFieldMap | null;
  private readonly cache?: OfficialMarketContextCache;

  constructor(options: { client?: NcsiClient | null; datasetId?: string | null; fieldMap?: NcsiFieldMap | null; cache?: OfficialMarketContextCache } = {}) {
    this.client = options.client ?? null;
    this.datasetId = options.datasetId ?? null;
    this.fieldMap = options.fieldMap ?? null;
    this.cache = options.cache;
  }

  async findRentalComparables(): Promise<readonly RentalComparable[]> { return []; }
  async findSaleComparables(): Promise<readonly SaleComparable[]> { return []; }
  async getMarketStatistics(): Promise<OmanMarketStatistics | null> { return null; }
  async getHistoricalSaleStatistics(): Promise<HistoricalSaleStatistics | null> { return null; }
  async findRecentRawSaleRecords(): Promise<readonly RawSaleRecord[]> { return []; }

  async getMarketContext(governorate: string): Promise<OfficialMarketContext> {
    if (!this.client || !this.datasetId || !this.fieldMap) return unavailableOfficialContext(governorate, "ncsi_not_configured");

    const cached = await this.cache?.get(governorate);
    if (cached) return cached;

    let context: OfficialMarketContext;
    try {
      const page = await this.client.getDatasetRecords(this.datasetId, { limit: NCSI_GOVERNORATE_RECORDS_LIMIT });
      const match = findGovernorateRecord(page.records, this.fieldMap, governorate);
      context = match
        ? mapNcsiRecordToContext(match, this.fieldMap, governorate, {
            datasetId: this.datasetId, datasetTitle: null, retrievedAt: page.retrievedAt,
            sourceUrl: `${this.client.baseUrl}/catalog/datasets/${this.datasetId}`
          })
        : unavailableOfficialContext(governorate, "no_data_for_governorate", page.retrievedAt);
    } catch (err) {
      // A request WAS attempted (and failed) here, unlike the "not configured" early return above
      // — so, unlike that case, this timestamps the (failed) attempt rather than reporting null.
      context = unavailableOfficialContext(governorate, classifyNcsiError(err), new Date().toISOString());
    }

    // Only cache genuine successes — a transient failure should be retried on the next call, not
    // pinned as "unavailable" for the full cache TTL.
    if (context.available) await this.cache?.set(governorate, context);
    return context;
  }
}

/**
 * A future integration with a licensed or approved property-listing feed (a partner API or data
 * license — never unauthorized scraping of a listings site, which this project deliberately does
 * not implement). Not integrated as of this MVP; always returns empty, honestly.
 */
export class ListingDataProvider implements OmanPropertyDataProvider {
  readonly name = "Licensed listing feed (not yet integrated)";
  async findRentalComparables(): Promise<readonly RentalComparable[]> { return []; }
  async findSaleComparables(): Promise<readonly SaleComparable[]> { return []; }
  async getMarketStatistics(): Promise<OmanMarketStatistics | null> { return null; }
  async getHistoricalSaleStatistics(): Promise<HistoricalSaleStatistics | null> { return null; }
  async findRecentRawSaleRecords(): Promise<readonly RawSaleRecord[]> { return []; }
}

/**
 * The curated benchmark dataset provider (src/domain/oman/fixtures.ts) covering the Muscat
 * areas/property types listed in locations.ts's MUSCAT_AREAS. Every record it returns carries
 * sourceType "manual_benchmark" and a sourceName that says, in plain words, that this is a
 * demo/MVP dataset — not live listings and not completed transactions (Section 15). Each record's
 * `listedDaysAgo` is computed dynamically from its fixed sourceDate at query time (see
 * fixtures.ts), so the dataset honestly ages.
 */
export class ManualDatasetProvider implements OmanPropertyDataProvider {
  readonly name = "Rafid curated Muscat benchmark dataset (demo/MVP)";
  constructor(
    private readonly rentals: readonly RentalComparable[],
    private readonly sales: readonly SaleComparable[]
  ) {}
  async findRentalComparables(query: OmanPropertyQuery): Promise<readonly RentalComparable[]> {
    return this.rentals.filter(r => r.area === query.area && r.propertyType === query.propertyType);
  }
  async findSaleComparables(query: OmanPropertyQuery): Promise<readonly SaleComparable[]> {
    return this.sales.filter(r => r.area === query.area && r.propertyType === query.propertyType);
  }
  async getMarketStatistics(): Promise<OmanMarketStatistics | null> { return null; }
  // Deliberate: this curated demo/MVP fixture dataset is illustrative benchmark data, never a real
  // transaction history — historicalSalesContext must never present it as one (see the interface
  // doc comment above).
  async getHistoricalSaleStatistics(): Promise<HistoricalSaleStatistics | null> { return null; }
  async findRecentRawSaleRecords(): Promise<readonly RawSaleRecord[]> { return []; }
}

/**
 * Phase 5: adapts a production `PropertyMarketRepository` (src/domain/oman/marketRepository.ts —
 * backed by PostgreSQL in src/db/marketStore.ts, or an in-memory implementation for tests/local
 * dev) into the `OmanPropertyDataProvider` shape the analysis service already knows how to use.
 *
 * This class deliberately does NOT re-implement bedroom/furnished/outlier filtering — it fetches
 * a candidate pool from the repository (area + property type + recency; see
 * PropertyMarketRepository's own doc comment on why that's broad enough) and maps each row to the
 * `RentalComparable`/`SaleComparable` shape comparables.ts already knows how to score. All actual
 * comparable-selection logic remains centralized in comparables.ts, untouched (Phase 5's explicit
 * requirement).
 *
 * A production record with no recorded bedroom count cannot be meaningfully compared against a
 * subject property by this MVP's selection algorithm (which matches on bedrooms for both rentals
 * and sales), so such records are excluded from the mapped pool rather than guessed at. A record
 * with no recorded FURNISHED status is excluded for rentals (furnished remains a genuinely
 * required/matched rental attribute) but NOT for sales — see findSaleComparables()'s own doc
 * comment and types.ts's SaleComparable: real partner sale feeds (Al Mouj's included) routinely
 * never track furnishing status for a property sale at all, and furnished is never a mandatory/
 * exclusionary sale-comparable attribute.
 *
 * `cache`, when supplied, memoizes the raw repository fetch (not the final scored/selected
 * result) for a short TTL — see cache.ts. Caching is optional and additive: omitting it changes
 * nothing about correctness, only repeated-query cost.
 */
export class DatabaseOmanPropertyDataProvider implements OmanPropertyDataProvider {
  readonly name: string;
  constructor(
    private readonly repository: PropertyMarketRepository,
    private readonly cache?: ComparableCache
  ) {
    this.name = `Database(${repository.name})`;
  }

  private async fetch(query: OmanPropertyQuery, transactionType: "rental" | "sale"): Promise<readonly MarketRecord[]> {
    const repoQuery: MarketRepositoryQuery = {
      normalizedArea: normalizedAreaOf(query.area), propertyType: query.propertyType, transactionType,
      bedrooms: query.bedrooms, sizeSqm: query.sizeSqm, furnished: query.furnished, maxAgeDays: MAX_DATA_AGE_DAYS
    };
    const cacheKey = this.cache ? buildComparableCacheKey({ ...query, transactionType }) : null;
    if (cacheKey) {
      const cached = await this.cache!.get(cacheKey);
      // The cache only ever stores what this class itself wrote via set() below, always a
      // MarketRecord[] — CacheableRecord is intentionally minimal (just `id`) so the interface
      // stays implementation-agnostic for a future RedisComparableCache; this cast reflects that
      // known invariant, not an unchecked assumption about external input.
      if (cached) return cached as readonly MarketRecord[];
    }
    const rows = transactionType === "rental" ? await this.repository.findRentalComparables(repoQuery) : await this.repository.findSaleComparables(repoQuery);
    if (cacheKey) await this.cache!.set(cacheKey, rows);
    return rows;
  }

  async findRentalComparables(query: OmanPropertyQuery): Promise<readonly RentalComparable[]> {
    const rows = await this.fetch(query, "rental");
    const rentals: RentalComparable[] = [];
    for (const r of rows) {
      if (r.bedrooms === null || r.furnished === null || r.rentPeriod === null) continue;
      rentals.push({
        id: r.id, area: query.area, propertyType: r.propertyType, bedrooms: r.bedrooms, sizeSqm: r.sizeSqm,
        furnished: r.furnished, listedDaysAgo: ageDays(r.observedAt), sourceType: r.sourceType, sourceName: r.sourceName,
        sourceDate: r.observedAt.slice(0, 10), rentAmountOMR: r.priceOMR, rentPeriod: r.rentPeriod
      });
    }
    return rentals;
  }
  /** Al Mouj production-readiness fix (furnished-null sale comparables): unlike
   *  findRentalComparables() above (unchanged), a sale record missing ONLY its furnished status is
   *  no longer excluded — furnished is nullable on SaleComparable (see types.ts) and is never a
   *  mandatory/exclusionary attribute for sale comparables (comparables.ts's
   *  selectSaleComparables() never inspects it). `bedrooms === null` is still excluded, unchanged:
   *  bedrooms remains a genuinely required/matched sale-comparable attribute, and this fix does not
   *  touch that. `null` is passed through as-is — never coerced to `false`/"unfurnished". */
  async findSaleComparables(query: OmanPropertyQuery): Promise<readonly SaleComparable[]> {
    const rows = await this.fetch(query, "sale");
    const sales: SaleComparable[] = [];
    for (const r of rows) {
      if (r.bedrooms === null) continue;
      sales.push({
        id: r.id, area: query.area, propertyType: r.propertyType, bedrooms: r.bedrooms, sizeSqm: r.sizeSqm,
        furnished: r.furnished, listedDaysAgo: ageDays(r.observedAt), sourceType: r.sourceType, sourceName: r.sourceName,
        sourceDate: r.observedAt.slice(0, 10), askingPriceOMR: r.priceOMR
      });
    }
    return sales;
  }
  async getMarketStatistics(query: OmanPropertyQuery): Promise<OmanMarketStatistics | null> {
    const stats = await this.repository.findMarketStatistics({
      normalizedArea: normalizedAreaOf(query.area), propertyType: query.propertyType, transactionType: "rental"
    });
    return stats ? { medianRentPerSqmOMR: stats.medianPricePerSqmOMR, sampleSize: stats.sampleSize, asOfDate: stats.asOfDate } : null;
  }

  async getHistoricalSaleStatistics(
    query: Pick<OmanPropertyQuery, "area" | "propertyType">,
    options: { minPhaseSampleSize: number; phaseBreakdownLimit: number }
  ): Promise<HistoricalSaleStatistics | null> {
    return this.repository.getHistoricalSaleStatistics(
      { normalizedArea: normalizedAreaOf(query.area), propertyType: query.propertyType },
      options
    );
  }

  /** Deliberately bypasses this class's own `fetch()`/cache (built around the narrower
   *  find*Comparables query shape/TTL) and calls the repository directly — this is a distinct,
   *  lower-frequency query shape (a much wider `maxAgeDays`, no bedrooms/sizeSqm/furnished
   *  pre-filter) that doesn't fit that cache's key space; not caching it is an acceptable, honest
   *  simplification rather than a second, drifting cache implementation. */
  async findRecentRawSaleRecords(query: OmanPropertyQuery, maxAgeDays: number): Promise<readonly RawSaleRecord[]> {
    const rows = await this.repository.findSaleComparables({
      normalizedArea: normalizedAreaOf(query.area), propertyType: query.propertyType, transactionType: "sale", maxAgeDays
    });
    return rows.map(r => ({
      id: r.id, area: query.area, propertyType: r.propertyType, bedrooms: r.bedrooms, sizeSqm: r.sizeSqm,
      priceOMR: r.priceOMR, listedDaysAgo: ageDays(r.observedAt), sourceType: r.sourceType, sourceName: r.sourceName,
      sourceDate: r.observedAt.slice(0, 10), metadata: r.metadata
    }));
  }
}

function classifyNcsiError(err: unknown): "ncsi_timeout" | "ncsi_malformed_response" | "official_source_temporarily_unavailable" {
  if (err instanceof NcsiApiError) {
    if (err.kind === "timeout") return "ncsi_timeout";
    if (err.kind === "malformed_response") return "ncsi_malformed_response";
  }
  return "official_source_temporarily_unavailable";
}

function ageDays(observedAtIso: string): number {
  return Math.max(0, Math.round((Date.now() - Date.parse(observedAtIso)) / 86_400_000));
}

/** `query.area` here is already the canonical registry name (the service normalizes location
 *  before building the query) — this just applies the same lowercase/trim/collapse rule the
 *  import pipeline used to compute `normalized_area`, so the two always agree without importing
 *  locations.ts's private `normalize` twice under different names. */
function normalizedAreaOf(canonicalArea: string): string {
  return canonicalArea.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Merges results from an ordered list of providers so the analysis service never has to know how
 * many sources are configured or which one produced a given record — each record already carries
 * its own sourceType/sourceName/sourceDate (see ComparableRecordBase in types.ts), so provenance
 * survives the merge untouched. Deduplicates by `id` (first occurrence wins — so provider order
 * matters: see Phase 6's OMAN_PROPERTY_DATA_MODE="composite", which puts the database provider
 * first and the manual/demo provider last, so real data always wins over demo data for the same
 * id if both ever collided).
 *
 * A single provider's rejection (e.g. a database connection failure) is caught and treated as "no
 * records from that provider" rather than failing the whole analysis — this is a deliberate
 * graceful-degradation choice (a transient DB outage should degrade to whatever other providers
 * can still answer, not 500 the entire capability); it is never used to hide a genuine data
 * problem, since every record's own provenance is still reported exactly as returned.
 */
export class CompositeOmanPropertyDataProvider implements OmanPropertyDataProvider {
  readonly name: string;
  constructor(private readonly providers: readonly OmanPropertyDataProvider[]) {
    this.name = `Composite(${providers.map(p => p.name).join(", ")})`;
  }
  async findRentalComparables(query: OmanPropertyQuery): Promise<readonly RentalComparable[]> {
    const results = await Promise.all(this.providers.map(p => p.findRentalComparables(query).catch(() => [] as readonly RentalComparable[])));
    return dedupeById(results.flat());
  }
  async findSaleComparables(query: OmanPropertyQuery): Promise<readonly SaleComparable[]> {
    const results = await Promise.all(this.providers.map(p => p.findSaleComparables(query).catch(() => [] as readonly SaleComparable[])));
    return dedupeById(results.flat());
  }
  async getMarketStatistics(query: OmanPropertyQuery): Promise<OmanMarketStatistics | null> {
    for (const provider of this.providers) {
      const stats = await provider.getMarketStatistics(query).catch(() => null);
      if (stats) return stats;
    }
    return null;
  }
  async getHistoricalSaleStatistics(
    query: Pick<OmanPropertyQuery, "area" | "propertyType">,
    options: { minPhaseSampleSize: number; phaseBreakdownLimit: number }
  ): Promise<HistoricalSaleStatistics | null> {
    for (const provider of this.providers) {
      const stats = await provider.getHistoricalSaleStatistics(query, options).catch(() => null);
      if (stats) return stats;
    }
    return null;
  }
  async findRecentRawSaleRecords(query: OmanPropertyQuery, maxAgeDays: number): Promise<readonly RawSaleRecord[]> {
    const results = await Promise.all(this.providers.map(p => p.findRecentRawSaleRecords(query, maxAgeDays).catch(() => [] as readonly RawSaleRecord[])));
    return dedupeById(results.flat());
  }
}

function dedupeById<T extends { id: string }>(records: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const record of records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    result.push(record);
  }
  return result;
}
