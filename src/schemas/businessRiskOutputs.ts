import { z } from "zod";
import {
  COVERAGE_LEVELS, EVIDENCE_CLASSES, EVIDENCE_SOURCE_TYPES, RELIABILITY_LEVELS, RISK_ACTIONS, RISK_CATEGORIES, RISK_LEVELS, RISK_SEVERITIES
} from "../business-risk/types.js";

/**
 * business_risk_score output — deterministic, structured, strict. Every field is present in every
 * response (null where not applicable), so an autonomous agent never has to probe for keys.
 * status "assessed": a scored assessment. status "insufficient_data": no evidence source could be
 * checked in this deployment (riskScore/riskLevel/components are null, never guessed).
 * Ambiguous or non-existent entities and provider outages are NOT results — they are structured
 * errors (AMBIGUOUS_ENTITY 409, ENTITY_NOT_FOUND 404, PROVIDER_UNAVAILABLE 503, PROVIDER_TIMEOUT 504,
 * RATE_LIMITED 429) for which no paid settlement happens.
 */

const unit = z.number().min(0).max(1);
const score = z.number().int().min(0).max(100);
const category = z.enum(RISK_CATEGORIES);
const coverage = z.enum(COVERAGE_LEVELS);
const perCategory = <T extends z.ZodType>(t: T) => z.strictObject({ corporate: t, financial: t, compliance: t, reputation: t, operational: t, digital: t });

const riskFlag = z.strictObject({
  code: z.string(),
  category,
  severity: z.enum(RISK_SEVERITIES),
  title: z.string(),
  description: z.string(),
  evidenceIds: z.array(z.string()),
  weight: z.number().min(0),
  confidence: unit,
  scoreImpactPoints: z.number().min(0).describe("SEVERITY_POINTS[severity] × weight × confidence — this flag's contribution to its category's negative points."),
  factStatus: z.enum(["established", "reported", "alleged", "observed"]).nullable().describe("What the source establishes: observed (a record/check), reported (an outcome reported by a source), alleged (allegation, investigation, lawsuit, unconfirmed match)."),
  requiresVerification: z.boolean()
});

const positiveSignal = z.strictObject({
  code: z.string(),
  category,
  title: z.string(),
  description: z.string(),
  evidenceIds: z.array(z.string()),
  weight: z.number().min(0),
  confidence: unit,
  mitigationPoints: z.number().min(0)
});

const evidence = z.strictObject({
  id: z.string(),
  recordType: z.enum(["source_record", "lookup_result"]).describe("source_record: something a source returned. lookup_result: the documented outcome of a successful check that found nothing (so clean findings are traceable too)."),
  type: z.enum(EVIDENCE_SOURCE_TYPES),
  evidenceClass: z.enum(EVIDENCE_CLASSES),
  sourceName: z.string(),
  sourceUrl: z.string().nullable(),
  sourceRecordId: z.string().nullable(),
  publishedAt: z.string().nullable(),
  observedAt: z.string(),
  retrievedAt: z.string(),
  ageDays: z.number().int().nullable(),
  stale: z.boolean(),
  freshness: unit,
  claim: z.string(),
  reliability: z.enum(RELIABILITY_LEVELS),
  relevance: unit,
  fromCache: z.boolean()
});

const sanctionsMatch = z.strictObject({
  listedName: z.string(),
  matchedAlias: z.string().nullable(),
  list: z.string(),
  listType: z.enum(["sanctions", "export_control_or_debarment"]),
  reference: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  matchScore: unit,
  matchType: z.enum(["exact_normalized_name", "fuzzy_name"]),
  matchStrength: z.enum(["possible", "high"]).describe("possible: name similarity only — NOT a confirmed listing. high: exact normalized name corroborated by a list identifier/country with nothing contradicting it — still verify at the source list."),
  corroboratingIdentifiers: z.array(z.string()),
  contradictions: z.array(z.string()),
  evidenceId: z.string()
});

