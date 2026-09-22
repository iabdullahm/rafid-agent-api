import { mean, stdDev, MIN_COMPARABLES } from "./comparables.js";

/**
 * Section 7: a deterministic confidence engine. No model or LLM ever invents this score — it is
 * a fixed weighted combination of measurable evidence about the comparable sample that produced
 * a market estimate. Every input here is a number or boolean computed earlier in the pipeline
 * (src/services/omanProperty.ts); this module only applies fixed weights and thresholds to them.
 */
export interface ConfidenceFactors {
  sampleSizeUsed: number;
  /** Median age (days) of the comparables actually used. */
  dataFreshnessDays: number | null;
  /** Per-sqm value (rent or price) of every comparable in the used sample — for dispersion. */
  perSqmValues: readonly number[];
  /** |comparable.sizeSqm - subject.sizeSqm| / subject.sizeSqm for every comparable used. */
  sizeDeviationRatios: readonly number[];
  /** Fraction (0-1) of the used sample whose bedroom count exactly matches the subject's; null
   *  when the subject didn't supply a bedroom count (in which case this factor is not penalized). */
  bedroomExactMatchRatio: number | null;
  wilayatMismatch: boolean;
  bedroomToleranceApplied: boolean;
  furnishedFilterRelaxed: boolean;
  outliersRemoved: number;
  /** Phase 7: true when the used sample's data-freshness exceeds the configured staleness
   *  threshold (see src/domain/oman/config.ts's getOmanMarketStaleDays) — a deterministic
   *  penalty, not a separate model judgment. Optional/defaults to false so existing callers that
   *  predate Phase 7 keep compiling unchanged. */
  stale?: boolean;
}

export type ConfidenceLevel = "insufficient" | "low" | "medium" | "high";
export interface ConfidenceResult { score: number; level: ConfidenceLevel; reasons: string[] }

/** A sample this size or larger earns full marks on the sample-size factor. */
const TARGET_SAMPLE_SIZE = 8;
/** Matches comparables.ts's MAX_DATA_AGE_DAYS — data at the staleness cutoff earns zero on the
 *  freshness factor rather than a cliff at some other, undocumented number. */
const MAX_FRESHNESS_DAYS = 540;
const WEIGHTS = { sampleSize: 0.30, freshness: 0.20, similarity: 0.30, dispersion: 0.20 } as const;

export function computeConfidence(factors: ConfidenceFactors): ConfidenceResult {
  // Tied to the same MIN_COMPARABLES threshold that gates whether market.* is computed at all
  // (comparables.ts) — it would be contradictory to report a "low but real" confidence for a
  // sample too small for a market estimate to exist in the first place.
  if (factors.sampleSizeUsed < MIN_COMPARABLES) {
    return {
      score: 0, level: "insufficient",
      reasons: [`Only ${factors.sampleSizeUsed} comparable(s) survived filtering — below the minimum of ${MIN_COMPARABLES} required for a market estimate.`]
    };
  }
  const reasons: string[] = [];

  const sampleSizeScore = Math.min(1, factors.sampleSizeUsed / TARGET_SAMPLE_SIZE);
  reasons.push(`Sample size of ${factors.sampleSizeUsed} comparable(s) used (target is ${TARGET_SAMPLE_SIZE}+ for full confidence on this factor).`);

  const freshnessDays = factors.dataFreshnessDays ?? MAX_FRESHNESS_DAYS;
  const freshnessScore = Math.max(0, 1 - freshnessDays / MAX_FRESHNESS_DAYS);
  reasons.push(`Comparable data has a median age of ${Math.round(freshnessDays)} day(s) (data older than ${MAX_FRESHNESS_DAYS} days is excluded before this point).`);

  const avgSizeDeviation = factors.sizeDeviationRatios.length
    ? factors.sizeDeviationRatios.reduce((a, b) => a + b, 0) / factors.sizeDeviationRatios.length
    : 0;
  const bedroomRatio = factors.bedroomExactMatchRatio ?? 1; // not supplied => don't penalize this sub-factor
  const similarityScore = Math.max(0, 1 - avgSizeDeviation) * (0.5 + 0.5 * bedroomRatio);
  reasons.push(
    `Comparable size deviates ${(avgSizeDeviation * 100).toFixed(0)}% from the subject on average` +
    (factors.bedroomExactMatchRatio !== null ? `; ${(bedroomRatio * 100).toFixed(0)}% of comparables match the bedroom count exactly.` : ".")
  );

  const perSqmMean = mean(factors.perSqmValues);
  const coefficientOfVariation = perSqmMean > 0 ? stdDev(factors.perSqmValues) / perSqmMean : 0;
  const dispersionScore = Math.max(0, 1 - Math.min(1, coefficientOfVariation));
  reasons.push(`Price dispersion across comparables (coefficient of variation) is ${coefficientOfVariation.toFixed(2)}.`);

  if (factors.wilayatMismatch) reasons.push("Supplied wilayat did not match the recognized area's registry wilayat; the area-level match was used instead.");
  if (factors.bedroomToleranceApplied) reasons.push("Bedroom-count tolerance (±1) was applied because too few exact-bedroom comparables were available.");
  if (factors.furnishedFilterRelaxed) reasons.push("Furnished-status filter was relaxed to any status because too few exact-match comparables were available.");
  if (factors.outliersRemoved > 0) reasons.push(`${factors.outliersRemoved} statistical outlier(s) were removed from the comparable pool before scoring.`);
  if (factors.stale) reasons.push("The comparable sample's data freshness exceeds this deployment's staleness threshold; confidence was reduced accordingly.");

  let score = sampleSizeScore * WEIGHTS.sampleSize + freshnessScore * WEIGHTS.freshness
    + similarityScore * WEIGHTS.similarity + dispersionScore * WEIGHTS.dispersion;
  if (factors.wilayatMismatch) score *= 0.95;
  if (factors.bedroomToleranceApplied) score *= 0.95;
  if (factors.furnishedFilterRelaxed) score *= 0.9;
  if (factors.stale) score *= 0.85;
  score = Math.max(0, Math.min(1, Math.round(score * 100) / 100));

  const level: ConfidenceLevel = score >= 0.7 ? "high" : score >= 0.4 ? "medium" : "low";
  return { score, level, reasons };
}
