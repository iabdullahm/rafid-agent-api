import { Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { marketSchema } from "./marketSchema.js";
import { partnerSchema } from "./partnerSchema.js";
import { partnerOpsSchema } from "./partnerOpsSchema.js";
import { partnerFeedSchema } from "./partnerFeedSchema.js";
import { marketSizeBoundsFix } from "./marketSizeBoundsFix.js";
import type {
  HistoricalSaleStatistics, MarketDataAggregateStatus, MarketRecord, MarketRecordInput, MarketRepositoryQuery,
  MarketStatistics, PartnerDataQualitySummary, PhaseSaleStatistics, PropertyMarketRepository, TransactionType, UpsertResult
} from "../domain/oman/marketRepository.js";

/** Applied in order against the independent `rafid_market_migrations` ledger — see migrate()'s
 *  doc comment. Adding a future version means appending here, never editing an already-applied
 *  entry's `sql`. */
const MIGRATIONS: readonly { version: number; sql: string }[] = [
  { version: 1, sql: marketSchema },
  { version: 2, sql: partnerSchema },
  { version: 3, sql: partnerOpsSchema },
  { version: 4, sql: partnerFeedSchema },
  { version: 5, sql: marketSizeBoundsFix }
];

/** Safety valve on a single comparable-pool fetch: a genuinely well-covered Muscat neighborhood
 *  should never need more than a few hundred records to produce a stable sample; this bounds
 *  worst-case query cost on a large production table without changing any selection semantics
 *  (comparables.ts still does its own filtering/outlier removal over whatever is returned). */
const MAX_CANDIDATE_ROWS = 500;

function toRecord(row: Record<string, unknown>): MarketRecord {
  return {
    id: row.id as string,
    governorate: row.governorate as string,
    wilayat: (row.wilayat as string | null) ?? null,
    area: row.area as string,
    normalizedArea: row.normalized_area as string,
    propertyType: row.property_type as MarketRecordInput["propertyType"],
    bedrooms: row.bedrooms === null ? null : Number(row.bedrooms),
    bathrooms: row.bathrooms === null ? null : Number(row.bathrooms),
    sizeSqm: Number(row.size_sqm),
    transactionType: row.transaction_type as TransactionType,
    priceOMR: Number(row.price_omr),
    rentPeriod: (row.rent_period as MarketRecordInput["rentPeriod"]) ?? null,
    furnished: (row.furnished as MarketRecordInput["furnished"]) ?? null,
    sourceType: row.source_type as MarketRecordInput["sourceType"],
    sourceName: row.source_name as string,
    sourceRecordId: (row.source_record_id as string | null) ?? null,
    sourceUrl: (row.source_url as string | null) ?? null,
    observedAt: (row.observed_at as Date).toISOString(),
    ingestedAt: (row.ingested_at as Date).toISOString(),
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    partnerId: (row.partner_id as string | null) ?? null,
    dataQualityScore: row.data_quality_score === null || row.data_quality_score === undefined ? null : Number(row.data_quality_score)
  };
}

/**
 * Phase 5 (repository half): the real, PostgreSQL-backed PropertyMarketRepository. Reuses the
 * project's existing pg-Pool-per-store pattern (src/db/store.ts) but with its own migration
 * ledger (`rafid_market_migrations`) and its own advisory-lock number (74382002 — distinct from
 * store.ts's 74382001) so market-data migrations and customer/billing migrations never contend
 * for the same lock or table, and can be run/rolled back independently.
 *
 * findRentalComparables/findSaleComparables deliberately apply only the "hard" filters (area,
 * property type, transaction type, recency) at the SQL level and return the matching rows —
 * every other filter (size tolerance, bedroom/furnished relaxation, outlier removal) stays
 * exactly where it already lives, in src/domain/oman/comparables.ts, so this class cannot drift
 * from or duplicate that logic (Phase 5's explicit requirement).
 */
export class PostgresPropertyMarketRepository implements PropertyMarketRepository {
  readonly name = "PostgreSQL property_market_records";
  readonly pool: Pool;
  constructor(url: string) {
    this.pool = new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 5000, statement_timeout: 10000, idle_in_transaction_session_timeout: 10000 });
    this.pool.on("error", () => process.stderr.write("Market database connection failure\n"));
  }
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try { await c.query("BEGIN"); const result = await fn(c); await c.query("COMMIT"); return result; }
    catch (error) { await c.query("ROLLBACK").catch(() => {}); throw error; }
    finally { c.release(); }
  }
  /** Restructured (Partner Data Feed layer) from a single hardcoded version check into a loop over
   *  MIGRATIONS, so adding the partner schema (version 2) never disturbs an already-applied
   *  version-1 deployment: each version is checked and applied independently, in order, against
   *  the same `rafid_market_migrations` ledger. */
  async migrate() {
    await this.transaction(async c => {
      await c.query("SELECT pg_advisory_xact_lock(74382002)");
      await c.query("CREATE TABLE IF NOT EXISTS rafid_market_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      for (const migration of MIGRATIONS) {
        const existing = await c.query("SELECT version FROM rafid_market_migrations WHERE version=$1", [migration.version]);
        if (!existing.rowCount) { await c.query(migration.sql); await c.query("INSERT INTO rafid_market_migrations(version) VALUES($1)", [migration.version]); }
      }
    });
  }
  async ready() {
    const latestVersion = MIGRATIONS[MIGRATIONS.length - 1]!.version;
    await this.pool.query("SELECT version FROM rafid_market_migrations WHERE version=$1", [latestVersion])
      .then(r => { if (!r.rowCount) throw new Error("Market data migration required"); });
  }

  private async findComparables(query: MarketRepositoryQuery, transactionType: TransactionType): Promise<readonly MarketRecord[]> {
    const conditions = ["normalized_area = $1", "property_type = $2", "transaction_type = $3"];
    const params: unknown[] = [query.normalizedArea, query.propertyType, transactionType];
    if (query.maxAgeDays !== undefined) {
      params.push(query.maxAgeDays);
      conditions.push(`observed_at >= now() - ($${params.length}::text || ' days')::interval`);
    }
    const sql = `SELECT * FROM property_market_records WHERE ${conditions.join(" AND ")} ORDER BY observed_at DESC LIMIT ${MAX_CANDIDATE_ROWS}`;
    const result = await this.pool.query(sql, params);
    return result.rows.map(toRecord);
  }
  async findRentalComparables(query: MarketRepositoryQuery): Promise<readonly MarketRecord[]> { return this.findComparables(query, "rental"); }
  async findSaleComparables(query: MarketRepositoryQuery): Promise<readonly MarketRecord[]> { return this.findComparables(query, "sale"); }

  async upsertMarketRecords(records: readonly MarketRecordInput[]): Promise<UpsertResult> {
    let inserted = 0, updated = 0, skipped = 0;
    await this.transaction(async c => {
      for (const r of records) {
        if (r.sourceRecordId) {
          // ON CONFLICT targets the partial unique index in marketSchema.ts (source_name,
          // source_record_id) WHERE source_record_id IS NOT NULL — this branch only runs when
          // source_record_id is present, so the predicate is always satisfied here.
          const result = await c.query(
            `INSERT INTO property_market_records
              (id,governorate,wilayat,area,normalized_area,property_type,bedrooms,bathrooms,size_sqm,
               transaction_type,price_omr,rent_period,furnished,source_type,source_name,source_record_id,
               source_url,observed_at,metadata,partner_id,data_quality_score)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
             ON CONFLICT (source_name,source_record_id) WHERE source_record_id IS NOT NULL DO UPDATE SET
               governorate=EXCLUDED.governorate, wilayat=EXCLUDED.wilayat, area=EXCLUDED.area,
               normalized_area=EXCLUDED.normalized_area, property_type=EXCLUDED.property_type,
               bedrooms=EXCLUDED.bedrooms, bathrooms=EXCLUDED.bathrooms, size_sqm=EXCLUDED.size_sqm,
               transaction_type=EXCLUDED.transaction_type, price_omr=EXCLUDED.price_omr,
               rent_period=EXCLUDED.rent_period, furnished=EXCLUDED.furnished, source_type=EXCLUDED.source_type,
               source_url=EXCLUDED.source_url, observed_at=EXCLUDED.observed_at, metadata=EXCLUDED.metadata,
               partner_id=EXCLUDED.partner_id, data_quality_score=EXCLUDED.data_quality_score
             RETURNING (xmax = 0) AS inserted`,
            [randomUUID(), r.governorate, r.wilayat, r.area, r.normalizedArea, r.propertyType, r.bedrooms, r.bathrooms,
              r.sizeSqm, r.transactionType, r.priceOMR, r.rentPeriod, r.furnished, r.sourceType, r.sourceName,
              r.sourceRecordId, r.sourceUrl, r.observedAt, JSON.stringify(r.metadata), r.partnerId ?? null, r.dataQualityScore ?? null]
          );
          if (result.rows[0]?.inserted) inserted++; else updated++;
        } else {
          // No stable source identifier to deduplicate against — always inserted as new. See
          // importPipeline.ts's dedup notes: re-importing the same sourceless file will create
          // duplicate rows, which is documented, expected behavior, not a bug.
          await c.query(
            `INSERT INTO property_market_records
              (id,governorate,wilayat,area,normalized_area,property_type,bedrooms,bathrooms,size_sqm,
               transaction_type,price_omr,rent_period,furnished,source_type,source_name,source_record_id,
               source_url,observed_at,metadata,partner_id,data_quality_score)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NULL,$16,$17,$18,$19,$20)`,
            [randomUUID(), r.governorate, r.wilayat, r.area, r.normalizedArea, r.propertyType, r.bedrooms, r.bathrooms,
              r.sizeSqm, r.transactionType, r.priceOMR, r.rentPeriod, r.furnished, r.sourceType, r.sourceName,
              r.sourceUrl, r.observedAt, JSON.stringify(r.metadata), r.partnerId ?? null, r.dataQualityScore ?? null]
          );
          inserted++;
        }
      }
    });
    return { inserted, updated, skipped };
  }

  async findMarketStatistics(query: MarketRepositoryQuery): Promise<MarketStatistics | null> {
    const params: unknown[] = [query.normalizedArea, query.propertyType, query.transactionType];
    const result = await this.pool.query(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price_omr/size_sqm) AS median_per_sqm,
              count(*) AS sample_size, max(observed_at) AS as_of
       FROM property_market_records WHERE normalized_area=$1 AND property_type=$2 AND transaction_type=$3`,
      params
    );
    const row = result.rows[0];
    if (!row || Number(row.sample_size) === 0) return null;
    return { medianPricePerSqmOMR: Math.round(Number(row.median_per_sqm) * 100) / 100, sampleSize: Number(row.sample_size), asOfDate: (row.as_of as Date).toISOString() };
  }
  async getLatestDataTimestamp(query: Pick<MarketRepositoryQuery, "normalizedArea" | "propertyType" | "transactionType">): Promise<string | null> {
    const result = await this.pool.query(
      "SELECT max(observed_at) AS latest FROM property_market_records WHERE normalized_area=$1 AND property_type=$2 AND transaction_type=$3",
      [query.normalizedArea, query.propertyType, query.transactionType]
    );
    const latest = result.rows[0]?.latest as Date | null;
    return latest ? latest.toISOString() : null;
  }
  async getAggregateStatus(): Promise<MarketDataAggregateStatus> {
    const result = await this.pool.query(
      `SELECT count(*) AS records,
              count(*) FILTER (WHERE transaction_type='rental') AS rental_records,
              count(*) FILTER (WHERE transaction_type='sale') AS sale_records,
              count(DISTINCT normalized_area) AS areas,
              max(observed_at) AS latest_data_date,
              array_remove(array_agg(DISTINCT source_type), NULL) AS source_types
       FROM property_market_records`
    );
    const row = result.rows[0]!;
    return {
      records: Number(row.records), rentalRecords: Number(row.rental_records), saleRecords: Number(row.sale_records),
      areas: Number(row.areas), latestDataDate: row.latest_data_date ? (row.latest_data_date as Date).toISOString() : null,
      sourceTypes: (row.source_types as string[] | null) ?? []
    };
  }
  /** Section 7: database-side aggregation (a single SQL query, per the spec's explicit
   *  preference) rather than reading every one of a partner's records into memory. `count(*)
   *  FILTER (WHERE ...)` computes each rate/percentage in the same pass as the average. */
  async getPartnerQualitySummary(partnerId: string): Promise<PartnerDataQualitySummary> {
    const result = await this.pool.query(
      `SELECT count(*) AS record_count,
              coalesce(avg(data_quality_score),0) AS avg_score,
              coalesce(count(*) FILTER (WHERE data_quality_score > 0.8),0) AS above_80,
              coalesce(count(*) FILTER (WHERE data_quality_score < 0.5),0) AS below_50,
              coalesce(count(*) FILTER (WHERE bedrooms IS NULL),0) AS missing_bedroom,
              coalesce(count(*) FILTER (WHERE bathrooms IS NULL),0) AS missing_bathroom,
              coalesce(count(*) FILTER (WHERE furnished IS NULL),0) AS missing_furnished
       FROM property_market_records WHERE partner_id=$1`,
      [partnerId]
    );
    const row = result.rows[0]!;
    const recordCount = Number(row.record_count);
    if (recordCount === 0) return { recordCount: 0, averageDataQualityScore: 0, percentageAbove80: 0, percentageBelow50: 0, missingBedroomRate: 0, missingBathroomRate: 0, missingFurnishedRate: 0 };
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const pct = (count: unknown) => round2((Number(count) / recordCount) * 100);
    return {
      recordCount,
      averageDataQualityScore: round2(Number(row.avg_score)),
      percentageAbove80: pct(row.above_80),
      percentageBelow50: pct(row.below_50),
      missingBedroomRate: pct(row.missing_bedroom),
      missingBathroomRate: pct(row.missing_bathroom),
      missingFurnishedRate: pct(row.missing_furnished)
    };
  }
  /** Section 6/8: deliberately a SEPARATE query shape from findComparables() above — no
   *  MAX_CANDIDATE_ROWS cap and no ORDER BY ... LIMIT truncation, because this is reporting
   *  accurate full-history aggregate figures (recordsAvailable, oldestRecordDate, ...), not
   *  supplying a bounded candidate pool for comparables.ts's own tolerance filtering. Every
   *  aggregate (including the per-phase breakdown) is computed server-side in a single query each,
   *  never by pulling matching rows into Node and reducing them here. */
  async getHistoricalSaleStatistics(
    query: Pick<MarketRepositoryQuery, "normalizedArea" | "propertyType">,
    options: { minPhaseSampleSize: number; phaseBreakdownLimit: number }
  ): Promise<HistoricalSaleStatistics | null> {
    const overallResult = await this.pool.query(
      `SELECT count(*) AS record_count, min(observed_at) AS oldest, max(observed_at) AS latest,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY price_omr/size_sqm) AS median_per_sqm,
              array_remove(array_agg(DISTINCT source_type), NULL) AS source_types,
              array_remove(array_agg(DISTINCT metadata->>'saleRecordType'), NULL) AS price_semantics
       FROM property_market_records WHERE normalized_area=$1 AND property_type=$2 AND transaction_type='sale'`,
      [query.normalizedArea, query.propertyType]
    );
    const row = overallResult.rows[0];
    const recordCount = row ? Number(row.record_count) : 0;
    if (!row || recordCount === 0) return null;

    const phaseResult = await this.pool.query(
      `SELECT metadata->>'phaseName' AS phase_name, count(*) AS record_count,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY price_omr) AS median_price,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY price_omr/size_sqm) AS median_per_sqm,
              min(observed_at) AS oldest, max(observed_at) AS latest
       FROM property_market_records
       WHERE normalized_area=$1 AND property_type=$2 AND transaction_type='sale' AND metadata->>'phaseName' IS NOT NULL
       GROUP BY metadata->>'phaseName'
       HAVING count(*) >= $3
       ORDER BY count(*) DESC
       LIMIT $4`,
      [query.normalizedArea, query.propertyType, options.minPhaseSampleSize, options.phaseBreakdownLimit]
    );
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const phaseBreakdown: PhaseSaleStatistics[] = phaseResult.rows.map(r => ({
      phaseName: r.phase_name as string,
      recordCount: Number(r.record_count),
      medianPriceOMR: round2(Number(r.median_price)),
      medianPricePerSqmOMR: round2(Number(r.median_per_sqm)),
      oldestRecordDate: (r.oldest as Date).toISOString(),
      latestRecordDate: (r.latest as Date).toISOString()
    }));

    return {
      recordsAvailable: recordCount,
      oldestRecordDate: (row.oldest as Date).toISOString(),
      latestRecordDate: (row.latest as Date).toISOString(),
      medianPricePerSqmOMR: round2(Number(row.median_per_sqm)),
      sourceTypes: (row.source_types as string[] | null) ?? [],
      priceSemantics: (row.price_semantics as string[] | null) ?? [],
      phaseBreakdown
    };
  }
  async close() { await this.pool.end(); }
}
