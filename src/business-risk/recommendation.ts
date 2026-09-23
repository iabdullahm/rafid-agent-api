import { FLOOR_MIN_CONFIDENCE, RECOMMENDATION, RESOLUTION } from "./config.js";
import type { RiskAction, RiskSignal } from "./types.js";

/**
 * Machine guidance for an autonomous agent — NOT a guarantee that a company is safe. Rules are
 * evaluated in order; the most restrictive applicable action wins and every rule that fired adds
 * its reason code (signal codes, or RULE_* codes for score/confidence rules).
 *
 *  1. a critical negative signal at confidence ≥ FLOOR_MIN_CONFIDENCE, or riskScore ≥ 61 → avoid_automated_transaction
 *  2. a negative (≥ medium) signal that requires human verification (possible sanctions match,
 *     identity conflict, identity not found) → manual_review
 *  3. entity match < RESOLUTION.manualReviewBelow or confidence < RECOMMENDATION.minConfidenceForAutomation → manual_review
 *  4. riskScore 41–60, any high negative signal, or entity match < RESOLUTION.enhancedDueDiligenceBelow → enhanced_due_diligence
 *  5. riskScore 21–40 → proceed_with_monitoring if confidence ≥ monitoringMinConfidence and no medium+
 *     negative signal, else enhanced_due_diligence
 *  6. riskScore 0–20 → proceed if confidence ≥ proceedMinConfidence and no medium+ negative signal,
 *     else proceed_with_monitoring
 * A sanctions CANDIDATE therefore yields manual_review (rule 2), not a "sanctioned" verdict; only a
 * high-confidence, identifier-corroborated match reaches rule 1.
 */

const ORDER: readonly RiskAction[] = ["proceed", "proceed_with_monitoring", "enhanced_due_diligence", "manual_review", "avoid_automated_transaction"];
const SEV = { info: 0, low: 1, medium: 2, high: 3, critical: 4 } as const;

export interface Recommendation { action: RiskAction; reasonCodes: string[]; rationale: string }

export function recommend(input: { riskScore: number; confidence: number; entityMatchConfidence: number; signals: readonly RiskSignal[] }): Recommendation {
  const negative = input.signals.filter(s => s.polarity === "negative" && s.confidence > 0);
  let action: RiskAction = "proceed";
  const reasons: string[] = [];
  const raise = (a: RiskAction, codes: readonly string[]) => {
    if (ORDER.indexOf(a) > ORDER.indexOf(action)) action = a;
    for (const c of codes) if (!reasons.includes(c)) reasons.push(c);
  };

  const critical = negative.filter(s => s.severity === "critical" && s.confidence >= FLOOR_MIN_CONFIDENCE);
  if (critical.length) raise("avoid_automated_transaction", critical.map(s => s.code));
  if (input.riskScore >= 61) raise("avoid_automated_transaction", ["RULE_RISK_SCORE_HIGH"]);

  const verify = negative.filter(s => s.requiresVerification && SEV[s.severity] >= SEV.medium && !critical.includes(s));
  if (verify.length) raise("manual_review", verify.map(s => s.code));
  if (input.entityMatchConfidence < RESOLUTION.manualReviewBelow) raise("manual_review", ["RULE_ENTITY_MATCH_LOW"]);
  if (input.confidence < RECOMMENDATION.minConfidenceForAutomation) raise("manual_review", ["RULE_LOW_CONFIDENCE"]);

  const high = negative.filter(s => s.severity === "high");
  if (input.riskScore > RECOMMENDATION.monitoringMaxScore) raise("enhanced_due_diligence", ["RULE_RISK_SCORE_ELEVATED"]);
  if (high.length) raise("enhanced_due_diligence", high.map(s => s.code));
  if (input.entityMatchConfidence < RESOLUTION.enhancedDueDiligenceBelow) raise("enhanced_due_diligence", ["RULE_ENTITY_NOT_VERIFIED"]);

  const mediumPlus = negative.filter(s => SEV[s.severity] >= SEV.medium);
  if (input.riskScore > RECOMMENDATION.proceedMaxScore) {
    if (input.confidence >= RECOMMENDATION.monitoringMinConfidence && mediumPlus.length === 0) raise("proceed_with_monitoring", ["RULE_RISK_SCORE_MODERATE"]);
    else raise("enhanced_due_diligence", mediumPlus.length ? mediumPlus.map(s => s.code) : ["RULE_CONFIDENCE_BELOW_MONITORING_THRESHOLD"]);
  } else if (input.confidence < RECOMMENDATION.proceedMinConfidence || mediumPlus.length > 0) {
    raise("proceed_with_monitoring", mediumPlus.length ? mediumPlus.map(s => s.code) : ["RULE_CONFIDENCE_BELOW_PROCEED_THRESHOLD"]);
  }
  if (reasons.length === 0) reasons.push("RULE_LOW_RISK_HIGH_CONFIDENCE");
  return { action, reasonCodes: reasons, rationale: RATIONALE[action] };
}

const RATIONALE: Readonly<Record<RiskAction, string>> = {
  proceed: "Low detected risk with adequate evidence. Standard controls apply; this is not a guarantee.",
  proceed_with_monitoring: "No material red flags, but the evidence or residual risk warrants ongoing monitoring.",
  enhanced_due_diligence: "Elevated risk indicators or incomplete verification: obtain additional documentation before transacting.",
  manual_review: "A finding requires human verification (e.g. an unconfirmed list match or unverified identity) before any automated decision.",
  avoid_automated_transaction: "Severe risk indicators were detected. Do not transact automatically; escalate to a human decision-maker."
};

export const INSUFFICIENT_DATA_RECOMMENDATION: Recommendation = {
  action: "manual_review",
  reasonCodes: ["INSUFFICIENT_DATA"],
  rationale: "No evidence source could be checked for this company in this deployment, so no risk assessment was possible."
};
