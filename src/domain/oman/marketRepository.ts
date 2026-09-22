import type { FurnishedStatus, PropertyType, RentPeriod, SourceType } from "./types.js";

/**
 * Phase 2/3: the seam between the Oman property-analysis business logic (unchanged — comparable
 * selection, outlier removal, confidence scoring all still live in comparables.ts/confidence.ts)
 * and a real, production data store. This interface is deliberately independent of PostgreSQL —
 * or any other engine: `src/services/omanProperty.ts` (via DatabaseOmanPropertyDataProvider, see
 * dataProviders.ts) only ever depends on `PropertyMarketRepository`, never on `pg` or a
 * connection string directly. `src/db/marketStore.ts` provides the real PostgreSQL-backed
 * implementation; `MemoryPropertyMarketRepository` below is a full in-memory implementation used
 * by tests and available as a lightweight non-Postgres option.
 *
 * A repository record (`MarketRecord`) is intentionally flatter/more generic than the
 * `RentalComparable`/`SaleComparable` shapes comparables.ts operates on — it is the row shape a
 * database table (or an imported CSV/JSON file) naturally has. DatabaseOmanPropertyDataProvider
 * is what maps a `MarketRecord` into the `RentalComparable`/`SaleComparable` shape the existing,
 * unchanged selection/confidence code expects.
 */

export type TransactionType = "rental" | "sale";

/** The data a caller supplies to add or update one market record — everything a
 *  `MarketRecord` has except its generated `id` and `ingestedAt`. Used by the import pipeline
 *  (importPipeline.ts) and by any future direct-write integration (a partner feed webhook,
 *  a future admin tool). */
export interface MarketRecordInput {
  governorate: string;
  wilayat: string | null;
  /** Free-text area exactly as the source reported it (e.g. "The Wave", "الموج"). */
  area: string;
  /** Canonical, normalized area name from src/domain/oman/locations.ts's registry — lowercased/
   *  trimmed/whitespace-collapsed (see `normalize()` there) so it can be indexed and matched
   *  consistently regardless of casing or spacing. Computed by the import pipeline via
   *  `resolveAreaName()`; never guessed by the repository itself. */
  normalizedArea: string;
  propertyType: PropertyType;
  bedrooms: number | null;
  bathrooms: number | null;
  sizeSqm: number;
  transactionType: TransactionType;
  priceOMR: number;
  /** Required when transactionType is "rental"; must be null for "sale" — enforced both by the
   *  import validator and by a database CHECK constraint (marketSchema.ts). */
  rentPeriod: RentPeriod | null;
  furnished: FurnishedStatus | null;
  sourceType: SourceType;
  sourceName: string;
  /** The source system's own identifier for this record, when it has one (a listing ID, a
   *  statistics-release row number). Combined with sourceName for deduplication — see
   *  upsertMarketRecords(). Null for a source that has no stable per-record identifier. */
  sourceRecordId: string | null;
  sourceUrl: string | null;
  /** ISO date/timestamp the record represents (when the listing was observed, the statistics
   *  release date, etc.) — NOT when it was imported into Rafid (see `ingestedAt`). */
  observedAt: string;
  /** Free-form, source-specific extra detail that doesn't warrant its own column (e.g. a
   *  listing's original raw fields). Never used by comparable selection/scoring — informational
   *  only. */
  metadata: Record<string, unknown>;
  /** Partner Data Feed (Section 2): the enrolled partner (data_partners.partner_id) this record is
   *  attributable to, when it came through the partner ingestion endpoint or a partner-attributed
   *  bulk CLI import — see importPipeline.ts's ImportOptions and src/domain/oman/partners.ts.
   *  Null/undefined for official statistics, the curated manual benchmark, and any other
   *  non-partner source. Optional so every pre-existing `MarketRecordInput` literal (fixtures,
   *  tests) keeps compiling unchanged. */
  partnerId?: string | null;
  /** Section 7: this record's deterministic, non-LLM data-quality score in [0,1] — see
   *  dataQualityScore.ts. Populated by importMarketRecords() for every record it writes; optional
   *  (and null for any record written some other way) for the same backward-compatibility reason
   *  as `partnerId`. */
  dataQualityScore?: number | null;
}

