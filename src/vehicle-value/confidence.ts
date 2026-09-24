import { clamp, round } from "./stats.js";
import type { ConfidenceLevel } from "./types.js";

/**
 * Deterministic 0–1 confidence for a vehicle valuation. A weighted sum of eight evidence factors
 * (each 0–1), then explicit penalties and caps. It measures how well the MARKET EVIDENCE supports
 * the estimate — never how "good" the vehicle is.
 */
export const CONFIDENCE_WEIGHTS = Object.freeze({
  comparableVolume: 0.22,   // min(1, n / 12)
  similarity: 0.18,         // mean similarity of the comparables used
  trimMatch: 0.10,          // share of comparables with the exact trim (0.3 when trim unknown)
  mileageEvidence: 0.10,    // subject mileage known (0.6) + share of comparables with mileage (0.4)
  locality: 0.10,           // same city 1 · same country 0.8 · regional 0.35
  freshness: 0.12,          // median evidence age ≤ 30 days → 1, ≥ 180 days → 0
  providerDiversity: 0.06,  // 1 source 0.5 · 2 sources 0.8 · ≥ 3 sources 1
  priceConsistency: 0.12    // 1 − robust dispersion / 35 %
});

/** Median evidence age beyond which the market evidence counts as stale. */
export const STALE_AFTER_DAYS = 90;

export interface ConfidenceInputs {
  comparableCount: number;
  meanSimilarity: number;
  subjectTrimKnown: boolean;
  exactTrimShare: number;
  subjectMileageKnown: boolean;
  comparableMileageShare: number;
  meanLocality: number;
  medianAgeDays: number | null;
  distinctSources: number;
  robustDispersion: number | null;
  conditionUnknown: boolean;
  mileageEffectHeuristic: boolean;
  yearEffectHeuristic: boolean;
  regionalFallback: boolean;
  insufficient: boolean;
}

export interface ConfidenceResult { score: number; level: ConfidenceLevel; reasons: string[]; factors: Record<keyof typeof CONFIDENCE_WEIGHTS, number> }

export function confidenceLevel(score: number): ConfidenceLevel {
  return score >= 0.8 ? "high" : score >= 0.6 ? "medium" : score >= 0.4 ? "low" : "very_low";
}

export function freshnessFactor(medianAgeDays: number | null): number {
  if (medianAgeDays === null) return 0;
  if (medianAgeDays <= 30) return 1;
  if (medianAgeDays >= 180) return 0;
  return 1 - (medianAgeDays - 30) / 150;
}

export function computeConfidence(i: ConfidenceInputs): ConfidenceResult {
  const n = i.comparableCount;
  const factors = {
    comparableVolume: clamp(n / 12, 0, 1),
    similarity: n ? clamp(i.meanSimilarity, 0, 1) : 0,
    trimMatch: i.subjectTrimKnown ? (n ? clamp(i.exactTrimShare, 0, 1) : 0) : 0.3,
    mileageEvidence: (i.subjectMileageKnown ? 0.6 : 0) + (n ? 0.4 * clamp(i.comparableMileageShare, 0, 1) : 0),
    locality: n ? clamp(i.meanLocality, 0, 1) : 0,
    freshness: n ? freshnessFactor(i.medianAgeDays) : 0,
    providerDiversity: n === 0 ? 0 : i.distinctSources >= 3 ? 1 : i.distinctSources === 2 ? 0.8 : 0.5,
    priceConsistency: i.robustDispersion === null || n < 2 ? 0 : clamp(1 - i.robustDispersion / 0.35, 0, 1)
  };
  let score = (Object.keys(CONFIDENCE_WEIGHTS) as (keyof typeof CONFIDENCE_WEIGHTS)[]).reduce((s, k) => s + CONFIDENCE_WEIGHTS[k] * factors[k], 0);

  const reasons: string[] = [];
  if (n === 0) reasons.push("No usable comparable-market evidence was available for this vehicle and market.");
  else reasons.push(`${n} comparable listing(s) used${n >= 12 ? "" : " (12+ gives full weight to evidence volume)"}.`);
  if (n) reasons.push(`Mean comparable similarity is ${round(factors.similarity, 2)}.`);
  if (!i.subjectTrimKnown) reasons.push("Trim was not provided, so comparables are matched at model level.");
  else if (n) reasons.push(`${Math.round(i.exactTrimShare * 100)}% of comparables share the exact trim.`);
  reasons.push(i.subjectMileageKnown ? "Mileage was provided." : "Mileage was not provided; no mileage adjustment was possible.");
  if (n && i.medianAgeDays !== null) reasons.push(`Median comparable age is ${i.medianAgeDays} day(s).`);
  if (n) reasons.push(`Evidence comes from ${i.distinctSources} distinct source(s).`);
  if (n >= 2 && i.robustDispersion !== null) reasons.push(`Robust price dispersion across comparables is ${round(i.robustDispersion * 100, 1)}%.`);

  if (n && i.medianAgeDays !== null && i.medianAgeDays > STALE_AFTER_DAYS) { score *= 0.85; reasons.push(`Market evidence is stale (median age over ${STALE_AFTER_DAYS} days; confidence reduced).`); }
  if (i.conditionUnknown) { score *= 0.95; reasons.push("Condition was not provided (confidence reduced)."); }
  if (i.mileageEffectHeuristic) { score *= 0.93; reasons.push("The mileage effect uses a conservative market default because the comparables could not support a derived one (confidence reduced)."); }
  if (i.yearEffectHeuristic) { score *= 0.95; reasons.push("The model-year effect uses a conservative market default (confidence reduced)."); }
  if (i.regionalFallback) { score *= 0.9; reasons.push("Regional (cross-border) comparables were needed (confidence reduced)."); }
  if (n > 0 && n < 5) { score = Math.min(score, 0.59); reasons.push("Fewer than 5 comparables: confidence capped below medium."); }
  if (i.insufficient) { score = Math.min(score, 0.39); reasons.push("Evidence is insufficient for a defensible valuation."); }

  score = round(clamp(score, 0, 1), 2);
  return { score, level: confidenceLevel(score), reasons, factors: Object.fromEntries(Object.entries(factors).map(([k, v]) => [k, round(v, 2)])) as ConfidenceResult["factors"] };
}
