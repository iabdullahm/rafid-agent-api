import type { CoverageLevel, RiskCategory, RiskLevel, RiskSeverity } from "./types.js";

/**
 * business_risk_score configuration — the ONE place every weight, threshold and band of the
 * scoring engine lives. No detector, scorer or confidence function may hard-code a magic number;
 * each reads it from here, so the methodology can be audited (and is echoed in every response's
 * `methodology`) and changed in one place. Bump SCORING_MODEL_VERSION whenever any constant that
 * can change a score changes.
 */

export const SCORING_MODEL_VERSION = "brs-1.0.0";

// ---------------------------------------------------------------------------------------------
// 1. Category weights (overall score = weighted mean of the COVERED categories' scores)
// ---------------------------------------------------------------------------------------------

export const DEFAULT_CATEGORY_WEIGHTS: Readonly<Record<RiskCategory, number>> = {
  corporate: 0.20,
  financial: 0.20,
  compliance: 0.25,
  reputation: 0.15,
  operational: 0.10,
  digital: 0.10
};

export interface CategoryWeights { weights: Readonly<Record<RiskCategory, number>>; source: "default" | "env" | "default_env_invalid" }

/** BUSINESS_RISK_CATEGORY_WEIGHTS='{"compliance":0.3,"digital":0.05,…}' overrides individual
 *  weights (missing keys keep their default); the result is re-normalized to sum to 1. An invalid
 *  value never breaks a request: the defaults are used and `methodology.weightsSource` says so. */
export function getCategoryWeights(env: NodeJS.ProcessEnv = process.env): CategoryWeights {
  const raw = env.BUSINESS_RISK_CATEGORY_WEIGHTS?.trim();
  if (!raw) return { weights: DEFAULT_CATEGORY_WEIGHTS, source: "default" };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    const merged: Record<RiskCategory, number> = { ...DEFAULT_CATEGORY_WEIGHTS };
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!(k in merged) || typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`invalid weight ${k}`);
      merged[k as RiskCategory] = v;
    }
    const sum = Object.values(merged).reduce((s, v) => s + v, 0);
    if (sum <= 0) throw new Error("weights sum to 0");
    return { weights: Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, round4(v / sum)])) as Record<RiskCategory, number>, source: "env" };
  } catch {
    return { weights: DEFAULT_CATEGORY_WEIGHTS, source: "default_env_invalid" };
  }
}

// ---------------------------------------------------------------------------------------------
// 2. Category scoring
// ---------------------------------------------------------------------------------------------

/** Base impact points per severity; a signal contributes points × rule weight × confidence.
 *  "info" signals are informational only — they never move a score. */
export const SEVERITY_POINTS: Readonly<Record<RiskSeverity, number>> = { info: 0, low: 8, medium: 20, high: 40, critical: 70 };

/** Residual risk of a category that WAS checked and produced no signal at all. A clean check is
 *  not zero risk; an unchecked category has no score (null) instead — never a guessed one. */
export const CHECKED_BASELINE_RISK: Readonly<Record<RiskCategory, number>> = {
  corporate: 15, financial: 20, compliance: 5, reputation: 12, operational: 15, digital: 15
};

/** Negative points saturate toward 100: increase = (100 − baseline) × (1 − e^(−P / RISK_SATURATION)).
 *  One medium signal at full confidence ≈ +36% of the headroom; one critical ≈ +79%. Many weak
 *  signals approach but never exceed 100. */
export const RISK_SATURATION = 45;
/** Positive signals only erode the residual BASELINE (never an actual red flag):
 *  decrease = baseline × (1 − e^(−M / MITIGATION_SATURATION)). */
export const MITIGATION_SATURATION = 30;

/** A strong enough signal of these severities sets a documented MINIMUM for the overall score, so a
 *  single decisive finding cannot be averaged away by clean categories (see SIGNAL_RULES.overallFloor
 *  for rule-specific floors). Applies only when the signal's confidence ≥ FLOOR_MIN_CONFIDENCE. */
export const SEVERITY_OVERALL_FLOOR: Readonly<Partial<Record<RiskSeverity, number>>> = { critical: 61, high: 35 };
export const FLOOR_MIN_CONFIDENCE = 0.6;

