/**
 * Shared vocabulary for company_reputation_check — a GLOBAL, evidence-first company reputation and
 * commercial-risk intelligence capability. One file, one vocabulary (same discipline as
 * src/supplier-check/types.ts and src/intelligence/types.ts): providers, analyzers, scoring and the
 * output schema all agree on these literal unions.
 *
 * Pipeline (each stage only consumes the previous stage's normalized output):
 *   input → normalization → providers (collection → NormalizedEvidence) → cache → dedup
 *   → analyzers (evidence → Signals) → entity resolution → scoring (signals → dimension scores)
 *   → confidence → structured result.
 * Providers never score; analyzers never fetch; scoring never sees raw provider payloads.
 */

export const EVIDENCE_TYPES = ["news", "sanctions", "registry", "review", "website", "regulatory", "domain", "forum"] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

/** Source authority tiers (internal):
 *  1 = official government / regulator / court / statutory registry / sanctions list
 *  2 = major established news organization or authoritative industry source
 *  3 = established business database or review platform, unknown-but-plausible publishers
 *  4 = forums, social media, user-generated content */
export type SourceTier = 1 | 2 | 3 | 4;

export interface CompanyIdentifiers {
  name?: string | null;
  legalName?: string | null;
  country?: string | null;
  registrationNumber?: string | null;
  lei?: string | null;
  domain?: string | null;
  city?: string | null;
}

/** One normalized piece of evidence. Every conclusion in the output traces back to evidence ids. */
export interface NormalizedEvidence {
  id: string;
  type: EvidenceType;
  providerId: string;
  sourceName: string;
  sourceUrl: string | null;
  sourceDomain: string | null;
  sourceRecordId: string | null;
  sourceTier: SourceTier;
  title: string | null;
  summary: string | null;
  publishedAt: string | null;
  /** When Rafid actually retrieved this evidence from the source (a cached item keeps its ORIGINAL
   *  retrieval time — cache age never masquerades as fresh evidence). */
  observedAt: string;
  jurisdiction: string | null;
  companyIdentifiers: CompanyIdentifiers;
  /** Source authority × content quality, 0-1. */
  quality: number;
  /** How confidently this item concerns the requested company (entity resolution), 0-1. Set by the
   *  relevance stage, not by providers (providers set 1 for identifier-keyed lookups). */
  relevance: number;
  /** Internal, provider-specific structured facts (never raw payloads). Not exposed in the API. */
  metadata: Record<string, string | number | boolean | null | string[]>;
}

export type ProviderCategory = "registry" | "sanctions" | "news" | "reviews" | "website" | "domain";

/** Outcome of one provider for one request. "unavailable"/"timeout"/"rate_limited" are outages —
 *  never negative company signals; they reduce coverage and confidence only. */
export type ProviderRunStatus = "ok" | "not_configured" | "not_applicable" | "unavailable" | "timeout" | "rate_limited" | "stale_cache";

export interface ProviderFetchResult {
  status: Exclude<ProviderRunStatus, "stale_cache">;
  evidence: NormalizedEvidence[];
  reason: string | null;
  /** Number of outbound requests actually made (cost telemetry). */
  requests: number;
  /** Estimated upstream cost of this fetch in USD (internal telemetry only). */
  estimatedCostUSD: number;
}

export interface ProviderRun {
  providerId: string;
  providerName: string;
  category: ProviderCategory;
  status: ProviderRunStatus;
  evidence: NormalizedEvidence[];
  reason: string | null;
  fromCache: boolean;
  /** Original retrieval time of the evidence set (null when nothing was retrieved). */
  fetchedAt: string | null;
  requests: number;
  estimatedCostUSD: number;
  durationMs: number;
  attempts: number;
}

export const DIMENSIONS = ["identity", "legalRegulatory", "adverseMedia", "customerReputation", "onlinePresence", "businessStability", "cyberDomain", "transparency"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const SIGNAL_SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type SignalSeverity = (typeof SIGNAL_SEVERITIES)[number];
export type SignalPolarity = "positive" | "negative" | "neutral";

/** An analyzer's structured conclusion about the evidence. Scoring operates ONLY on these. */
export interface Signal {
  code: string;
  dimension: Dimension;
  polarity: SignalPolarity;
  severity: SignalSeverity;
  message: string;
  evidenceIds: string[];
  /** Authority of the strongest supporting evidence (1 best … 4 weakest); null for derived checks. */
  sourceTier: SourceTier | null;
  /** 0-1: how much this signal should move its dimension — authority × relevance × corroboration.
   *  Computed by the analyzer from evidence, bounded, and documented per analyzer. */
  strength: number;
}

export const ADVERSE_CATEGORIES = [
  "fraud", "scam", "sanctions", "regulatory", "litigation", "insolvency", "corruption",
  "contract_dispute", "data_breach", "criminal_proceedings", "operational_failure", "customer_harm"
] as const;
export type AdverseCategory = (typeof ADVERSE_CATEGORIES)[number];

/** Legal stage — allegations are never represented as established facts. */
export const LEGAL_STAGES = [
  "allegation", "investigation", "lawsuit_filed", "charge", "regulatory_action", "settlement",
  "judgment", "conviction", "dismissed_or_acquitted", "unspecified"
] as const;
export type LegalStage = (typeof LEGAL_STAGES)[number];

export const WARNING_CODES = [
  "COMPANY_NOT_RESOLVED", "AMBIGUOUS_COMPANY", "INSUFFICIENT_EVIDENCE", "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT", "RATE_LIMITED", "DATA_STALE", "PROVIDER_NOT_CONFIGURED", "COUNTRY_NOT_PROVIDED"
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export interface ReputationWarning {
  code: WarningCode;
  message: string;
  provider: string | null;
}
