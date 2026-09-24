import type { VehicleComparable, VehicleMarketQuery } from "../types.js";
import type { VehicleMarketRecord } from "./records.js";

/**
 * Storage abstraction for vehicle_market_records. The database provider
 * (providers/databaseProvider.ts) reads through this interface; the import CLI
 * (src/vehicleImportCli.ts) writes through it — one read path, one write path.
 */
export interface VehicleMarketRepository {
  /** Upsert with provider-level de-duplication on (sourceName, sourceRecordId) where a record id
   *  exists; records without one are inserted (they cannot be matched reliably). */
  upsertRecords(records: readonly VehicleMarketRecord[]): Promise<{ inserted: number; updated: number }>;
  findComparables(query: VehicleMarketQuery, limit: number): Promise<VehicleComparable[]>;
}

export function recordToComparable(r: VehicleMarketRecord): VehicleComparable {
  const c: VehicleComparable = {
    make: r.make, model: r.model, year: r.year, askingPrice: r.price, currency: r.currency, country: r.country,
    sourceName: r.sourceName, observedAt: r.observedAt, priceType: r.priceType
  };
  if (r.trim) c.trim = r.trim;
  if (r.mileageKm !== null) c.mileageKm = r.mileageKm;
  if (r.condition) c.condition = r.condition;
  if (r.fuelType) c.fuelType = r.fuelType;
  if (r.transmission) c.transmission = r.transmission;
  if (r.bodyType) c.bodyType = r.bodyType;
  if (r.drivetrain) c.drivetrain = r.drivetrain;
  if (r.city) c.city = r.city;
  if (r.sourceRecordId) c.sourceRecordId = r.sourceRecordId;
  if (r.sourceUrl) c.sourceUrl = r.sourceUrl;
  return c;
}

/** In-process repository — tests, dry runs, and deployments without a database. */
export class MemoryVehicleMarketRepository implements VehicleMarketRepository {
  private readonly rows: VehicleMarketRecord[] = [];

  async upsertRecords(records: readonly VehicleMarketRecord[]) {
    let inserted = 0; let updated = 0;
    for (const r of records) {
      const idx = r.sourceRecordId ? this.rows.findIndex(x => x.sourceName === r.sourceName && x.sourceRecordId === r.sourceRecordId) : -1;
      if (idx >= 0) { this.rows[idx] = r; updated++; } else { this.rows.push(r); inserted++; }
    }
    return { inserted, updated };
  }

  async findComparables(query: VehicleMarketQuery, limit: number) {
    const after = Date.parse(query.observedAfter);
    return this.rows
      .filter(r => r.normalizedMake === query.makeKey && r.normalizedModel === query.modelKey && r.year >= query.yearMin && r.year <= query.yearMax
        && query.countries.includes(r.country) && Date.parse(r.observedAt) >= after)
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
      .slice(0, limit)
      .map(recordToComparable);
  }

  get size(): number { return this.rows.length; }
}