/** 0–20 low · 21–40 moderate · 41–60 elevated · 61–80 high · 81–100 critical. */
export const RISK_LEVEL_BANDS: readonly { level: RiskLevel; min: number; max: number }[] = [
  { level: "low", min: 0, max: 20 },
  { level: "moderate", min: 21, max: 40 },
  { level: "elevated", min: 41, max: 60 },
  { level: "high", min: 61, max: 80 },
  { level: "critical", min: 81, max: 100 }
];

export function riskLevelFor(score: number): RiskLevel {
  const s = Math.max(0, Math.min(100, Math.round(score)));
  return RISK_LEVEL_BANDS.find(b => s >= b.min && s <= b.max)!.level;
}

// ---------------------------------------------------------------------------------------------
// 3. Signal rules — every signal code the detectors can emit, with its category, default severity
//    and weight. Detectors supply confidence (and, for classifier-driven adverse media, severity).
// ---------------------------------------------------------------------------------------------

export interface SignalRule {
  category: RiskCategory;
  polarity: "negative" | "positive";
  severity: RiskSeverity;
  weight: number;
  title: string;
  /** Rule-specific overall-score minimum (see SEVERITY_OVERALL_FLOOR). */
  overallFloor?: number;
  requiresVerification?: boolean;
}

const neg = (category: RiskCategory, severity: RiskSeverity, weight: number, title: string, extra: Partial<SignalRule> = {}): SignalRule => ({ category, polarity: "negative", severity, weight, title, ...extra });
const pos = (category: RiskCategory, severity: RiskSeverity, weight: number, title: string): SignalRule => ({ category, polarity: "positive", severity, weight, title });

