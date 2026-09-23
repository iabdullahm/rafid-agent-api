import { CODE_POINTS, SCORING, SCORING_MODEL_VERSION, SEVERITY_POINTS } from "./config.js";
import { CODE_FAMILY, maxSeverity, severityRank, type Anomaly, type RiskFamily } from "./types.js";

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type Decision = "continue" | "review" | "hold";

export interface ScoreBreakdown {
  model: string;
  components: { code: string; severity: string; confidence: number; basePoints: number; points: number }[];
  lowSeverityPoints: number;
  mediumSeverityPoints: number;
  highSeverityPoints: number;
  escalationBonus: number;
  escalationReasons: string[];
  cappedBySeverity: boolean;
  rawScore: number;
  levelBands: { low: string; medium: string; high: string; critical: string };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Transparent, deterministic 0–100 risk score:
 *  1. Each anomaly contributes basePoints(code, severity) × confidence (SEVERITY_POINTS, with
 *     CODE_POINTS overrides — payment-detail changes and duplicates weigh most).
 *  2. Low/info contributions are capped at 10 in total and medium contributions at 45, so many
 *     trivial or moderate warnings cannot add up to a critical result.
 *  3. Escalation bonus for correlated anomalies: +8 per additional risk family carrying a ≥ medium
 *     anomaly (max 24), and +10 when a ≥ high payment-detail anomaly coincides with a ≥ medium
 *     duplicate, PO/contract or split anomaly.
 *  4. Severity ceiling: with no anomaly above low the score is at most 14 (low); with none above
 *     medium it is at most 64 (high) — only a high or critical anomaly can yield a critical score.
 *  5. Levels: 0–14 low, 15–39 medium, 40–64 high, 65–100 critical.
 */
export function scoreAnomalies(anomalies: readonly Anomaly[]): { riskScore: number; riskLevel: RiskLevel; decision: Decision; breakdown: ScoreBreakdown } {
  const components = anomalies.map(a => {
    const basePoints = CODE_POINTS[a.code]?.[a.severity] ?? SEVERITY_POINTS[a.severity];
    return { code: a.code, severity: a.severity, confidence: a.confidence, basePoints, points: r1(basePoints * a.confidence) };
  });
  const bySeverity = (pred: (rank: number) => boolean) => components.filter(c => pred(severityRank(c.severity as Anomaly["severity"]))).reduce((s, c) => s + c.points, 0);
  const low = Math.min(SCORING.lowSeverityCap, bySeverity(r => r <= 1));
  const medium = Math.min(SCORING.mediumSeverityCap, bySeverity(r => r === 2));
  const high = bySeverity(r => r >= 3);

  const familiesAtLeast = (minRank: number) => new Set<RiskFamily>(anomalies.filter(a => severityRank(a.severity) >= minRank).map(a => CODE_FAMILY[a.code]));
  const mediumFamilies = familiesAtLeast(2);
  const highFamilies = familiesAtLeast(3);
  const reasons: string[] = [];
  let bonus = 0;
  if (mediumFamilies.size > 1) {
    const b = Math.min(SCORING.familyBonusMax, SCORING.familyBonusPerExtra * (mediumFamilies.size - 1));
    bonus += b;
    reasons.push(`${mediumFamilies.size} independent risk families with ≥ medium anomalies (${[...mediumFamilies].sort().join(", ")}): +${b}`);
  }
  if (highFamilies.has("payment_details") && ["duplicate", "po_contract", "split"].some(f => mediumFamilies.has(f as RiskFamily))) {
    bonus += SCORING.paymentCorrelationBonus;
    reasons.push(`payment-detail anomaly combined with a duplicate, PO/contract or split anomaly: +${SCORING.paymentCorrelationBonus}`);
  }

  const raw = low + medium + high + bonus;
  const top = maxSeverity(anomalies.map(a => a.severity));
  const ceiling = severityRank(top) <= 1 ? SCORING.levels.lowMax : top === "medium" ? SCORING.levels.highMax : 100;
  const riskScore = Math.max(0, Math.min(100, ceiling, Math.round(raw)));
  const riskLevel: RiskLevel = riskScore <= SCORING.levels.lowMax ? "low" : riskScore <= SCORING.levels.mediumMax ? "medium" : riskScore <= SCORING.levels.highMax ? "high" : "critical";
  const decision: Decision = riskLevel === "low" ? "continue" : riskLevel === "critical" ? "hold" : "review";
  return {
    riskScore, riskLevel, decision,
    breakdown: {
      model: SCORING_MODEL_VERSION, components,
      lowSeverityPoints: r1(low), mediumSeverityPoints: r1(medium), highSeverityPoints: r1(high),
      escalationBonus: bonus, escalationReasons: reasons,
      cappedBySeverity: Math.round(raw) > ceiling, rawScore: r1(raw),
      levelBands: { low: `0-${SCORING.levels.lowMax}`, medium: `${SCORING.levels.lowMax + 1}-${SCORING.levels.mediumMax}`, high: `${SCORING.levels.mediumMax + 1}-${SCORING.levels.highMax}`, critical: `${SCORING.levels.highMax + 1}-100` }
    }
  };
}