export interface MarketRecord extends MarketRecordInput {
  id: string;
  /** When Rafid's own store first saw this record — distinct from `observedAt`. */
  ingestedAt: string;
}

export interface MarketRepositoryQuery {
  normalizedArea: string;
  propertyType: PropertyType;
  transactionType: TransactionType;
  /** Optional pre-filters the repository MAY apply for query efficiency (e.g. a WHERE clause on
   *  an indexed column) — but see the doc comment on findRentalComparables/findSaleComparables
   *  below: the repository must still return a broad-enough candidate pool for the analysis
   *  service's own tolerance/relaxation logic (comparables.ts) to work correctly. A repository
   *  is free to ignore any of these and return the full area+type+transactionType pool instead. */
  bedrooms?: number;
  sizeSqm?: number;
  furnished?: FurnishedStatus;
  /** Only records observed within this many days of "now" — mirrors comparables.ts's
   *  MAX_DATA_AGE_DAYS recency cutoff, applied at the repository level for efficiency so a huge
   *  production table doesn't return years of stale rows just to have the service discard them. */
  maxAgeDays?: number;
}

export interface MarketStatistics {
  medianPricePerSqmOMR: number;
  sampleSize: number;
  asOfDate: string;
}

export interface UpsertResult {
  inserted: number;
  updated: number;
  /** Rows deliberately not written (e.g. a duplicate within the same batch that was already
   *  merged into an earlier row) — distinct from validation rejects, which the import pipeline
   *  (importPipeline.ts) tracks separately before a record ever reaches the repository. */
  skipped: number;
}

/** Section 9's safe, cross-partner aggregate — deliberately excludes anything partner-identifying
 *  or partner-secret (Section 9: "do not expose individual partner secrets"); a per-partner view
 *  belongs to PartnerRepository.listWithStats(), never here. `partners` (a count of *registered*
 *  partners, as opposed to how many have contributed records) is intentionally NOT part of this
 *  shape — it comes from PartnerRepository.list() and is assembled by the route handler
 *  (src/api/marketDataRoutes.ts) alongside this object, keeping the market-record repository
 *  independent of partner administration. */
export interface MarketDataAggregateStatus {
  records: number;
  rentalRecords: number;
  saleRecords: number;
  areas: number;
  latestDataDate: string | null;
  sourceTypes: string[];
}

/** Section 7: per-partner aggregate data-quality metrics, exposed internally (never publicly) so an
 *  operator can judge a partner's feed quality without reading individual records. Every field is
 *  a plain aggregate over `data_quality_score` (Section 7's existing per-record score,
 *  dataQualityScore.ts) and the record's own completeness fields — nothing here is partner-secret
 *  or record-body content. `recordCount` of 0 means every rate/percentage is reported as 0 rather
 *  than NaN/null, so a brand-new partner with no accepted records yet still gets a well-formed
 *  response. */
export interface PartnerDataQualitySummary {
  recordCount: number;
  averageDataQualityScore: number;
  percentageAbove80: number;
  percentageBelow50: number;
  missingBedroomRate: number;
  missingBathroomRate: number;
  missingFurnishedRate: number;
}

const EMPTY_QUALITY_SUMMARY: PartnerDataQualitySummary = {
  recordCount: 0, averageDataQualityScore: 0, percentageAbove80: 0, percentageBelow50: 0,
  missingBedroomRate: 0, missingBathroomRate: 0, missingFurnishedRate: 0
};

/** Al Mouj historical-sales production-readiness pass (Section 8): a named phase's completed-sale
 *  statistics — only ever reported when `recordCount` meets the caller's minimum sample threshold
 *  (comparables.ts's MIN_COMPARABLES), so a one-off sale is never presented as a "phase trend". */
export interface PhaseSaleStatistics {
  phaseName: string;
  recordCount: number;
  medianPriceOMR: number;
  medianPricePerSqmOMR: number;
  oldestRecordDate: string;
  latestRecordDate: string;
}

