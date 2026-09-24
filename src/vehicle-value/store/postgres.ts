import { Pool } from "pg";
import type { VehicleComparable, VehicleMarketQuery } from "../types.js";
import type { VehicleMarketRecord } from "./records.js";
import { recordToComparable, type VehicleMarketRepository } from "./repository.js";

/**
 * PostgreSQL-backed vehicle_market_records. Independent of every other store in src/db/ (its own
 * table, created with an additive `CREATE TABLE IF NOT EXISTS` — the same pattern as
 * PostgresAnalyticsRepository / PostgresUsageRepository). No personal-data columns exist.
 */
export const VEHICLE_MARKET_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS vehicle_market_records (
    id bigserial PRIMARY KEY,
    make text NOT NULL,
    normalized_make text NOT NULL,
    model text NOT NULL,
    normalized_model text NOT NULL,
    year integer NOT NULL CHECK (year BETWEEN 1950 AND 2100),
    trim text,
    normalized_trim text,
    mileage_km integer CHECK (mileage_km IS NULL OR mileage_km BETWEEN 0 AND 2000000),
    condition text,
    body_type text,
    fuel_type text,
    transmission text,
    drivetrain text,
    country char(2) NOT NULL,
    city text,
    normalized_city text,
    region text,
    price numeric(14,2) NOT NULL CHECK (price > 0),
    currency char(3) NOT NULL,
    price_type text NOT NULL DEFAULT 'listing' CHECK (price_type IN ('listing','sale')),
    source_type text NOT NULL,
    source_name text NOT NULL,
    source_record_id text,
    source_url text,
    observed_at timestamptz NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
  )`,
  `CREATE INDEX IF NOT EXISTS vehicle_market_records_make_model_year_idx ON vehicle_market_records (normalized_make, normalized_model, year)`,
  `CREATE INDEX IF NOT EXISTS vehicle_market_records_trim_idx ON vehicle_market_records (normalized_make, normalized_model, normalized_trim)`,
  `CREATE INDEX IF NOT EXISTS vehicle_market_records_location_idx ON vehicle_market_records (country, normalized_city)`,
  `CREATE INDEX IF NOT EXISTS vehicle_market_records_mileage_idx ON vehicle_market_records (mileage_km)`,
  `CREATE INDEX IF NOT EXISTS vehicle_market_records_observed_idx ON vehicle_market_records (observed_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS vehicle_market_records_source_uidx ON vehicle_market_records (source_name, source_record_id) WHERE source_record_id IS NOT NULL`
] as const;

const COLUMNS = ["make", "normalized_make", "model", "normalized_model", "year", "trim", "normalized_trim", "mileage_km", "condition", "body_type", "fuel_type", "transmission", "drivetrain", "country", "city", "normalized_city", "region", "price", "currency", "price_type", "source_type", "source_name", "source_record_id", "source_url", "observed_at", "metadata"] as const;

function values(r: VehicleMarketRecord): unknown[] {
  return [r.make, r.normalizedMake, r.model, r.normalizedModel, r.year, r.trim, r.normalizedTrim, r.mileageKm, r.condition, r.bodyType, r.fuelType, r.transmission, r.drivetrain, r.country, r.city, r.normalizedCity, r.region, r.price, r.currency, r.priceType, r.sourceType, r.sourceName, r.sourceRecordId, r.sourceUrl, r.observedAt, JSON.stringify(r.metadata)];
}

export class PostgresVehicleMarketRepository implements VehicleMarketRepository {
  readonly pool: Pool;
  private ready: Promise<void> | null = null;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 5000, statement_timeout: 10000, idle_in_transaction_session_timeout: 10000 });
    this.pool.on("error", () => process.stderr.write("Vehicle market database connection failure\n"));
  }

  migrate(): Promise<void> {
    this.ready ??= (async () => { for (const sql of VEHICLE_MARKET_SCHEMA_SQL) await this.pool.query(sql); })();
    return this.ready;
  }

  async upsertRecords(records: readonly VehicleMarketRecord[]) {
    await this.migrate();
    const client = await this.pool.connect();
    let inserted = 0; let updated = 0;
    try {
      await client.query("BEGIN");
      for (const r of records) {
        const placeholders = COLUMNS.map((_, i) => `$${i + 1}`).join(", ");
        if (r.sourceRecordId) {
          const result = await client.query(
            `INSERT INTO vehicle_market_records (${COLUMNS.join(", ")}) VALUES (${placeholders})
             ON CONFLICT (source_name, source_record_id) WHERE source_record_id IS NOT NULL
             DO UPDATE SET ${COLUMNS.filter(c => c !== "source_name" && c !== "source_record_id").map(c => `${c} = EXCLUDED.${c}`).join(", ")}, ingested_at = now()
             RETURNING (xmax = 0) AS inserted`, values(r));
          if (result.rows[0]?.inserted) inserted++; else updated++;
        } else {
          await client.query(`INSERT INTO vehicle_market_records (${COLUMNS.join(", ")}) VALUES (${placeholders})`, values(r));
          inserted++;
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return { inserted, updated };
  }

  async findComparables(query: VehicleMarketQuery, limit: number): Promise<VehicleComparable[]> {
    await this.migrate();
    const result = await this.pool.query(
      `SELECT make, normalized_make, model, normalized_model, year, trim, normalized_trim, mileage_km, condition, body_type, fuel_type, transmission, drivetrain,
              country, city, normalized_city, region, price::float8 AS price, currency, price_type, source_type, source_name, source_record_id, source_url, observed_at
         FROM vehicle_market_records
        WHERE normalized_make = $1 AND normalized_model = $2 AND year BETWEEN $3 AND $4 AND country = ANY($5) AND observed_at >= $6
        ORDER BY observed_at DESC, id DESC
        LIMIT $7`,
      [query.makeKey, query.modelKey, query.yearMin, query.yearMax, [...query.countries], query.observedAfter, limit]
    );
    return result.rows.map(row => recordToComparable({
      make: row.make, normalizedMake: row.normalized_make, model: row.model, normalizedModel: row.normalized_model, year: row.year,
      trim: row.trim, normalizedTrim: row.normalized_trim, mileageKm: row.mileage_km, condition: row.condition, bodyType: row.body_type,
      fuelType: row.fuel_type, transmission: row.transmission, drivetrain: row.drivetrain, country: String(row.country).trim(), city: row.city,
      normalizedCity: row.normalized_city, region: row.region, price: Number(row.price), currency: String(row.currency).trim(), priceType: row.price_type,
      sourceType: row.source_type, sourceName: row.source_name, sourceRecordId: row.source_record_id, sourceUrl: row.source_url,
      observedAt: new Date(row.observed_at).toISOString(), metadata: {}
    }));
  }

  async close(): Promise<void> { await this.pool.end(); }
}
