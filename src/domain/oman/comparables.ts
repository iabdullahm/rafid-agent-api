import type { ComparableRecordBase, FurnishedStatus, OmanPropertyQuery, RawSaleRecord } from "./types.js";

/** Section 6 tolerances — named constants, not magic numbers buried in the filtering logic. */
export const SIZE_TOLERANCE_PCT = 0.20; // ±20%, per the task's own example
export const BEDROOM_TOLERANCE = 1;
/** Records older than this are excluded from the candidate pool entirely as stale, before any
 *  other filtering happens. ~18 months: long enough that a small Muscat neighborhood has some
 *  data, short enough that "market" data isn't secretly years old. */
export const MAX_DATA_AGE_DAYS = 540;
/** Below this many comparables, market.*, comparablesSummary and any yield/pricePosition figure
 *  derived from them are withheld (insufficientMarketData: true) rather than computed from a
 *  statistically meaningless sample. */
export const MIN_COMPARABLES = 3;
/** IQR-based outlier removal needs at least this many points for Q1/Q3 to mean anything; below
 *  it, outlier removal is skipped rather than potentially discarding half of a tiny sample. */
export const OUTLIER_MIN_SAMPLE = 4;

export interface SelectionResult<T extends ComparableRecordBase> {
  /** Matches area + propertyType + recency window + size tolerance (the "hard" structural
   *  filters, with no fallback/relaxation) — reported as market.comparableCount: how many
   *  comparably-sized units of this type exist in this area at all, before the softer
   *  bedroom/furnished tolerances and outlier removal below are applied. */
  candidatePool: T[];
  /** The final sample actually used to compute statistics, after every tolerance/outlier filter
   *  — reported as market.sampleSizeUsed. */
  used: T[];
  outliersRemoved: number;
  bedroomToleranceApplied: boolean;
  furnishedFilterRelaxed: boolean;
}

/** Al Mouj production-readiness fix: the sale-comparable counterpart of SelectionResult, minus
 *  `furnishedFilterRelaxed` — furnished is never filtered/relaxed for sale comparables (see
 *  selectSaleComparables below), so there is no such flag to report. */
export interface SaleSelectionResult<T extends ComparableRecordBase> {
  candidatePool: T[];
  used: T[];
  outliersRemoved: number;
  bedroomToleranceApplied: boolean;
}

export function withinPct(value: number, target: number, pct: number): boolean {
  return Math.abs(value - target) <= target * pct;
}

function percentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 1) return sortedValues[0]!;
  const index = p * (sortedValues.length - 1);
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  if (lowerIndex === upperIndex) return sortedValues[lowerIndex]!;
  const weight = index - lowerIndex;
  return sortedValues[lowerIndex]! * (1 - weight) + sortedValues[upperIndex]! * weight;
}

/** Standard 1.5×IQR outlier rule, applied to a per-sqm value so it works identically for rent
 *  and sale comparables of different absolute sizes. Deterministic — no configuration, no model
 *  in the loop (Section 9: outlier filtering must never require an LLM). */
export function removeOutliers<T>(records: readonly T[], perUnit: (record: T) => number): { used: T[]; removed: number } {
  if (records.length < OUTLIER_MIN_SAMPLE) return { used: [...records], removed: 0 };
  const sortedValues = records.map(perUnit).sort((a, b) => a - b);
  const q1 = percentile(sortedValues, 0.25);
  const q3 = percentile(sortedValues, 0.75);
  const iqr = q3 - q1;
  const lowerBound = q1 - 1.5 * iqr;
  const upperBound = q3 + 1.5 * iqr;
  const used = records.filter(r => { const v = perUnit(r); return v >= lowerBound && v <= upperBound; });
  return { used, removed: records.length - used.length };
}

/**
 * Section 6: filters a raw comparable pool (rental or sale) down to records that genuinely
 * resemble the subject property, then removes statistical outliers. Never compares across
 * propertyType — a villa is never matched against an apartment. Filtering order:
 *
 * 1. area (exact canonical match) + propertyType (exact match) + recency (MAX_DATA_AGE_DAYS)
 * 2. sizeSqm within ±SIZE_TOLERANCE_PCT
 * 3. bedrooms: exact match preferred; relaxed to ±BEDROOM_TOLERANCE only if the exact match has
 *    fewer than MIN_COMPARABLES records (bedroomToleranceApplied reports whether this happened)
 * 4. furnished status: exact match preferred; relaxed to "any furnished status" only if the
 *    exact match has fewer than MIN_COMPARABLES records (furnishedFilterRelaxed reports this)
 * 5. IQR-based outlier removal on the per-sqm value (see valueOf)
 *
 * `valueOf` must return the record's per-comparison absolute value — normalized monthly rent for
 * rentals, asking price for sales — used only to compute the per-sqm figure outliers are judged
 * against.
 *
 * Al Mouj production-readiness fix (furnished-null sale comparables): this function's furnished
 * exact-then-relaxed step (4) requires `T` to carry a non-nullable `furnished: FurnishedStatus` —
 * i.e. a RentalComparable shape — so it is a COMPILE-TIME error to call this with a SaleComparable
 * pool (whose `furnished` is `FurnishedStatus | null`). This makes "rental furnished-matching
 * logic is never reused/weakened for sale comparables" a type-checked guarantee, not just a
 * convention: sale comparables must go through selectSaleComparables() below instead, which never
 * filters on furnished at all. This function itself is otherwise completely unchanged.
 */