/** Section 6: full-history, DB-side-aggregated figures for an area+propertyType's completed sale
 *  records — deliberately NOT derived from findSaleComparables()'s candidate-pool rows, which are
 *  capped (MAX_CANDIDATE_ROWS in marketStore.ts) and ordered most-recent-first for comparable
 *  SELECTION, not accurate historical AGGREGATION; a naive reuse would silently under-report
 *  recordsAvailable and, worse, report the wrong oldestRecordDate for any area+propertyType with
 *  more history than the cap. Implementations should compute this with real database aggregation
 *  (COUNT/MIN/MAX/percentile_cont, GROUP BY for phaseBreakdown) rather than loading every row into
 *  memory — same principle as getPartnerQualitySummary above. */
export interface HistoricalSaleStatistics {
  recordsAvailable: number;
  oldestRecordDate: string | null;
  latestRecordDate: string | null;
  medianPricePerSqmOMR: number | null;
  /** Distinct sourceType values contributing, so historicalSalesContext can honestly report where
   *  this history comes from (e.g. exclusively "partner_feed" for Al Mouj today). */
  sourceTypes: string[];
  /** Distinct `metadata.saleRecordType` values found across the matching records (e.g.
   *  "contracted_unit_price") — lets a caller see, without guessing, what kind of price this
   *  history actually represents. Never includes a value this repository invented. */
  priceSemantics: string[];
  /** Section 8: per-phase breakdown, already filtered to phases meeting the caller-supplied
   *  minimum sample size and capped to `phaseBreakdownLimit`, sorted by recordCount descending —
   *  empty when no `metadata.phaseName` is present on any matching record (true for every source
   *  except a phased development feed like Al Mouj's). */
  phaseBreakdown: PhaseSaleStatistics[];
}

export interface PropertyMarketRepository {
  readonly name: string;
  /**
   * Returns a candidate pool of rental records for the given area/property type — broad enough
   * (mirroring the "hard" structural filters in comparables.ts: area, property type, recency,
   * and optionally size tolerance) that the analysis service's own bedroom/furnished tolerance
   * relaxation and IQR outlier removal have real data to work with. The repository must NOT
   * itself apply the bedroom/furnished/outlier logic — that stays centralized in comparables.ts
   * (Phase 5's explicit "do not duplicate the existing comparable-selection rules").
   */
  findRentalComparables(query: MarketRepositoryQuery): Promise<readonly MarketRecord[]>;
  findSaleComparables(query: MarketRepositoryQuery): Promise<readonly MarketRecord[]>;
  /** Insert-or-update records, deduplicating on (sourceName, sourceRecordId) where both are
   *  present; a record with no sourceRecordId is always inserted as new (it cannot be safely
   *  matched against a prior import — see importPipeline.ts's dedup notes). */
  upsertMarketRecords(records: readonly MarketRecordInput[]): Promise<UpsertResult>;
  findMarketStatistics(query: MarketRepositoryQuery): Promise<MarketStatistics | null>;
  /** ISO timestamp of the single most recently observed record matching this area/type/
   *  transactionType, or null if none exist. Used for freshness/staleness reporting (Phase 7)
   *  independent of which specific comparables end up selected. */
  getLatestDataTimestamp(query: Pick<MarketRepositoryQuery, "normalizedArea" | "propertyType" | "transactionType">): Promise<string | null>;
  /** Section 9: safe, cross-partner aggregate figures for `GET /api/v1/internal/market-data/status`
   *  — see MarketDataAggregateStatus's doc comment for exactly what this excludes. */
  getAggregateStatus(): Promise<MarketDataAggregateStatus>;
  /** Section 7: aggregate data-quality metrics over every record attributed to `partnerId` — see
   *  PartnerDataQualitySummary's doc comment. Implementations should prefer database-side
   *  aggregation (a single SQL query) over reading every row into memory. */
  getPartnerQualitySummary(partnerId: string): Promise<PartnerDataQualitySummary>;
  /** Section 6/8 (Al Mouj historical-sales production-readiness pass): accurate, DB-aggregated
   *  full-history figures for an area+propertyType's completed sales — see HistoricalSaleStatistics'
   *  doc comment for why this is a distinct method from findSaleComparables(), not a reuse of its
   *  capped candidate pool. `minPhaseSampleSize`/`phaseBreakdownLimit` bound the phaseBreakdown
   *  array (a phase below the minimum is omitted entirely — "do not claim a phase trend when the
   *  sample is insufficient" — never included with a caveat). Returns null when there are zero
   *  matching sale records at all (distinct from a non-null result whose phaseBreakdown is empty,
   *  which means records exist but none carry phase metadata). */
  getHistoricalSaleStatistics(
    query: Pick<MarketRepositoryQuery, "normalizedArea" | "propertyType">,
    options: { minPhaseSampleSize: number; phaseBreakdownLimit: number }
  ): Promise<HistoricalSaleStatistics | null>;
}

