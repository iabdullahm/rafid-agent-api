import { maxSeverity, severityRank, type Anomaly, type AnomalyCode, type Issue, type Severity } from "../types.js";

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const clamp01 = (n: number) => Math.max(0, Math.min(1, round2(n)));

/** Folds a check's sub-findings into ONE anomaly per code: severity = the most severe issue,
 *  confidence = the highest confidence among issues of that severity, evidence.issues = every
 *  sub-finding (ordered most severe first, stable otherwise) — so the count of anomalies reflects
 *  distinct risk types rather than how many times one condition repeats. */
export function fold(code: AnomalyCode, field: string | null, issues: readonly Issue[], explanation: (top: Issue, all: readonly Issue[]) => string, extra: Record<string, unknown> = {}): Anomaly | null {
  if (issues.length === 0) return null;
  const severity: Severity = maxSeverity(issues.map(i => i.severity));
  const ordered = [...issues].map((issue, i) => ({ issue, i }))
    .sort((a, b) => severityRank(b.issue.severity) - severityRank(a.issue.severity) || b.issue.confidence - a.issue.confidence || a.i - b.i)
    .map(x => x.issue);
  const top = ordered[0]!;
  return {
    code, severity, confidence: clamp01(top.confidence), field,
    explanation: explanation(top, ordered),
    evidence: { ...extra, issues: ordered.map(i => ({ reason: i.reason, severity: i.severity, ...i.detail })) }
  };
}