export function selectComparables<T extends ComparableRecordBase & { furnished: FurnishedStatus }>(
  pool: readonly T[],
  query: OmanPropertyQuery,
  valueOf: (record: T) => number
): SelectionResult<T> {
  const areaTypePool = pool.filter(r =>
    r.area === query.area && r.propertyType === query.propertyType && r.listedDaysAgo <= MAX_DATA_AGE_DAYS
  );

  const candidatePool = areaTypePool.filter(r => withinPct(r.sizeSqm, query.sizeSqm, SIZE_TOLERANCE_PCT));
  const sizeFiltered = candidatePool;

  let bedroomFiltered = sizeFiltered;
  let bedroomToleranceApplied = false;
  if (query.bedrooms !== undefined) {
    const exact = sizeFiltered.filter(r => r.bedrooms === query.bedrooms);
    if (exact.length >= MIN_COMPARABLES) {
      bedroomFiltered = exact;
    } else {
      const relaxed = sizeFiltered.filter(r => Math.abs(r.bedrooms - query.bedrooms!) <= BEDROOM_TOLERANCE);
      bedroomFiltered = relaxed;
      bedroomToleranceApplied = relaxed.length !== exact.length;
    }
  }

  let furnishedFiltered = bedroomFiltered;
  let furnishedFilterRelaxed = false;
  if (query.furnished !== undefined) {
    const exact = bedroomFiltered.filter(r => r.furnished === query.furnished);
    if (exact.length >= MIN_COMPARABLES) {
      furnishedFiltered = exact;
    } else {
      furnishedFiltered = bedroomFiltered;
      furnishedFilterRelaxed = exact.length !== bedroomFiltered.length;
    }
  }

  const { used, removed } = removeOutliers(furnishedFiltered, r => valueOf(r) / r.sizeSqm);
  return { candidatePool, used, outliersRemoved: removed, bedroomToleranceApplied, furnishedFilterRelaxed };
}

/**
 * Al Mouj production-readiness fix (furnished-null sale comparables): the CURRENT sale-comparable
 * counterpart of selectComparables() above, for pricePosition/observedComparableRange — deliberately
 * a separate function, not a modification of selectComparables() (which continues to serve ONLY
 * rentals — see its own doc comment and its tightened generic constraint, which now makes it a
 * compile-time error to call it with a SaleComparable pool at all).
 *
 * Filtering order — identical to selectComparables() through step 3, but with NO furnished step:
 * 1. area (exact canonical match) + propertyType (exact match) + recency (MAX_DATA_AGE_DAYS)
 * 2. sizeSqm within ±SIZE_TOLERANCE_PCT
 * 3. bedrooms: exact match preferred; relaxed to ±BEDROOM_TOLERANCE only if the exact match has
 *    fewer than MIN_COMPARABLES records (bedroomToleranceApplied reports whether this happened)
 * 4. IQR-based outlier removal on the per-sqm value (see valueOf) — same as step 5 above
 *
 * Furnished status is deliberately NEVER inspected, filtered, or relaxed here — for a sale
 * comparable, furnished must not be a mandatory/exclusionary filter at all (the Al Mouj partner
 * sales dataset never records it, so real, otherwise-valid sale records would otherwise be
 * dropped wholesale). A record with `furnished: null` is treated exactly the same as one with
 * `furnished: "furnished"` — null is never coerced to or treated as "unfurnished". Requirement:
 * sale-comparable similarity depends only on area/propertyType/bedrooms/size/recency.
 */
