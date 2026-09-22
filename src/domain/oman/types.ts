/** Shared vocabulary for the Oman property-analysis domain. Kept in one file so the schemas
 *  (src/schemas/omanInputs.ts, src/schemas/omanOutputs.ts), the data providers and the
 *  comparable-selection/confidence engines all agree on the same literal unions — no tool ever
 *  redefines "apartment" | "villa" | "townhouse" a second time. */

export const PROPERTY_TYPES = ["apartment", "villa", "townhouse"] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const FURNISHED_STATUSES = ["furnished", "semi_furnished", "unfurnished"] as const;
export type FurnishedStatus = (typeof FURNISHED_STATUSES)[number];

/** Distinguishes how a comparable record was sourced, so an agent can tell official statistics
 *  apart from a listing's asking price, a manually curated benchmark, or a partner feed. See
 *  src/domain/oman/dataProviders.ts for which provider produces which sourceType today. */
export const SOURCE_TYPES = ["official_statistics", "listing_asking_price", "manual_benchmark", "partner_feed"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const RENT_PERIODS = ["monthly", "annual"] as const;
export type RentPeriod = (typeof RENT_PERIODS)[number];

/** A comparable record's shared identity/provenance fields. Rental and sale comparables both
 *  extend this — see src/domain/oman/comparables.ts. Deliberately does NOT include `furnished`:
 *  rental and sale comparables need different nullability for that field (see RentalComparable/
 *  SaleComparable below), so it is declared separately on each subtype rather than forced into a
 *  single shared shape. */
export interface ComparableRecordBase {
  id: string;
  area: string; // canonical area name, e.g. "Al Mouj" — see locations.ts
  propertyType: PropertyType;
  bedrooms: number;
  sizeSqm: number;
  /** Days between the record's sourceDate and "now" at query time — computed dynamically
   *  (see comparables.ts's withAge helper), never stored statically, so a curated dataset's
   *  records honestly age and eventually surface as stale rather than staying artificially
   *  "fresh" forever. */
  listedDaysAgo: number;
  sourceType: SourceType;
  sourceName: string;
  /** ISO date the record (or the dataset snapshot it belongs to) represents. */
  sourceDate: string;
}

export interface RentalComparable extends ComparableRecordBase {
  /** Mandatory and non-nullable for rentals — furnished status remains a genuine, actively
   *  matched similarity factor for rent estimation (comparables.ts's selectComparables()), and
   *  this stays completely unchanged by the Al Mouj sale-comparable fix below. */
  furnished: FurnishedStatus;
  rentAmountOMR: number;
  rentPeriod: RentPeriod;
}

export interface SaleComparable extends ComparableRecordBase {
  /** Al Mouj production-readiness fix (furnished-null sale comparables): nullable for sales,
   *  unlike RentalComparable.furnished. Oman partner sale feeds (Al Mouj's included) routinely do
   *  not track furnishing status for a property SALE at all — null here means "not provided/
   *  unknown", never "unfurnished". It must never be used as a mandatory/exclusionary filter for
   *  sale-comparable selection (see comparables.ts's selectSaleComparables(), which never inspects
   *  this field at all) and must never be inferred as `false`/"unfurnished" anywhere in the
   *  pipeline. Sale-comparable matching instead depends on area/propertyType/bedrooms/size
   *  similarity/recency alone. */
  furnished: FurnishedStatus | null;
  /** Asking price from a listing, or a manually curated benchmark figure — never a confirmed
   *  completed-transaction price in this MVP. See dataProviders.ts's doc comment. */
  askingPriceOMR: number;
}

/** monthly/annual rent normalization (Section 9): Oman tenancy contracts are quoted either
 *  monthly or annually; every comparable's rent must be normalized to a monthly figure before
 *  it can be compared or averaged. This is the one place that conversion happens. */
export function normalizedMonthlyRent(record: RentalComparable): number {
  return record.rentPeriod === "annual" ? record.rentAmountOMR / 12 : record.rentAmountOMR;
}

/** Days between an ISO date/timestamp and "now", floored at 0. The one place this conversion
 *  happens — used by both the curated fixture dataset (fixtures.ts) and the production database
 *  provider (dataProviders.ts) so a record's age is always computed fresh at query time rather
 *  than stored statically and allowed to go stale. */
export function daysSince(iso: string): number {
  return Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 86_400_000));
}

export interface OmanPropertyQuery {
  area: string; // canonical
  propertyType: PropertyType;
  bedrooms?: number;
  sizeSqm: number;
  furnished?: FurnishedStatus;
}

/** Al Mouj historical-sales production-readiness pass (Section 6): a full-fidelity completed-sale
 *  record for historicalSalesContext — deliberately NOT a SaleComparable. `bedrooms` may be null
 *  (a real completed sale is often missing a recorded bedroom count) and there is no `furnished`
 *  field at all (irrelevant to a completed sale, and never recorded by any partner feed observed
 *  so far — see the Al Mouj dataset, where it is null on every row). SaleComparable's mandatory,
 *  non-nullable `bedrooms`/`furnished` would silently exclude that entire dataset from historical
 *  intelligence, which defeats the point of historicalSalesContext — so this type, and the
 *  selection path built for it (comparables.ts's selectRecentSaleRecords), are kept deliberately
 *  separate from SaleComparable/selectComparables, which continue to serve ONLY the current-
 *  comparable pipeline exactly as before. */
export interface RawSaleRecord {
  id: string;
  area: string;
  propertyType: PropertyType;
  bedrooms: number | null;
  sizeSqm: number;
  priceOMR: number;
  listedDaysAgo: number;
  sourceType: SourceType;
  sourceName: string;
  sourceDate: string;
  metadata: Record<string, unknown>;
}

/** A provider may optionally expose pre-aggregated statistics (e.g. an official dataset that
 *  publishes area-level medians directly, without raw per-listing records). None of the
 *  providers implemented for this MVP have one yet — see dataProviders.ts. */
export interface OmanMarketStatistics {
  medianRentPerSqmOMR: number;
  sampleSize: number;
  asOfDate: string;
}