function matchesQuery(record: MarketRecord, query: MarketRepositoryQuery, transactionType: TransactionType): boolean {
  if (record.transactionType !== transactionType) return false;
  if (record.normalizedArea !== query.normalizedArea) return false;
  if (record.propertyType !== query.propertyType) return false;
  if (query.maxAgeDays !== undefined) {
    const ageDays = Math.max(0, Math.round((Date.now() - Date.parse(record.observedAt)) / 86_400_000));
    if (ageDays > query.maxAgeDays) return false;
  }
  return true;
}

/**
 * A full, dependency-free implementation of PropertyMarketRepository, backed by an in-memory
 * array. Used by tests (repository filtering, dedup, import-pipeline tests all run against this
 * without needing a live Postgres instance — matching how ManualDatasetProvider needs no external
 * service either) and available as a genuine, if non-durable, "database" mode for local
 * development without provisioning Postgres.
 */
export class MemoryPropertyMarketRepository implements PropertyMarketRepository {
  readonly name = "In-memory market repository (non-durable)";
  private records: MarketRecord[] = [];
  private nextId = 1;

  async findRentalComparables(query: MarketRepositoryQuery): Promise<readonly MarketRecord[]> {
    return this.records.filter(r => matchesQuery(r, query, "rental"));
  }
  async findSaleComparables(query: MarketRepositoryQuery): Promise<readonly MarketRecord[]> {
    return this.records.filter(r => matchesQuery(r, query, "sale"));
  }
  async upsertMarketRecords(inputs: readonly MarketRecordInput[]): Promise<UpsertResult> {
    let inserted = 0, updated = 0;
    for (const input of inputs) {
      const dedupeKey = input.sourceRecordId ? `${input.sourceName}::${input.sourceRecordId}` : null;
      const existingIndex = dedupeKey
        ? this.records.findIndex(r => r.sourceRecordId && `${r.sourceName}::${r.sourceRecordId}` === dedupeKey)
        : -1;
      if (existingIndex >= 0) {
        this.records[existingIndex] = { ...input, id: this.records[existingIndex]!.id, ingestedAt: this.records[existingIndex]!.ingestedAt };
        updated++;
      } else {
        this.records.push({ ...input, id: `mem-${this.nextId++}`, ingestedAt: new Date().toISOString() });
        inserted++;
      }
    }
    return { inserted, updated, skipped: 0 };
  }
  async findMarketStatistics(query: MarketRepositoryQuery): Promise<MarketStatistics | null> {
    const matches = this.records.filter(r => matchesQuery(r, query, query.transactionType));
    if (matches.length === 0) return null;
    const perSqm = matches.map(r => r.priceOMR / r.sizeSqm).sort((a, b) => a - b);
    const mid = Math.floor(perSqm.length / 2);
    const median = perSqm.length % 2 === 0 ? (perSqm[mid - 1]! + perSqm[mid]!) / 2 : perSqm[mid]!;
    const latest = matches.reduce((a, b) => (a.observedAt > b.observedAt ? a : b));
    return { medianPricePerSqmOMR: Math.round(median * 100) / 100, sampleSize: matches.length, asOfDate: latest.observedAt };
  }
  async getLatestDataTimestamp(query: Pick<MarketRepositoryQuery, "normalizedArea" | "propertyType" | "transactionType">): Promise<string | null> {
    const matches = this.records.filter(r => r.normalizedArea === query.normalizedArea && r.propertyType === query.propertyType && r.transactionType === query.transactionType);
    if (matches.length === 0) return null;
    return matches.reduce((a, b) => (a.observedAt > b.observedAt ? a : b)).observedAt;
  }
  async getAggregateStatus(): Promise<MarketDataAggregateStatus> {
    const records = this.records.length;
    const rentalRecords = this.records.filter(r => r.transactionType === "rental").length;
    const saleRecords = this.records.filter(r => r.transactionType === "sale").length;
    const areas = new Set(this.records.map(r => r.normalizedArea)).size;
    const latestDataDate = records === 0 ? null : this.records.reduce((a, b) => (a.observedAt > b.observedAt ? a : b)).observedAt;
    const sourceTypes = [...new Set(this.records.map(r => r.sourceType))];
    return { records, rentalRecords, saleRecords, areas, latestDataDate, sourceTypes };
  }
  async getPartnerQualitySummary(partnerId: string): Promise<PartnerDataQualitySummary> {
    const matches = this.records.filter(r => r.partnerId === partnerId);
    if (matches.length === 0) return { ...EMPTY_QUALITY_SUMMARY };
    const scores = matches.map(r => r.dataQualityScore ?? 0);
    const round2 = (n: number) => Math.round(n * 100) / 100;
    return {
      recordCount: matches.length,
      averageDataQualityScore: round2(scores.reduce((a, b) => a + b, 0) / matches.length),
      percentageAbove80: round2((scores.filter(s => s > 0.8).length / matches.length) * 100),
      percentageBelow50: round2((scores.filter(s => s < 0.5).length / matches.length) * 100),
      missingBedroomRate: round2((matches.filter(r => r.bedrooms === null).length / matches.length) * 100),
      missingBathroomRate: round2((matches.filter(r => r.bathrooms === null).length / matches.length) * 100),
      missingFurnishedRate: round2((matches.filter(r => r.furnished === null).length / matches.length) * 100)
    };
  }
  async getHistoricalSaleStatistics(
    query: Pick<MarketRepositoryQuery, "normalizedArea" | "propertyType">,
    options: { minPhaseSampleSize: number; phaseBreakdownLimit: number }
  ): Promise<HistoricalSaleStatistics | null> {
    const matches = this.records.filter(r =>
      r.transactionType === "sale" && r.normalizedArea === query.normalizedArea && r.propertyType === query.propertyType
    );
    if (matches.length === 0) return null;

    const median = (values: number[]): number => {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
    };
    const round2 = (n: number) => Math.round(n * 100) / 100;

    const perSqm = matches.map(r => r.priceOMR / r.sizeSqm);
    const oldest = matches.reduce((a, b) => (a.observedAt < b.observedAt ? a : b)).observedAt;
    const latest = matches.reduce((a, b) => (a.observedAt > b.observedAt ? a : b)).observedAt;
    const sourceTypes = [...new Set(matches.map(r => r.sourceType))];
    const priceSemantics = [...new Set(
      matches.map(r => r.metadata?.["saleRecordType"]).filter((v): v is string => typeof v === "string")
    )];

    const byPhase = new Map<string, MarketRecord[]>();
    for (const r of matches) {
      const phaseName = r.metadata?.["phaseName"];
      if (typeof phaseName !== "string" || !phaseName) continue;
      const list = byPhase.get(phaseName) ?? [];
      list.push(r);
      byPhase.set(phaseName, list);
    }
    const phaseBreakdown: PhaseSaleStatistics[] = [...byPhase.entries()]
      .filter(([, records]) => records.length >= options.minPhaseSampleSize)
      .map(([phaseName, records]) => ({
        phaseName,
        recordCount: records.length,
        medianPriceOMR: round2(median(records.map(r => r.priceOMR))),
        medianPricePerSqmOMR: round2(median(records.map(r => r.priceOMR / r.sizeSqm))),
        oldestRecordDate: records.reduce((a, b) => (a.observedAt < b.observedAt ? a : b)).observedAt,
        latestRecordDate: records.reduce((a, b) => (a.observedAt > b.observedAt ? a : b)).observedAt
      }))
      .sort((a, b) => b.recordCount - a.recordCount)
      .slice(0, options.phaseBreakdownLimit);

    return {
      recordsAvailable: matches.length,
      oldestRecordDate: oldest,
      latestRecordDate: latest,
      medianPricePerSqmOMR: round2(median(perSqm)),
      sourceTypes,
      priceSemantics,
      phaseBreakdown
    };
  }
  /** Test/dev-only escape hatch to inspect what's stored — not part of the interface. */
  all(): readonly MarketRecord[] { return this.records; }
}
