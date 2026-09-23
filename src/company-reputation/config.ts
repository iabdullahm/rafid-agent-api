import { getRiskLiveChecksEnabled } from "../intelligence/config.js";
import type { Dimension, ProviderCategory, SignalSeverity, SourceTier } from "./types.js";

/**
 * company_reputation_check configuration: (1) the documented, deterministic scoring model's
 * constants — every weight/threshold lives here, never as a magic number inside an analyzer — and
 * (2) env-var driven provider/cache/timeout settings (same plain `process.env` pattern as
 * src/intelligence/config.ts, every networked source OFF by default so `npm test`'s generic
 * per-capability loops never touch the network).
 */

export const SCORING_MODEL_VERSION = "crc-1.0.0";

// ---------------------------------------------------------------------------------------------
// 1. Scoring model
// ---------------------------------------------------------------------------------------------

/** Dimension weights (sum = 1.00). */
export const DIMENSION_WEIGHTS: Readonly<Record<Dimension, number>> = {
  identity: 0.20,
  legalRegulatory: 0.20,
  adverseMedia: 0.15,
  customerReputation: 0.15,
  onlinePresence: 0.10,
  businessStability: 0.10,
  cyberDomain: 0.05,
  transparency: 0.05
};

/** Every dimension is shrunk toward this neutral prior in proportion to how little evidence covers
 *  it: effective = PRIOR + coverage × (raw − PRIOR). Missing data therefore pulls a dimension to
 *  "unknown" (50), never to "good" — absence of evidence is not evidence of absence. */
export const NEUTRAL_PRIOR = 50;

/** Raw dimension score BEFORE signals, once a dimension has actually been checked. For the two
 *  "absence-of-problems" dimensions a clean check starts higher; the shrinkage above still limits
 *  how much a clean-but-thin check can lift the overall score. */
export const CHECKED_BASELINE: Readonly<Record<Dimension, number>> = {
  identity: 50, legalRegulatory: 75, adverseMedia: 75, customerReputation: 50,
  onlinePresence: 50, businessStability: 50, cyberDomain: 60, transparency: 50
};

/** Raw impact points per severity, multiplied by a signal's strength (0-1). */
export const SEVERITY_POINTS: Readonly<Record<SignalSeverity, number>> = { info: 3, low: 8, medium: 20, high: 40, critical: 80 };

/** Positive and negative impacts saturate: moved = MAX_SWING × (1 − e^(−Σpoints / SATURATION)).
 *  So many weak signals approach but never exceed the swing, and ONE weak signal moves a dimension
 *  only a few points (a single anonymous complaint ≈ 8 × 0.2 = 1.6 raw points → ~2 points). */
export const MAX_POSITIVE_SWING = 50;
export const MAX_NEGATIVE_SWING = 75;
export const SATURATION = 40;

/** Hard caps applied after weighting (documented gating rules, not hidden overrides). */
export const SCORE_CAPS = {
  /** An exact-name sanctions match corroborated by a country or identifier on the list. */
  highConfidenceSanctionsMatch: 20,
  /** A criminal conviction or court judgment for fraud/corruption/sanctions evasion, tier 1-2 source. */
  establishedSeriousWrongdoing: 35
} as const;

/** Coverage credit a dimension receives when a provider category was successfully checked, even
 *  if it found nothing ("we looked"). Bounded well below 1 so a clean check alone never produces
 *  full-confidence scores. */
export const CHECK_COVERAGE: Readonly<Record<ProviderCategory, Partial<Record<Dimension, number>>>> = {
  registry: { identity: 0.35, businessStability: 0.30, transparency: 0.20, legalRegulatory: 0.10 },
  sanctions: { legalRegulatory: 0.30 },
  news: { adverseMedia: 0.40, legalRegulatory: 0.15, businessStability: 0.05, onlinePresence: 0.10 },
  reviews: { customerReputation: 0.20 },
  website: { onlinePresence: 0.35, transparency: 0.25, identity: 0.10, cyberDomain: 0.30 },
  domain: { cyberDomain: 0.35, identity: 0.05 }
};

/** Coverage contributed by each INDEPENDENT evidence group backing a dimension's signals. */
export const TIER_COVERAGE: Readonly<Record<SourceTier, number>> = { 1: 0.35, 2: 0.25, 3: 0.12, 4: 0.04 };
export const MAX_EVIDENCE_COVERAGE = 0.6;