export function selectSaleComparables<T extends ComparableRecordBase>(
  pool: readonly T[],
  query: OmanPropertyQuery,
  valueOf: (record: T) => number
): SaleSelectionResult<T> {
  const areaTypePool = pool.filter(r =>
    r.area === query.area && r.propertyType === query.propertyType && r.listedDaysAgo <= MAX_DATA_AGE_DAYS
  );

  const candidatePool = areaTypePool.filter(r => withinPct(r.sizeSqm, query.sizeSqm, SIZE_TOLERANCE_PCT));

  let bedroomFiltered = candidatePool;
  let bedroomToleranceApplied = false;
  if (query.bedrooms !== undefined) {
    const exact = candidatePool.filter(r => r.bedrooms === query.bedrooms);
    if (exact.length >= MIN_COMPARABLES) {
      bedroomFiltered = exact;
    } else {
      const relaxed = candidatePool.filter(r => Math.abs(r.bedrooms - query.bedrooms!) <= BEDROOM_TOLERANCE);
      bedroomFiltered = relaxed;
      bedroomToleranceApplied = relaxed.length !== exact.length;
    }
  }

  // Deliberately no furnished-status filtering step — see doc comment above.
  const { used, removed } = removeOutliers(bedroomFiltered, r => valueOf(r) / r.sizeSqm);
  return { candidatePool, used, outliersRemoved: removed, bedroomToleranceApplied };
}

export interface RecentSaleSelectionResult {
  candidatePool: RawSaleRecord[];
  used: RawSaleRecord[];
  outliersRemoved: number;
  bedroomToleranceApplied: boolean;
}

/**
 * Al Mouj historical-sales production-readiness pass (Section 6/7): a SEPARATE selection path for
 * historicalSalesContext's "recent comparable sales" figure — deliberately not a call into
 * selectComparables() above, and deliberately not mixed into it, because:
 *  - selectComparables()'s recency cutoff is the fixed MAX_DATA_AGE_DAYS (540 days), used for
 *    CURRENT market estimates; historicalSalesContext's "recent" window is the operator-configurable
 *    OMAN_RECENT_SALES_DAYS (config.ts's getOmanRecentSalesDays(), default 730) — passed in here as
 *    `maxDataAgeDays`, never hardcoded in this function.
 *  - selectComparables() requires every record to have a non-null `furnished` status (via
 *    ComparableRecordBase/SaleComparable) — but a completed sale record routinely has none (every
 *    Al Mouj partner-feed sale does), so reusing it here would silently report
 *    recentComparableSales: 0 for exactly the dataset this feature exists to surface. Furnished
 *    status is not evaluated at all for historical sales.
 *  - bedrooms may be null on a raw sale record (unlike ComparableRecordBase's mandatory bedrooms):
 *    a record with an unknown bedroom count is kept in the pool (never excluded for missing data)
 *    but only records with a KNOWN, matching bedroom count are used to decide whether the
 *    exact-vs-relaxed tolerance applies — "respect ... bedrooms where available", not "require
 *    bedrooms".
 *
 * Still reuses the exact same SIZE_TOLERANCE_PCT/BEDROOM_TOLERANCE/MIN_COMPARABLES tolerances and
 * the same removeOutliers() IQR routine as selectComparables() — the matching PHILOSOPHY is
 * identical and centralized here in comparables.ts; only the recency window and the
 * furnished/bedrooms-nullability handling differ, for the reasons above.
 */
export function selectRecentSaleRecords(
  pool: readonly RawSaleRecord[],
  query: OmanPropertyQuery,
  maxDataAgeDays: number
): RecentSaleSelectionResult {
  const areaTypePool = pool.filter(r =>
    r.area === query.area && r.propertyType === query.propertyType && r.listedDaysAgo <= maxDataAgeDays
  );
  const candidatePool = areaTypePool.filter(r => withinPct(r.sizeSqm, query.sizeSqm, SIZE_TOLERANCE_PCT));

  let bedroomFiltered = candidatePool;
  let bedroomToleranceApplied = false;
  if (query.bedrooms !== undefined) {
    const withKnownBedrooms = candidatePool.filter((r): r is RawSaleRecord & { bedrooms: number } => r.bedrooms !== null);
    const withUnknownBedrooms = candidatePool.filter(r => r.bedrooms === null);
    const exact = withKnownBedrooms.filter(r => r.bedrooms === query.bedrooms);
    if (exact.length >= MIN_COMPARABLES) {
      bedroomFiltered = [...exact, ...withUnknownBedrooms];
    } else {
      const relaxed = withKnownBedrooms.filter(r => Math.abs(r.bedrooms - query.bedrooms!) <= BEDROOM_TOLERANCE);
      bedroomFiltered = [...relaxed, ...withUnknownBedrooms];
      bedroomToleranceApplied = relaxed.length !== exact.length;
    }
  }

  const { used, removed } = removeOutliers(bedroomFiltered, r => r.priceOMR / r.sizeSqm);
  return { candidatePool, used, outliersRemoved: removed, bedroomToleranceApplied };
}

export interface RangeStats { low: number; median: number; high: number }

/** Low/median/high of a numeric sample — the min, median and max, not percentiles, so the
 *  numbers stay explainable to an agent ("the cheapest and priciest genuinely comparable units
 *  found, and the median") rather than a modeled distribution. */
export function computeRangeStats(values: readonly number[]): RangeStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return { low: sorted[0]!, median, high: sorted[sorted.length - 1]! };
}

export function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}
