import {
  CHECKED_BASELINE_RISK, FLOOR_MIN_CONFIDENCE, MITIGATION_SATURATION, RISK_SATURATION, SEVERITY_OVERALL_FLOOR, SEVERITY_POINTS,
  SIGNAL_RULES, riskLevelFor, type SignalCode
} from "./config.js";
import { round2 } from "./evidence.js";
import { RISK_CATEGORIES, type CoverageLevel, type RiskCategory, type RiskLevel, type RiskSignal } from "./types.js";

/**
 * The deterministic scoring engine. Pure function of (signals, coverage, weights): no I/O, no clock,
 * no randomness, no model — the same evidence and configuration always yield the same score.
 *
 * Per category c (only when c has data coverage; otherwise its score is null — never guessed):
 *   P = Σ negative signals  SEVERITY_POINTS[severity] × weight × confidence
 *   M = Σ positive signals  SEVERITY_POINTS[severity] × weight × confidence
 *   score_c = baseline_c − baseline_c·(1 − e^(−M/MITIGATION_SATURATION)) + (100 − baseline_c)·(1 − e^(−P/RISK_SATURATION))
 *   clamped to [0, 100] and rounded.
 * Positive signals can only erode the residual baseline; they never cancel a detected red flag.
 *
 * Overall:
 *   raw = Σ_c w'_c × score_c over covered categories, where w'_c = w_c / Σ_covered w (renormalized)
 *   floor = max over sufficiently-confident negative signals of (rule.overallFloor, SEVERITY_OVERALL_FLOOR)
 *   riskScore = clamp(round(max(raw, floor)), 0, 100)
 */

export interface CategoryScore {
  category: RiskCategory;
  score: number | null;
  coverage: CoverageLevel;
  baseline: number;
  negativePoints: number;
  mitigationPoints: number;
  configuredWeight: number;
  effectiveWeight: number;
  contribution: number | null;
  signalCodes: string[];
}

export interface ScoreResult {
  riskScore: number;
  riskLevel: RiskLevel;
  rawWeightedScore: number;
  categories: Record<RiskCategory, CategoryScore>;
  floorsApplied: { code: string; minimumScore: number; reason: string }[];
}

export function signalPoints(s: RiskSignal): number {
  return SEVERITY_POINTS[s.severity] * s.weight * s.confidence;
}

export function scoreCategory(baseline: number, signals: readonly RiskSignal[]): { score: number; negativePoints: number; mitigationPoints: number } {
  const P = signals.filter(s => s.polarity === "negative").reduce((sum, s) => sum + signalPoints(s), 0);
  const M = signals.filter(s => s.polarity === "positive").reduce((sum, s) => sum + signalPoints(s), 0);
  const decrease = baseline * (1 - Math.exp(-M / MITIGATION_SATURATION));
  const increase = (100 - baseline) * (1 - Math.exp(-P / RISK_SATURATION));
  return { score: clamp(Math.round(baseline - decrease + increase)), negativePoints: round2(P), mitigationPoints: round2(M) };
}

export function computeScore(signals: readonly RiskSignal[], coverage: Readonly<Record<RiskCategory, CoverageLevel>>, weights: Readonly<Record<RiskCategory, number>>): ScoreResult {
  const covered = RISK_CATEGORIES.filter(c => coverage[c] !== "none");
  const coveredWeight = covered.reduce((s, c) => s + weights[c], 0);
  const categories = {} as Record<RiskCategory, CategoryScore>;
  let raw = 0;
  for (const c of RISK_CATEGORIES) {
    const own = signals.filter(s => s.category === c);
    const baseline = CHECKED_BASELINE_RISK[c];
    if (coverage[c] === "none" || coveredWeight === 0) {
      categories[c] = { category: c, score: null, coverage: coverage[c], baseline, negativePoints: 0, mitigationPoints: 0, configuredWeight: weights[c], effectiveWeight: 0, contribution: null, signalCodes: own.map(s => s.code) };
      continue;
    }
    const r = scoreCategory(baseline, own);
    const effectiveWeight = weights[c] / coveredWeight;
    const contribution = effectiveWeight * r.score;
    raw += contribution;
    categories[c] = { category: c, score: r.score, coverage: coverage[c], baseline, negativePoints: r.negativePoints, mitigationPoints: r.mitigationPoints, configuredWeight: weights[c], effectiveWeight: round4(effectiveWeight), contribution: round2(contribution), signalCodes: own.map(s => s.code) };
  }
  const floorsApplied: ScoreResult["floorsApplied"] = [];
  for (const s of signals) {
    if (s.polarity !== "negative" || s.confidence < FLOOR_MIN_CONFIDENCE) continue;
    const rule = SIGNAL_RULES[s.code as SignalCode] as { overallFloor?: number } | undefined;
    const floor = Math.max(rule?.overallFloor ?? 0, SEVERITY_OVERALL_FLOOR[s.severity] ?? 0);
    if (floor > 0) floorsApplied.push({ code: s.code, minimumScore: floor, reason: `${s.severity} signal ${s.code} at confidence ${s.confidence} sets a minimum overall score of ${floor}.` });
  }
  floorsApplied.sort((a, b) => b.minimumScore - a.minimumScore || a.code.localeCompare(b.code));
  const floor = floorsApplied[0]?.minimumScore ?? 0;
  const riskScore = clamp(Math.round(Math.max(raw, floor)));
  return { riskScore, riskLevel: riskLevelFor(riskScore), rawWeightedScore: round2(raw), categories, floorsApplied: floorsApplied.filter(f => f.minimumScore > raw) };
}

export function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function round4(n: number): number { return Math.round(n * 10000) / 10000; }