export const businessRiskScoreOutput = z.strictObject({
  status: z.enum(["assessed", "insufficient_data"]),
  assessmentId: z.string().describe("Deterministic id of (company identity, scoring model version, evidence snapshot)."),
  business: z.strictObject({
    name: z.string(),
    legalName: z.string().nullable(),
    country: z.string().nullable(),
    countryName: z.string().nullable(),
    registrationNumber: z.string().nullable(),
    lei: z.string().nullable(),
    registrationStatus: z.enum(["active", "inactive", "dissolved", "liquidation", "unknown", "not_verified"]),
    incorporationDate: z.string().nullable(),
    registry: z.string().nullable(),
    website: z.string().nullable(),
    domain: z.string().nullable(),
    city: z.string().nullable(),
    industry: z.string().nullable(),
    entityMatchConfidence: unit,
    resolutionStatus: z.enum(["resolved", "probable", "unverified"]),
    identityVerifiedAgainstRegistry: z.boolean(),
    matchedOn: z.array(z.string())
  }),
  riskScore: score.nullable().describe("0 = lowest detected risk, 100 = highest. null only when status is insufficient_data."),
  riskLevel: z.enum(RISK_LEVELS).nullable(),
  confidence: unit.describe("0–1: how strongly the evidence supports the result. Separate from risk: a low score with low confidence means little evidence, not a safe company."),
  components: z.strictObject({
    corporateRisk: score.nullable(), financialRisk: score.nullable(), complianceRisk: score.nullable(),
    reputationRisk: score.nullable(), operationalRisk: score.nullable(), digitalRisk: score.nullable()
  }).describe("Per-category risk scores (0–100). null = no data coverage for that category (never guessed)."),
  scoreBreakdown: z.strictObject({
    corporateContribution: z.number().nullable(), financialContribution: z.number().nullable(), complianceContribution: z.number().nullable(),
    reputationContribution: z.number().nullable(), operationalContribution: z.number().nullable(), digitalContribution: z.number().nullable(),
    rawWeightedScore: z.number().nullable(),
    effectiveWeights: perCategory(z.number()),
    floorsApplied: z.array(z.strictObject({ code: z.string(), minimumScore: score, reason: z.string() }))
  }),
  riskFlags: z.array(riskFlag),
  positiveSignals: z.array(positiveSignal),
  sanctionsScreening: z.strictObject({
    status: z.enum(["no_match_found", "possible_match", "high_confidence_match", "not_checked", "unavailable", "partial"]),
    listsChecked: z.array(z.string()),
    listsUnavailable: z.array(z.string()),
    namesScreened: z.array(z.string()),
    matches: z.array(sanctionsMatch)
  }),
  evidence: z.array(evidence),
  recommendation: z.strictObject({
    action: z.enum(RISK_ACTIONS),
    reasonCodes: z.array(z.string()),
    rationale: z.string()
  }),
  dataCoverage: perCategory(coverage),
  confidenceBreakdown: z.strictObject({
    entityResolution: unit, categoryCoverage: unit, sourceQuality: unit, authoritativeRecords: unit, freshness: unit, consistency: unit,
    contradictions: z.array(z.string()),
    capsApplied: z.array(z.string())
  }),
  providers: z.array(z.strictObject({
    provider: z.string(),
    role: z.enum(["corporate", "financial", "sanctions", "news", "regulatory", "digital"]),
    stage: z.union([z.literal(1), z.literal(2)]),
    status: z.enum(["ok", "not_configured", "not_applicable", "unavailable", "timeout", "rate_limited", "stale_cache"]),
    fromCache: z.boolean(),
    retrievedAt: z.string().nullable(),
    evidenceCount: z.number().int().min(0),
    reason: z.string().nullable()
  })),
  warnings: z.array(z.strictObject({ code: z.string(), message: z.string(), provider: z.string().nullable() })),
  assumptions: z.array(z.string()),
  limitations: z.array(z.string()),
  methodology: z.strictObject({
    scoringModelVersion: z.string(),
    categoryWeights: perCategory(z.number()),
    weightsSource: z.enum(["default", "env", "default_env_invalid"]),
    severityPoints: z.strictObject({ info: z.number(), low: z.number(), medium: z.number(), high: z.number(), critical: z.number() }),
    riskLevelBands: z.array(z.strictObject({ level: z.enum(RISK_LEVELS), min: score, max: score })),
    missingDataPolicy: z.string(),
    missingDataRiskRules: z.array(z.strictObject({ code: z.string(), rule: z.string() })),
    highRiskJurisdictionsSource: z.string(),
    formula: z.string()
  }),
  evaluatedAt: z.string().nullable().describe("As-of time of the evidence snapshot the assessment was computed from (latest retrieval time among the providers used; cached evidence keeps its original retrieval time). Re-evaluating the same snapshot yields the same result. null when nothing could be checked.")
});

export type BusinessRiskScoreOutput = z.infer<typeof businessRiskScoreOutput>;
