import type { Resolution } from "../companyResolver.js";
import type { EvidenceGroup } from "../deduplication.js";
import type { ReputationQuery } from "../providers/types.js";
import { tierQuality } from "../sourceQuality.js";
import type { Dimension, NormalizedEvidence, ProviderRun, Signal, SignalPolarity, SignalSeverity, SourceTier } from "../types.js";

/** Everything an analyzer may read. Analyzers never fetch and never see raw provider payloads. */
export interface AnalysisContext {
  query: ReputationQuery;
  resolution: Resolution;
  runs: readonly ProviderRun[];
  /** Registry evidence (all candidates). */
  registry: readonly NormalizedEvidence[];
  sanctions: readonly NormalizedEvidence[];
  website: NormalizedEvidence | null;
  domain: NormalizedEvidence | null;
  /** Third-party items that passed relevance (≥ MIN_RELEVANCE), grouped into underlying events. */
  thirdPartyGroups: readonly EvidenceGroup[];
  now: Date;
}

export function runsFor(ctx: AnalysisContext, category: ProviderRun["category"]): ProviderRun[] {
  return ctx.runs.filter(r => r.category === category);
}

export function checked(run: ProviderRun): boolean {
  return run.status === "ok" || run.status === "stale_cache";
}

export function signal(code: string, dimension: Dimension, polarity: SignalPolarity, severity: SignalSeverity, message: string, evidence: readonly NormalizedEvidence[] | readonly string[], strength: number, sourceTier: SourceTier | null = null): Signal {
  const evidenceIds = (evidence as readonly (NormalizedEvidence | string)[]).map(e => (typeof e === "string" ? e : e.id));
  const tier = sourceTier ?? (evidence as readonly (NormalizedEvidence | string)[]).reduce<SourceTier | null>((best, e) => (typeof e === "string" ? best : best === null || e.sourceTier < best ? e.sourceTier : best), null);
  return { code, dimension, polarity, severity, message, evidenceIds: [...new Set(evidenceIds)].sort(), sourceTier: tier, strength: Math.round(Math.max(0, Math.min(1, strength)) * 100) / 100 };
}

/** Strength of a third-party event group: authority of its best source × mean relevance ×
 *  bounded corroboration (independent publishers add at most +30%; syndicated copies of one story
 *  on the same publisher add nothing). */
export function groupStrength(group: EvidenceGroup): number {
  const bestTier = Math.min(...group.members.map(m => m.sourceTier)) as SourceTier;
  const meanRelevance = group.members.reduce((s, m) => s + m.relevance, 0) / group.members.length;
  const publishers = new Set(group.members.map(m => m.sourceDomain ?? m.sourceName)).size;
  return Math.min(1, tierQuality(bestTier) * meanRelevance * (1 + 0.1 * Math.min(3, publishers - 1)));
}

export function str(v: unknown): string | null { return typeof v === "string" && v.length > 0 ? v : null; }
export function strs(v: unknown): string[] { return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; }

export function yearsBetween(fromIso: string | null, now: Date): number | null {
  if (!fromIso) return null;
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return null;
  return (now.getTime() - t) / (365.25 * 86_400_000);
}
