import type { MarketRecordInput } from "./marketRepository.js";

/**
 * Section 7: a deterministic, fully explainable data-quality score in [0, 1] for one imported
 * market record. Explicitly NOT an LLM call or a learned model — every input is a documented
 * arithmetic factor over fields the import pipeline already validated (importPipeline.ts), so the
 * same record always scores identically and the score can be recomputed/audited by hand.
 *
 * Five weighted factors, summing to 1.00:
 *  - completeness (0.30): fraction of optional, non-required descriptive fields actually supplied
 *    (bedrooms, bathrooms, furnished, sourceUrl, metadata) — a record with none of these is still
 *    valid and importable, just less useful to comparable selection.
 *  - size plausibility (0.15): how close sizeSqm sits to a typical Muscat residential size, on a
 *    smooth scale between the "obviously fine" band and the hard validation limits.
 *  - price plausibility (0.20): same idea for priceOMR, using the sale price directly or the
 *    rental's monthly-equivalent amount (annual rents are divided by 12 first).
 *  - freshness (0.20): decays linearly from 1.0 (observed today) to 0.0 at a two-year-old record —
 *    independent of, and in addition to, the separate staleMarketData/stale reporting elsewhere.
 *  - source identity (0.15): 1.0 for a record attributable to an enrolled, authenticated partner
 *    or to official statistics (both have a verifiable, accountable origin distinct from what the
 *    row itself claims); 0.7 for the curated manual benchmark; 0.5 for an unattributed listing
 *    asking price.
 */

export interface DataQualityContext {
  /** Present when this record was ingested under an authenticated, enrolled partner (Section 2/10)
   *  — passed separately from `record.partnerId` because the caller computes the score BEFORE (or
   *  while) applying server-side partner attribution; see importPipeline.ts. */
  partnerId?: string | null;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** 1.0 inside [idealMin, idealMax]; falls off linearly to 0.0 at the hard limit on either side. */
function rangeScore(value: number, idealMin: number, idealMax: number, hardMin: number, hardMax: number): number {
  if (value >= idealMin && value <= idealMax) return 1;
  if (value < idealMin) return clamp01((value - hardMin) / (idealMin - hardMin));
  return clamp01((hardMax - value) / (hardMax - idealMax));
}

const COMPLETENESS_WEIGHT = 0.30;
const SIZE_WEIGHT = 0.15;
const PRICE_WEIGHT = 0.20;
const FRESHNESS_WEIGHT = 0.20;
const SOURCE_WEIGHT = 0.15;

/** Two years — well inside comparables.ts's own 540-day hard recency cutoff for "in scope at all",
 *  but scoring 0 here is a quality signal, not an exclusion; a record can still be used while
 *  contributing a low quality score. */
const FRESHNESS_ZERO_AT_DAYS = 730;

export function computeDataQualityScore(record: MarketRecordInput, context: DataQualityContext = {}): number {
  const optionalFieldsSupplied = [
    record.bedrooms !== null && record.bedrooms !== undefined,
    record.bathrooms !== null && record.bathrooms !== undefined,
    record.furnished !== null && record.furnished !== undefined,
    !!record.sourceUrl,
    Object.keys(record.metadata ?? {}).length > 0
  ];
  const completeness = optionalFieldsSupplied.filter(Boolean).length / optionalFieldsSupplied.length;

  const size = rangeScore(record.sizeSqm, 40, 600, 10, 3000);

  const price = record.transactionType === "sale"
    ? rangeScore(record.priceOMR, 20_000, 800_000, 3_000, 20_000_000)
    : rangeScore(record.rentPeriod === "annual" ? record.priceOMR / 12 : record.priceOMR, 150, 3_000, 30, 15_000);

  const ageDays = Math.max(0, Math.round((Date.now() - Date.parse(record.observedAt)) / 86_400_000));
  const freshness = clamp01(1 - ageDays / FRESHNESS_ZERO_AT_DAYS);

  const partnerId = context.partnerId ?? record.partnerId ?? null;
  const sourceIdentity = partnerId || record.sourceType === "official_statistics" ? 1
    : record.sourceType === "manual_benchmark" ? 0.7
    : 0.5;

  const score =
    completeness * COMPLETENESS_WEIGHT +
    size * SIZE_WEIGHT +
    price * PRICE_WEIGHT +
    freshness * FRESHNESS_WEIGHT +
    sourceIdentity * SOURCE_WEIGHT;

  return Math.round(clamp01(score) * 100) / 100;
}
