import {
  CHECK_COVERAGE, CHECKED_BASELINE, DIMENSION_WEIGHTS, MAX_EVIDENCE_COVERAGE, MAX_NEGATIVE_SWING, MAX_POSITIVE_SWING,
  NEUTRAL_PRIOR, SATURATION, SCORE_CAPS, SEVERITY_POINTS, TIER_COVERAGE
} from "./config.js";
import { DIMENSIONS, type Dimension, type ProviderRun, type Signal, type SourceTier } from "./types.js";

/**
 * Deterministic scoring: normalized SIGNALS → per-dimension scores → weighted reputationScore.
 *
 * For each dimension d:
 *   points±   = Σ SEVERITY_POINTS[severity] × strength     over positive / negative signals
 *   raw_d     = CHECKED_BASELINE[d] + MAX_POSITIVE_SWING·(1 − e^(−points+/SATURATION))
 *                                   − MAX_NEGATIVE_SWING·(1 − e^(−points−/SATURATION))   (clamped 0-100)
 *   coverage_d = min(1, Σ CHECK_COVERAGE[category][d] over checked providers (stale ×0.7)
 *                      + min(MAX_EVIDENCE_COVERAGE, Σ TIER_COVERAGE[tier] × relevance over the
 *                            independent evidence units behind d's signals))
 *                (identity: max(coverage, resolution confidence))
 *   score_d   = NEUTRAL_PRIOR + coverage_d × (raw_d − NEUTRAL_PRIOR)
 * reputationScore = round(Σ DIMENSION_WEIGHTS[d] × score_d), then documented caps.
 *
 * Properties: missing data → 50 (unknown), not "good"; one weak signal moves a dimension by a few
 * points; many duplicated weak items saturate instead of accumulating linearly (and duplicates are
 * already grouped upstream); scores are a pure function of (signals, provider runs, evidence
 * lookup), so identical evidence always yields identical scores.
 */

export interface EvidenceUnit { unitKey: string; tier: SourceTier; relevance: number }

export interface DimensionScore {
  dimension: Dimension;
  weight: number;
  /** Final (coverage-adjusted) 0-100 score. */
  score: number;
  /** Pre-shrinkage score from signals alone. */
  rawScore: number;
  /** 0-100: how much evidence actually covers this dimension. */
  coverage: number;
  positiveSignals: number;
  negativeSignals: number;
}

export interface ScoringResult {
  reputationScore: number;
  dimensions: Record<Dimension, DimensionScore>;
  capsApplied: string[];
}

function saturate(points: number, swing: number): number {
  return swing * (1 - Math.exp(-points / SATURATION));
}

export function computeCoverage(dimension: Dimension, runs: readonly ProviderRun[], signals: readonly Signal[], unitsByEvidence: ReadonlyMap<string, EvidenceUnit>): number {
  // Check credit per category: a second provider of the same category adds at most +50% of the
  // category credit (two sanctions lists are better than one, but not twice as good).
  const byCategory = new Map<string, number>();
  for (const run of runs) {
    if (run.status !== "ok" && run.status !== "stale_cache") continue;
    const credit = (CHECK_COVERAGE[run.category][dimension] ?? 0) * (run.status === "stale_cache" ? 0.7 : 1);
    byCategory.set(run.category, Math.min((CHECK_COVERAGE[run.category][dimension] ?? 0) * 1.5, (byCategory.get(run.category) ?? 0) + credit));
  }
  const check = [...byCategory.values()].reduce((s, v) => s + v, 0);

  const units = new Map<string, EvidenceUnit>();
  for (const s of signals) {
    if (s.dimension !== dimension || s.strength === 0) continue;
    for (const id of s.evidenceIds) { const u = unitsByEvidence.get(id); if (u) units.set(u.unitKey, u); }
  }
  let evidence = 0;
  for (const u of units.values()) evidence += TIER_COVERAGE[u.tier] * u.relevance;
  return Math.min(1, check + Math.min(MAX_EVIDENCE_COVERAGE, evidence));
}

export function scoreDimensions(signals: readonly Signal[], runs: readonly ProviderRun[], unitsByEvidence: ReadonlyMap<string, EvidenceUnit>, resolutionConfidence: number): ScoringResult {
  const dimensions = {} as Record<Dimension, DimensionScore>;
  for (const d of DIMENSIONS) {
    const own = signals.filter(s => s.dimension === d);
    const pos = own.filter(s => s.polarity === "positive").reduce((sum, s) => sum + SEVERITY_POINTS[s.severity] * s.strength, 0);
    const neg = own.filter(s => s.polarity === "negative").reduce((sum, s) => sum + SEVERITY_POINTS[s.severity] * s.strength, 0);
    const raw = Math.max(0, Math.min(100, CHECKED_BASELINE[d] + saturate(pos, MAX_POSITIVE_SWING) - saturate(neg, MAX_NEGATIVE_SWING)));
    let coverage = computeCoverage(d, runs, signals, unitsByEvidence);
    if (d === "identity") coverage = Math.max(coverage, resolutionConfidence);
    // A dimension nobody looked at has no baseline — it is simply unknown.
    const effectiveRaw = coverage === 0 ? NEUTRAL_PRIOR : raw;
    const score = NEUTRAL_PRIOR + coverage * (effectiveRaw - NEUTRAL_PRIOR);
    dimensions[d] = {
      dimension: d, weight: DIMENSION_WEIGHTS[d], score: Math.round(score), rawScore: Math.round(effectiveRaw), coverage: Math.round(coverage * 100),
      positiveSignals: own.filter(s => s.polarity === "positive" && s.strength > 0).length,
      negativeSignals: own.filter(s => s.polarity === "negative" && s.strength > 0).length
    };
  }
  // Weighted sum on unrounded dimension scores would be marginally more precise, but rounding the
  // components first keeps the result reproducible by hand from the published breakdown.
  let reputationScore = Math.round(DIMENSIONS.reduce((sum, d) => sum + DIMENSION_WEIGHTS[d] * dimensions[d].score, 0));
  const capsApplied: string[] = [];
  if (signals.some(s => s.code === "SANCTIONS_HIGH_CONFIDENCE_MATCH")) {
    if (reputationScore > SCORE_CAPS.highConfidenceSanctionsMatch) { reputationScore = SCORE_CAPS.highConfidenceSanctionsMatch; }
    capsApplied.push(`high_confidence_sanctions_match:max_${SCORE_CAPS.highConfidenceSanctionsMatch}`);
  }
  const serious = signals.some(s => s.polarity === "negative" && (s.severity === "critical" || s.severity === "high") && s.dimension === "legalRegulatory"
    && /^ADVERSE_(FRAUD|CORRUPTION|SANCTIONS|CRIMINAL_PROCEEDINGS|SCAM)_ESTABLISHED$/.test(s.code) && s.sourceTier !== null && s.sourceTier <= 2 && s.strength >= 0.6);
  if (serious) {
    if (reputationScore > SCORE_CAPS.establishedSeriousWrongdoing) reputationScore = SCORE_CAPS.establishedSeriousWrongdoing;
    capsApplied.push(`established_serious_wrongdoing:max_${SCORE_CAPS.establishedSeriousWrongdoing}`);
  }
  return { reputationScore: Math.max(0, Math.min(100, reputationScore)), dimensions, capsApplied };
}
