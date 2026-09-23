import { CONFIDENCE_WEIGHTS, DIMENSION_WEIGHTS, TIER_QUALITY } from "./config.js";
import type { Resolution } from "./companyResolver.js";
import type { EvidenceUnit, ScoringResult } from "./scoring.js";
import { DIMENSIONS, type ProviderRun } from "./types.js";

/**
 * confidenceScore (0-100) — how much the reputationScore can be relied on. SEPARATE from the
 * reputation score: 78/91 (well-evidenced) and 78/34 (thinly evidenced) mean very different things.
 *
 * Components (each 0-1, weights in config.CONFIDENCE_WEIGHTS):
 *  resolution            entity-resolution confidence (identifier match ≫ name-only ≫ unresolved)
 *  dimensionCoverage     Σ weight_d × coverage_d — how much of the model is backed by evidence
 *  independentSources    1 − e^(−n/6), n = independent units (event groups, not articles; each
 *                        registry/list/domain/website check counts once)
 *  authority             mean authority (tier quality) of the independent units
 *  freshness             share of provider evidence served fresh (stale cache counts 0.4) and of
 *                        dated third-party items published within 3 years
 *  diversity             distinct evidence types / 5
 *  jurisdictionCoverage  1 = a jurisdiction-specific registry covered the company, 0.5 = only the
 *                        global LEI index, 0 = no registry
 * Caps: ambiguous identity ≤ 40; unresolved / registry not checked ≤ 50; each outage (unavailable/
 * timeout/rate-limited provider that was supposed to run) −3.
 */

export interface ConfidenceBreakdown {
  score: number;
  components: Record<keyof typeof CONFIDENCE_WEIGHTS, number>;
  capsApplied: string[];
}

export function computeConfidence(input: {
  resolution: Resolution;
  scoring: ScoringResult;
  runs: readonly ProviderRun[];
  units: readonly EvidenceUnit[];
  evidenceTypes: ReadonlySet<string>;
  datedThirdParty: readonly (string | null)[];
  now: Date;
}): ConfidenceBreakdown {
  const { resolution, scoring, runs, units, evidenceTypes, now } = input;
  const dimensionCoverage = DIMENSIONS.reduce((s, d) => s + DIMENSION_WEIGHTS[d] * (scoring.dimensions[d].coverage / 100), 0);
  const n = units.length;
  const independentSources = 1 - Math.exp(-n / 6);
  const authority = n === 0 ? 0 : units.reduce((s, u) => s + TIER_QUALITY[u.tier], 0) / n;

  const checkedRuns = runs.filter(r => r.status === "ok" || r.status === "stale_cache");
  const runFreshness = checkedRuns.length === 0 ? 0 : checkedRuns.reduce((s, r) => s + (r.status === "stale_cache" ? 0.4 : 1), 0) / checkedRuns.length;
  const dated = input.datedThirdParty.filter((d): d is string => Boolean(d) && Number.isFinite(Date.parse(d!)));
  const recentShare = dated.length === 0 ? 1 : dated.filter(d => now.getTime() - Date.parse(d) <= 3 * 365.25 * 86_400_000).length / dated.length;
  const freshness = runFreshness * (0.7 + 0.3 * recentShare);

  const diversity = Math.min(1, evidenceTypes.size / 5);
  const registryRuns = checkedRuns.filter(r => r.category === "registry");
  const jurisdictionCoverage = registryRuns.some(r => r.providerId !== "registry_gleif") ? 1 : registryRuns.length > 0 ? 0.5 : 0;

  const components = {
    resolution: resolution.confidence, dimensionCoverage, independentSources, authority, freshness, diversity, jurisdictionCoverage
  };
  let score = 100 * (Object.keys(CONFIDENCE_WEIGHTS) as (keyof typeof CONFIDENCE_WEIGHTS)[]).reduce((s, k) => s + CONFIDENCE_WEIGHTS[k] * components[k], 0);
  const capsApplied: string[] = [];
  const outages = runs.filter(r => r.status === "unavailable" || r.status === "timeout" || r.status === "rate_limited").length;
  if (outages > 0) { score -= 3 * outages; capsApplied.push(`provider_outages:-${3 * outages}`); }
  if (resolution.status === "ambiguous" && score > 40) { score = 40; capsApplied.push("ambiguous_identity:max_40"); }
  if ((resolution.status === "unresolved" || resolution.status === "registry_not_checked") && score > 50) { score = 50; capsApplied.push("identity_not_resolved:max_50"); }
  const round2 = (x: number) => Math.round(x * 100) / 100;
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    components: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, round2(v)])) as ConfidenceBreakdown["components"],
    capsApplied
  };
}