export const SIGNAL_RULES = {
  // Corporate
  ACTIVE_REGISTRATION: pos("corporate", "medium", 1, "Active registration"),
  ESTABLISHED_BUSINESS: pos("corporate", "low", 1, "Established business (5+ years)"),
  MULTI_REGISTRY_CORROBORATION: pos("corporate", "low", 1, "Identity corroborated by more than one official registry"),
  COMPANY_DISSOLVED: neg("corporate", "critical", 1, "Company dissolved or removed from the register", { overallFloor: 81 }),
  COMPANY_INACTIVE: neg("corporate", "high", 1, "Registration inactive"),
  STRIKE_OFF_PENDING: neg("corporate", "high", 1, "Registry reports a pending strike-off / removal"),
  VERY_RECENTLY_INCORPORATED: neg("corporate", "high", 0.8, "Incorporated within the last 90 days"),
  RECENTLY_INCORPORATED: neg("corporate", "medium", 0.8, "Incorporated within the last year"),
  REPEATED_NAME_CHANGES: neg("corporate", "medium", 0.8, "Repeated company-name changes"),
  IDENTITY_NOT_FOUND_IN_REGISTRY: neg("corporate", "high", 1, "Company not found in its jurisdiction's registry", { requiresVerification: true }),
  REGISTRATION_NUMBER_NOT_FOUND: neg("corporate", "high", 1, "Supplied registration number not found in the registry", { requiresVerification: true }),
  IDENTIFIER_NAME_MISMATCH: neg("corporate", "high", 1, "Identifier belongs to a differently named entity", { requiresVerification: true }),
  REGISTRY_CITY_MISMATCH: neg("corporate", "low", 1, "Registered city differs from the supplied city"),
  LEI_LAPSED: neg("corporate", "low", 0.6, "Legal Entity Identifier registration lapsed"),
  HIGH_RISK_JURISDICTION: neg("corporate", "high", 1, "Registered in a FATF high-risk jurisdiction (call for action)"),
  SHELL_COMPANY_INDICATORS: neg("corporate", "medium", 1, "Shell-company indicators", { requiresVerification: true }),
  // Financial
  FILINGS_UP_TO_DATE: pos("financial", "medium", 1, "Statutory filings up to date"),
  INSOLVENCY_PROCEEDINGS: neg("financial", "critical", 1, "Insolvency, liquidation or administration proceedings", { overallFloor: 70 }),
  INSOLVENCY_HISTORY: neg("financial", "medium", 1, "Registry reports past insolvency history"),
  ACCOUNTS_OVERDUE: neg("financial", "high", 1, "Statutory accounts overdue"),
  CONFIRMATION_STATEMENT_OVERDUE: neg("financial", "medium", 1, "Annual confirmation statement overdue"),
  REPORTED_INSOLVENCY: neg("financial", "medium", 1, "Insolvency / financial distress reported in media"),
  LIMITED_FINANCIAL_HISTORY: neg("financial", "info", 0, "Limited public financial information"),
  // Compliance
  NO_SANCTIONS_MATCH: pos("compliance", "low", 1, "No sanctions / restricted-party list match"),
  SANCTIONS_HIGH_CONFIDENCE_MATCH: neg("compliance", "critical", 1, "High-confidence potential sanctions-list match", { overallFloor: 85, requiresVerification: true }),
  SANCTIONS_POSSIBLE_MATCH: neg("compliance", "medium", 1, "Possible sanctions-list name match (unconfirmed)", { requiresVerification: true }),
  RESTRICTED_PARTY_HIGH_CONFIDENCE_MATCH: neg("compliance", "high", 1, "High-confidence potential export-control / debarment list match", { overallFloor: 70, requiresVerification: true }),
  RESTRICTED_PARTY_POSSIBLE_MATCH: neg("compliance", "medium", 0.8, "Possible export-control / debarment list name match (unconfirmed)", { requiresVerification: true }),
  REGULATORY_ENFORCEMENT: neg("compliance", "high", 1, "Regulatory enforcement action reported"),
  REGULATORY_CONCERN: neg("compliance", "medium", 1, "Regulatory, sanctions or corruption concern reported (not established)"),
  // Reputation
  NO_ADVERSE_MEDIA_FOUND: pos("reputation", "low", 1, "No adverse media found in checked sources"),
  FAVORABLE_CUSTOMER_RATING: pos("reputation", "low", 1, "Favorable aggregate customer rating"),
  ADVERSE_MEDIA_ESTABLISHED: neg("reputation", "high", 1, "Adverse outcome reported (judgment, conviction, settlement)"),
  ADVERSE_MEDIA_ALLEGATION: neg("reputation", "medium", 0.8, "Adverse allegation, investigation or lawsuit reported"),
  UNFAVORABLE_CUSTOMER_RATING: neg("reputation", "medium", 0.8, "Unfavorable aggregate customer rating"),
  COMPLAINT_PATTERN: neg("reputation", "medium", 0.7, "Pattern of independent customer complaints"),
  CUSTOMER_COMPLAINT: neg("reputation", "low", 0.5, "Individual customer complaint (unverified)"),
  // Operational
  VERIFIED_OPERATING_PRESENCE: pos("operational", "medium", 1, "Operating website identifies the company"),
  CONTACT_INFORMATION_PRESENT: pos("operational", "low", 1, "Contact information published"),
  BUSINESS_ACTIVITY_CONSISTENT: pos("operational", "low", 1, "Claimed business activity consistent with public presence"),
  WEBSITE_UNREACHABLE: neg("operational", "medium", 1, "Supplied website not reachable"),
  WEBSITE_PARKED: neg("operational", "high", 1, "Supplied website is a parked / for-sale domain"),
  WEBSITE_UNDER_CONSTRUCTION: neg("operational", "low", 1, "Website under construction / placeholder"),
  NO_CONTACT_INFORMATION: neg("operational", "low", 0.8, "No contact information on the website"),
  ADDRESS_MISMATCH: neg("operational", "medium", 1, "Supplied address inconsistent with the registered address"),
  BUSINESS_ACTIVITY_NOT_EVIDENT: neg("operational", "info", 0, "Claimed business activity not evident from public presence"),
  // Digital
  ESTABLISHED_DOMAIN: pos("digital", "low", 1, "Long-established domain (5+ years)"),
  DOMAIN_NAME_CONSISTENT: pos("digital", "low", 1, "Domain consistent with the company name"),
  NO_THREAT_LISTING: pos("digital", "low", 1, "Not listed by the checked malware/phishing threat feed"),
  DOMAIN_NEWLY_REGISTERED: neg("digital", "high", 1, "Domain registered within the last 90 days"),
  DOMAIN_RECENTLY_REGISTERED: neg("digital", "medium", 0.8, "Domain registered within the last year"),
  DOMAIN_NOT_REGISTERED: neg("digital", "high", 1, "Supplied domain has no registration record"),
  DOMAIN_HOLD_STATUS: neg("digital", "high", 1, "Domain on registry/registrar hold or pending deletion"),
  DOMAIN_EXPIRING_SOON: neg("digital", "medium", 0.7, "Domain registration expires within 30 days"),
  NO_HTTPS: neg("digital", "low", 1, "Website not served over HTTPS"),
  REDIRECTS_TO_OTHER_DOMAIN: neg("digital", "medium", 1, "Website redirects to an unrelated domain"),
  DOMAIN_NAME_INCONSISTENT: neg("digital", "low", 0.5, "Domain does not resemble the company name"),
  FREE_EMAIL_ON_WEBSITE: neg("digital", "low", 1, "Business uses free webmail addresses"),
  EMAIL_DOMAIN_MISMATCH: neg("digital", "low", 0.8, "Published email addresses use a different corporate domain"),
  MALWARE_OR_PHISHING_LISTED: neg("digital", "critical", 1, "Website listed for malware / phishing / unwanted software", { overallFloor: 81 })
} as const satisfies Record<string, SignalRule>;

