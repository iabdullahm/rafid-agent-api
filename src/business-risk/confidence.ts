import { CONFIDENCE_WEIGHTS, CONTRADICTION_PENALTY, COVERAGE_VALUE, RESOLUTION } from "./config.js";
import { round2, type EvidenceView } from "./evidence.js";
import { RISK_CATEGORIES, type CoverageLevel, type RiskCategory, type RiskSignal } from "./types.js";

/**
 * Confidence model — how strongly the evidence supports the result. Separate from the risk score:
 * "riskScore 18, confidence 0.31" means low DETECTED risk on thin evidence.
 *
 *   confidence = Σ CONFIDENCE_WEIGHTS[k] × component_k, each component in [0, 1]:
 *     entityResolution      entity-match confidence of the resolved company
 *     categoryCoverage      Σ_c categoryWeight_c × COVERAGE_VALUE[coverage_c]  (how much of the model had data)
 *     sourceQuality         mean reliability of the independent source records (authoritative 1 · high 0.8 · medium 0.5 · low 0.2)
 *     authoritativeRecords  1 = matched a jurisdiction registry · 0.7 = matched a global/secondary registry ·
 *                           0.4 = other authoritative checks only (lists, RDAP) · 0 = none
 *     freshness             mean freshness weight of the source records (decayed media, stale cache ×0.5)
 *     consistency           1 − CONTRADICTION_PENALTY × (contradictions: identity conflicts, address/city
 *                           mismatches, cross-domain redirects/emails, stale evidence sets), floor 0
 *   Cap: identity not verified against any registry → ≤ RESOLUTION.unverifiedConfidenceCap.
 */

export interface ConfidenceResult {
  confidence: number;
  components: Record<keyof typeof CONFIDENCE_WEIGHTS, number>;
  contradictions: string[];
  capsApplied: string[];
}

const RELIABILITY_VALUE = { authoritative: 1, high: 0.8, medium: 0.5, low: 0.2 } as const;
const CONTRADICTION_CODES = new Set(["IDENTIFIER_NAME_MISMATCH", "REGISTRY_CITY_MISMATCH", "ADDRESS_MISMATCH", "REDIRECTS_TO_OTHER_DOMAIN", "EMAIL_DOMAIN_MISMATCH"]);

export function computeConfidence(input: {
  entityMatchConfidence: number;
  identityVerified: boolean;
  jurisdictionRegistryMatched: boolean;
  anyRegistryMatched: boolean;
  coverage: Readonly<Record<RiskCategory, CoverageLevel>>;
  weights: Readonly<Record<RiskCategory, number>>;
  sourceRecords: readonly EvidenceView[];
  signals: readonly RiskSignal[];
  staleProviderRuns: number;
}): ConfidenceResult {
  const categoryCoverage = RISK_CATEGORIES.reduce((s, c) => s + input.weights[c] * COVERAGE_VALUE[input.coverage[c]], 0);
  const records = input.sourceRecords;
  const sourceQuality = records.length ? records.reduce((s, e) => s + RELIABILITY_VALUE[e.reliability], 0) / records.length : 0;
  const authoritativeRecords = input.jurisdictionRegistryMatched ? 1 : input.anyRegistryMatched ? 0.7 : records.some(e => e.reliability === "authoritative") ? 0.4 : 0;
  const freshness = records.length ? records.reduce((s, e) => s + e.freshness, 0) / records.length : 0;
  const contradictions = [
    ...input.signals.filter(s => CONTRADICTION_CODES.has(s.code)).map(s => s.code),
    ...(input.staleProviderRuns > 0 ? [`STALE_EVIDENCE_SETS:${input.staleProviderRuns}`] : [])
  ];
  const consistency = Math.max(0, 1 - CONTRADICTION_PENALTY * contradictions.length);
  const components = {
    entityResolution: round2(input.entityMatchConfidence),
    categoryCoverage: round2(categoryCoverage),
    sourceQuality: round2(sourceQuality),
    authoritativeRecords: round2(authoritativeRecords),
    freshness: round2(freshness),
    consistency: round2(consistency)
  };
  let confidence = (Object.keys(CONFIDENCE_WEIGHTS) as (keyof typeof CONFIDENCE_WEIGHTS)[]).reduce((s, k) => s + CONFIDENCE_WEIGHTS[k] * components[k], 0);
  const capsApplied: string[] = [];
  if (!input.identityVerified && confidence > RESOLUTION.unverifiedConfidenceCap) {
    confidence = RESOLUTION.unverifiedConfidenceCap;
    capsApplied.push(`identity_not_verified:${RESOLUTION.unverifiedConfidenceCap}`);
  }
  return { confidence: round2(Math.max(0, Math.min(1, confidence))), components, contradictions, capsApplied };
}