/** Base authority (quality) per tier — the scoring engine's notion of source authority. */
export const TIER_QUALITY: Readonly<Record<SourceTier, number>> = { 1: 1.0, 2: 0.8, 3: 0.5, 4: 0.2 };

/** Relevance below which an item is treated as possibly about a different entity and excluded. */
export const MIN_RELEVANCE = 0.5;

/** Trust-level thresholds (evidence-oriented wording; never "safe"/"trustworthy"). */
export const TRUST_THRESHOLDS = {
  minConfidenceForAssessment: 30,
  favorable: { minScore: 75, minConfidence: 60 },
  noMajorConcerns: { minScore: 60 },
  someConcerns: { minScore: 40 }
} as const;

/** Confidence model component weights (sum = 1.00). See confidence.ts. */
export const CONFIDENCE_WEIGHTS = {
  resolution: 0.30,
  dimensionCoverage: 0.20,
  independentSources: 0.15,
  authority: 0.10,
  freshness: 0.10,
  diversity: 0.10,
  jurisdictionCoverage: 0.05
} as const;

// ---------------------------------------------------------------------------------------------
// 2. Runtime configuration (env)
// ---------------------------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function num(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0): number {
  const raw = env[name] ? Number(env[name]) : NaN;
  return Number.isFinite(raw) && raw >= min ? raw : fallback;
}

/** Evidence cache TTL per provider category. */
export function getReputationCacheTtls(env: NodeJS.ProcessEnv = process.env): Readonly<Record<ProviderCategory, number>> {
  return {
    registry: num(env, "COMPANY_REPUTATION_REGISTRY_TTL_MS", 7 * DAY),
    sanctions: num(env, "COMPANY_REPUTATION_SANCTIONS_TTL_MS", 12 * HOUR),
    news: num(env, "COMPANY_REPUTATION_NEWS_TTL_MS", 1 * DAY),
    reviews: num(env, "COMPANY_REPUTATION_REVIEWS_TTL_MS", 3 * DAY),
    website: num(env, "COMPANY_REPUTATION_WEBSITE_TTL_MS", 3 * DAY),
    domain: num(env, "COMPANY_REPUTATION_DOMAIN_TTL_MS", 7 * DAY)
  };
}

/** How long past its TTL a cached evidence set may still be served when the live source fails —
 *  always flagged DATA_STALE in the output, never presented as fresh. */
export function getReputationMaxStaleMs(env: NodeJS.ProcessEnv = process.env): number {
  return num(env, "COMPANY_REPUTATION_MAX_STALE_MS", 14 * DAY);
}

export function getReputationProviderTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return num(env, "COMPANY_REPUTATION_PROVIDER_TIMEOUT_MS", 12_000, 1000);
}

/** Free public live sources (GLEIF, RDAP, company website, UN/US sanctions lists) — reuses the
 *  same switch as analyze_company_risk / oman_supplier_check. */
export function getReputationLiveChecksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getRiskLiveChecksEnabled(env);
}

/** Operator kill-switch for individual providers (cost/incident control), e.g. "reviews,news". */
export function getReputationDisabledProviders(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.COMPANY_REPUTATION_DISABLED_PROVIDERS ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
}

/** UK Companies House public data API key (free). Unset = UK registry provider disabled. */
export function getCompaniesHouseApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.COMPANIES_HOUSE_API_KEY?.trim() || null;
}

/** Evidence cache backend: Postgres when COMPANY_REPUTATION_DATABASE_URL (fallback DATABASE_URL) is
 *  set, else in-process memory. COMPANY_REPUTATION_EVIDENCE_STORE=memory forces memory. */
export function getReputationEvidenceDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  if ((env.COMPANY_REPUTATION_EVIDENCE_STORE ?? "").trim().toLowerCase() === "memory") return null;
  return env.COMPANY_REPUTATION_DATABASE_URL?.trim() || env.DATABASE_URL?.trim() || null;
}

/** Per-call outbound limits (unit economics at $0.40/call). */
export const LIMITS = {
  newsResultsPerQuery: 8,
  reviewResults: 8,
  maxEvidenceInOutput: 40,
  maxAdverseItemsInOutput: 15,
  websiteMaxBytes: 600_000,
  websiteTimeoutMs: 8_000,
  maxProviderAttempts: 2
} as const;

/** Estimated per-request upstream cost (USD) — internal telemetry only (Tavily-class search pricing,
 *  rounded up). Free public sources are 0. */
export const ESTIMATED_COST_PER_SEARCH_USD = 0.008;