export type SignalCode = keyof typeof SIGNAL_RULES;

// ---------------------------------------------------------------------------------------------
// 4. Missing-data policy (explicit): absence of information lowers CONFIDENCE and DATA COVERAGE.
//    It raises the risk score ONLY in these documented cases, where the absence is itself a
//    legitimate risk signal because it CONTRADICTS a claim made in the request:
// ---------------------------------------------------------------------------------------------

export const MISSING_DATA_RISK_RULES: readonly { code: SignalCode; rule: string }[] = [
  { code: "IDENTITY_NOT_FOUND_IN_REGISTRY", rule: "The authoritative registry for the stated country was checked successfully and holds no matching company, while other evidence shows the business exists (otherwise ENTITY_NOT_FOUND is returned)." },
  { code: "REGISTRATION_NUMBER_NOT_FOUND", rule: "A registration number was supplied and the authoritative registry answered that it does not exist." },
  { code: "WEBSITE_UNREACHABLE", rule: "A website was supplied and does not respond successfully." },
  { code: "DOMAIN_NOT_REGISTERED", rule: "A website/domain was supplied and the domain registry (RDAP) has no record of it." },
  { code: "NO_CONTACT_INFORMATION", rule: "A reachable website was supplied but publishes no contact information at all." }
];
export const MISSING_DATA_POLICY = "Absence of information is not treated as evidence of risk: categories without evidence get no score (null), dataCoverage 'none' and lower confidence. The only exceptions are listed in missingDataRiskRules — each is a case where the absence contradicts something the request claimed. LIMITED_FINANCIAL_HISTORY is informational (weight 0) and never changes the score.";

// ---------------------------------------------------------------------------------------------
// 5. Entity-resolution gates
// ---------------------------------------------------------------------------------------------

export const RESOLUTION = {
  /** Below this entity-match confidence the recommendation is at least manual_review. */
  manualReviewBelow: 0.35,
  /** Below this the recommendation is at least enhanced_due_diligence. */
  enhancedDueDiligenceBelow: 0.6,
  /** Confidence cap when identity could not be verified against any registry. */
  unverifiedConfidenceCap: 0.55
} as const;

// ---------------------------------------------------------------------------------------------
// 6. Time thresholds, freshness and staleness
// ---------------------------------------------------------------------------------------------

export const AGE_THRESHOLDS = {
  veryRecentIncorporationDays: 90,
  recentIncorporationDays: 365,
  establishedBusinessYears: 5,
  shellIndicatorMaxAgeDays: 730,
  newDomainDays: 90,
  recentDomainDays: 365,
  establishedDomainYears: 5,
  domainExpirySoonDays: 30,
  repeatedNameChanges: 2
} as const;

/** Evidence weight halves every N days of age (publication date). Registry records, list entries
 *  and RDAP data describe the CURRENT state as of retrieval and are not decayed. */
export const FRESHNESS_HALF_LIFE_DAYS: Readonly<Record<"news" | "regulatory" | "review" | "forum", number>> = {
  news: 540, regulatory: 1095, review: 365, forum: 180
};
/** Older than this, an item is flagged `stale: true` in the output (still shown, weighted by decay). */
export const STALE_AFTER_DAYS: Readonly<Record<"news" | "regulatory" | "review" | "forum", number>> = {
  news: 1095, regulatory: 1825, review: 730, forum: 365
};

