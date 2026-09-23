import type { ReputationProvider, ReputationQuery } from "../company-reputation/providers/types.js";
import type { NormalizedEvidence, ProviderRun, SourceTier } from "../company-reputation/types.js";

/**
 * Shared vocabulary for business_risk_score — a GLOBAL, evidence-backed "is it risky to do
 * business with this company?" capability. One file, one vocabulary: providers, signal detectors,
 * the scoring engine, the confidence model and the output schema all agree on these literal unions.
 *
 * Pipeline (each stage consumes only the previous stage's normalized output):
 *   input → normalization → STAGE 1 collection (corporate registries + website + domain)
 *   → entity resolution (ambiguous / not found / outage → structured error, no deep scoring, no charge)
 *   → STAGE 2 collection (sanctions & export/debarment lists, news, reviews, regulatory, financial
 *     filings, threat intelligence) with the resolved identifiers
 *   → dedup + relevance filtering → risk-signal detection (six categories)
 *   → deterministic scoring engine → confidence model → recommendation → evidence-backed result.
 *
 * It deliberately REUSES the company_reputation_check evidence infrastructure (src/company-reputation/):
 * the NormalizedEvidence model, the ReputationProvider contract, the isolated/time-boxed/cache-first
 * provider runner, the shared evidence cache (rafid_company_evidence_cache), normalization, entity
 * resolution, deduplication, source-authority tiers and the adverse-media/sanctions classifiers.
 * What is new here is the RISK model: six independent risk categories, explicit risk signals with
 * weights and confidences, a 0–100 risk score (100 = highest detected risk), a separate confidence,
 * and machine-readable due-diligence guidance.
 */

export const RISK_CATEGORIES = ["corporate", "financial", "compliance", "reputation", "operational", "digital"] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export const RISK_SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type RiskSeverity = (typeof RISK_SEVERITIES)[number];

export const RISK_LEVELS = ["low", "moderate", "elevated", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RISK_ACTIONS = ["proceed", "proceed_with_monitoring", "enhanced_due_diligence", "manual_review", "avoid_automated_transaction"] as const;
export type RiskAction = (typeof RISK_ACTIONS)[number];

export const COVERAGE_LEVELS = ["high", "medium", "low", "none"] as const;
export type CoverageLevel = (typeof COVERAGE_LEVELS)[number];

/** How much a piece of evidence can be relied upon (derived from the source-authority tier). */
export const RELIABILITY_LEVELS = ["authoritative", "high", "medium", "low"] as const;
export type Reliability = (typeof RELIABILITY_LEVELS)[number];
export const RELIABILITY_BY_TIER: Readonly<Record<SourceTier, Reliability>> = { 1: "authoritative", 2: "high", 3: "medium", 4: "low" };

/** What kind of source an evidence item is (drives the "verified fact vs allegation" distinction). */
export const EVIDENCE_SOURCE_TYPES = [
  "company_registry", "lei_registry", "company_filing", "sanctions_list", "export_control_or_debarment_list",
  "regulatory_publication", "court_record", "news", "review_platform", "forum_or_social", "company_website", "domain_registration", "threat_intelligence"
] as const;
export type EvidenceSourceType = (typeof EVIDENCE_SOURCE_TYPES)[number];

/** Epistemic status of what an evidence item says — allegations are never presented as facts. */
export const EVIDENCE_CLASSES = [
  "official_record", "regulatory_action", "court_record", "credible_journalism", "other_publication", "user_generated", "allegation", "self_published"
] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

/**
 * One explicit risk signal. The scoring engine operates ONLY on these (never on raw evidence and
 * never on an LLM's opinion). `polarity: "positive"` signals mitigate risk in their category.
 *  - severity:   how serious the condition is if true (drives base points, config SEVERITY_POINTS)
 *  - weight:     rule multiplier for this signal code (config SIGNAL_RULES) — how much this kind of
 *                signal should move its category relative to its severity
 *  - confidence: 0–1, how strongly the evidence supports the signal (source authority × entity
 *                relevance × freshness × match strength)
 *  impact points = SEVERITY_POINTS[severity] × weight × confidence
 */
export interface RiskSignal {
  code: string;
  category: RiskCategory;
  polarity: "negative" | "positive";
  severity: RiskSeverity;
  weight: number;
  confidence: number;
  title: string;
  description: string;
  evidenceIds: string[];
  /** For reputation/compliance items: what the source actually establishes. */
  factStatus: "established" | "reported" | "alleged" | "observed" | null;
  /** True when the signal requires a human to verify it before relying on it (possible sanctions
   *  matches, identity conflicts). Drives the recommendation, never the arithmetic. */
  requiresVerification: boolean;
}

/** The normalized request every provider receives (a superset of the reputation query, so every
 *  reused ReputationProvider works unchanged). */
export interface BusinessRiskQuery extends ReputationQuery {
  knownAliases: string[];
  address: string | null;
  /** Stage 2 only: the resolved registry record already carries statutory-filing detail, so the
   *  financial filings provider need not look it up again. */
  filingDetailPresent?: boolean;
}

/** Provider roles (the six spec'd provider interfaces). Each is the shared ReputationProvider
 *  contract narrowed to the evidence it may produce, so the core engine operates on normalized
 *  evidence and never on provider-specific structures. */
export type ProviderRole = "corporate" | "financial" | "sanctions" | "news" | "regulatory" | "digital";

/** Company registries (identity, status, age, officers-level facts only where legitimately needed). */
export interface CorporateDataProvider extends ReputationProvider { readonly role: "corporate"; readonly category: "registry" }
/** Statutory filings / insolvency / financial statements. Produces "registry" evidence whose
 *  metadata.recordKind = "company_filing_status" (financial facts are registry facts). */
export interface FinancialDataProvider extends ReputationProvider { readonly role: "financial"; readonly category: "registry" }
/** Sanctions, export-control, debarment and exclusion lists. */
export interface SanctionsProvider extends ReputationProvider { readonly role: "sanctions"; readonly category: "sanctions" }
/** News, adverse media, customer reviews and forums. */
export interface NewsProvider extends ReputationProvider { readonly role: "news"; readonly category: "news" | "reviews" }
/** Regulator / enforcement publications (tier-1 "regulatory" evidence). */
export interface RegulatoryProvider extends ReputationProvider { readonly role: "regulatory"; readonly category: "news" }
/** Website, domain registration and threat-intelligence signals. */
export interface DigitalRiskProvider extends ReputationProvider { readonly role: "digital"; readonly category: "website" | "domain" }

export type BusinessRiskProvider = CorporateDataProvider | FinancialDataProvider | SanctionsProvider | NewsProvider | RegulatoryProvider | DigitalRiskProvider;

/** Collection stage a provider runs in. Stage 1 must complete (and resolve the entity) before any
 *  stage-2 provider — including every paid search — is called. */
export function providerStage(p: BusinessRiskProvider): 1 | 2 {
  return p.role === "corporate" || (p.role === "digital" && (p.id === "website_homepage" || p.id === "domain_rdap")) ? 1 : 2;
}

export interface RoleRun extends ProviderRun { role: ProviderRole; stage: 1 | 2 }

export type { NormalizedEvidence };