// ---------------------------------------------------------------------------------------------
// 7. Confidence model (sum of weights = 1.00) and coverage values
// ---------------------------------------------------------------------------------------------

export const CONFIDENCE_WEIGHTS = {
  entityResolution: 0.30,
  categoryCoverage: 0.25,
  sourceQuality: 0.15,
  authoritativeRecords: 0.10,
  freshness: 0.10,
  consistency: 0.10
} as const;
export const COVERAGE_VALUE: Readonly<Record<CoverageLevel, number>> = { high: 1, medium: 0.66, low: 0.33, none: 0 };
/** Each detected contradiction (identity conflict, address mismatch, redirect, stale data) removes
 *  this much from the consistency component (floor 0). */
export const CONTRADICTION_PENALTY = 0.25;

// ---------------------------------------------------------------------------------------------
// 8. Recommendation rules (machine guidance, never a safety guarantee)
// ---------------------------------------------------------------------------------------------

export const RECOMMENDATION = {
  minConfidenceForAutomation: 0.4,
  proceedMaxScore: 20,
  proceedMinConfidence: 0.7,
  monitoringMaxScore: 40,
  monitoringMinConfidence: 0.6,
  enhancedDueDiligenceMaxScore: 60
} as const;

// ---------------------------------------------------------------------------------------------
// 9. Jurisdiction list and runtime settings
// ---------------------------------------------------------------------------------------------

/** FATF "High-Risk Jurisdictions subject to a Call for Action" (the "black list"). Static data with
 *  an explicit as-of date — override with BUSINESS_RISK_HIGH_RISK_JURISDICTIONS (comma-separated
 *  ISO-2 codes) when FATF updates it. The grey list changes too often to hard-code. */
export const FATF_CALL_FOR_ACTION = { asOf: "2025-06", codes: ["KP", "IR", "MM"] } as const;

export function getHighRiskJurisdictions(env: NodeJS.ProcessEnv = process.env): { codes: ReadonlySet<string>; source: string } {
  const raw = env.BUSINESS_RISK_HIGH_RISK_JURISDICTIONS?.trim();
  if (!raw) return { codes: new Set(FATF_CALL_FOR_ACTION.codes), source: `FATF call-for-action list as of ${FATF_CALL_FOR_ACTION.asOf}` };
  const codes = raw.split(",").map(s => s.trim().toUpperCase()).filter(s => /^[A-Z]{2}$/.test(s));
  return { codes: new Set(codes), source: "operator-configured (BUSINESS_RISK_HIGH_RISK_JURISDICTIONS)" };
}

/** Operator kill-switch for individual providers or roles, e.g. "news,regulatory,threat_google_safe_browsing". */
export function getBusinessRiskDisabledProviders(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.BUSINESS_RISK_DISABLED_PROVIDERS ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
}

/** Assessment audit store: Postgres when BUSINESS_RISK_DATABASE_URL (fallback DATABASE_URL) is set,
 *  else in-process memory. BUSINESS_RISK_ASSESSMENT_STORE=memory forces memory; =off disables it. */
export function getBusinessRiskAssessmentStoreMode(env: NodeJS.ProcessEnv = process.env): { mode: "postgres"; url: string } | { mode: "memory" } | { mode: "off" } {
  const forced = (env.BUSINESS_RISK_ASSESSMENT_STORE ?? "").trim().toLowerCase();
  if (forced === "off") return { mode: "off" };
  if (forced === "memory") return { mode: "memory" };
  const url = env.BUSINESS_RISK_DATABASE_URL?.trim() || env.DATABASE_URL?.trim();
  return url ? { mode: "postgres", url } : { mode: "memory" };
}

export function getGoogleSafeBrowsingApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.GOOGLE_SAFE_BROWSING_API_KEY?.trim() || null;
}

/** Per-call limits (unit economics at $0.50/call). */
export const LIMITS = {
  maxAliases: 5,
  maxSanctionsNames: 6,
  maxEvidenceInOutput: 50,
  maxAdverseItemsInOutput: 15,
  maxCandidatesInError: 5,
  regulatoryResults: 8,
  providerTimeoutMs: 12_000,
  maxProviderAttempts: 2
} as const;

/** Estimated upstream cost of one web search (internal telemetry only). */
export const ESTIMATED_COST_PER_SEARCH_USD = 0.008;

function round4(n: number): number { return Math.round(n * 10000) / 10000; }
