import { z } from "zod";
import { ADVERSE_CATEGORIES, DIMENSIONS, EVIDENCE_TYPES, LEGAL_STAGES, SIGNAL_SEVERITIES, WARNING_CODES } from "../company-reputation/types.js";
import { RESOLUTION_STATUSES } from "../company-reputation/companyResolver.js";

/** company_reputation_check output — evidence-first, machine-consumable. Every signal cites the
 *  evidence ids it was derived from; every evidence item carries its source, authority, retrieval
 *  time and relevance. */

const score = z.number().int().min(0).max(100);
const dimension = z.enum(DIMENSIONS);

export const reputationSignal = z.strictObject({
  code: z.string(),
  dimension,
  polarity: z.enum(["positive", "negative", "neutral"]),
  severity: z.enum(SIGNAL_SEVERITIES),
  message: z.string(),
  evidenceIds: z.array(z.string()),
  sourceAuthority: z.enum(["official_or_regulatory", "major_news_or_authoritative", "business_database_or_other_publisher", "forum_social_or_user_generated"]).nullable(),
  strength: z.number().min(0).max(1)
});

const evidenceItem = z.strictObject({
  id: z.string(),
  type: z.enum(EVIDENCE_TYPES),
  sourceName: z.string(),
  sourceUrl: z.string().nullable(),
  sourceRecordId: z.string().nullable(),
  sourceAuthority: z.enum(["official_or_regulatory", "major_news_or_authoritative", "business_database_or_other_publisher", "forum_social_or_user_generated"]),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  publishedAt: z.string().nullable(),
  observedAt: z.string(),
  jurisdiction: z.string().nullable(),
  companyIdentifiers: z.strictObject({
    name: z.string().nullable(), registrationNumber: z.string().nullable(), lei: z.string().nullable(),
    domain: z.string().nullable(), country: z.string().nullable()
  }),
  quality: z.number().min(0).max(1),
  relevance: z.number().min(0).max(1),
  fromCache: z.boolean()
});

const candidate = z.strictObject({
  legalName: z.string(), country: z.string().nullable(), city: z.string().nullable(), registrationNumber: z.string().nullable(),
  lei: z.string().nullable(), status: z.string(), registry: z.string(), matchScore: z.number().min(0).max(1), matchedOn: z.array(z.string()), conflicts: z.array(z.string()),
  evidenceId: z.string()
});

export const companyReputationCheckOutput = z.strictObject({
  company: z.strictObject({
    requestedName: z.string(),
    resolvedName: z.string().nullable(),
    country: z.string().nullable().describe("ISO 3166-1 alpha-2"),
    countryName: z.string().nullable(),
    website: z.string().nullable(),
    domain: z.string().nullable(),
    registrationNumber: z.string().nullable(),
    lei: z.string().nullable(),
    city: z.string().nullable(),
    industry: z.string().nullable()
  }),
  resolution: z.strictObject({
    status: z.enum(RESOLUTION_STATUSES),
    confidence: score,
    methods: z.array(z.string()),
    conflicts: z.array(z.string()),
    candidates: z.array(candidate)
  }),
  reputationScore: score,
  confidenceScore: score,
  trustLevel: z.enum(["insufficient_evidence", "significant_concerns", "some_concerns", "no_major_concerns_found", "favorable_public_signals"]),
  scores: z.strictObject(Object.fromEntries(DIMENSIONS.map(d => [d, score])) as Record<(typeof DIMENSIONS)[number], typeof score>),
  scoreBreakdown: z.array(z.strictObject({
    dimension, weight: z.number(), score, rawScore: score, coverage: score, positiveSignals: z.number().int(), negativeSignals: z.number().int()
  })),
  confidenceBreakdown: z.strictObject({
    resolution: z.number(), dimensionCoverage: z.number(), independentSources: z.number(), authority: z.number(),
    freshness: z.number(), diversity: z.number(), jurisdictionCoverage: z.number(), capsApplied: z.array(z.string())
  }),
  identity: z.strictObject({
    status: z.enum(["consistent", "partially_consistent", "ambiguous", "unresolved", "conflicting", "not_checked"]),
    signals: z.array(reputationSignal)
  }),
  sanctions: z.strictObject({
    status: z.enum(["no_match_found", "possible_match", "high_confidence_match", "not_checked", "unavailable", "partial"]),
    listsChecked: z.array(z.string()),
    listsUnavailable: z.array(z.string()),
    matches: z.array(z.strictObject({
      listedName: z.string(), matchedAlias: z.string().nullable(), list: z.string(), reference: z.string().nullable(), sourceUrl: z.string().nullable(),
      matchScore: z.number(), matchType: z.enum(["exact_normalized_name", "fuzzy_name"]), confidence: z.enum(["possible", "high"]),
      corroboratingIdentifiers: z.array(z.string()), contradictions: z.array(z.string()), evidenceId: z.string(), reason: z.string()
    })),
    highestConfidence: z.enum(["possible", "high"]).nullable()
  }),
  adverseMedia: z.strictObject({
    status: z.enum(["none_found", "items_found", "not_checked", "unavailable"]),
    items: z.array(z.strictObject({
      eventId: z.string(), title: z.string().nullable(), category: z.enum(ADVERSE_CATEGORIES), categories: z.array(z.enum(ADVERSE_CATEGORIES)),
      legalStage: z.enum(LEGAL_STAGES), stageDescription: z.string(), established: z.boolean(), severity: z.enum(SIGNAL_SEVERITIES), dimension,
      publishedAt: z.string().nullable(), coverageCount: z.number().int(), relevance: z.number(),
      sources: z.array(z.strictObject({ sourceName: z.string(), url: z.string().nullable(), authority: z.string() })),
      evidenceIds: z.array(z.string())
    })),
    neutralMentions: z.number().int(),
    victimOrReporterMentions: z.number().int(),
    excludedPossibleOtherEntity: z.number().int(),
    duplicatesMerged: z.number().int()
  }),
  customerSentiment: z.strictObject({
    status: z.enum(["not_checked", "unavailable", "insufficient_data", "mostly_positive", "mixed", "mostly_negative"]),
    aggregateRatings: z.array(z.strictObject({ platform: z.string(), rating: z.number(), scale: z.literal(5), reviewCount: z.number().nullable(), url: z.string().nullable(), evidenceId: z.string() })),
    positiveSignals: z.array(reputationSignal),
    negativeSignals: z.array(reputationSignal)
  }),
  onlinePresence: z.strictObject({
    status: z.enum(["not_checked", "established", "limited", "inconsistent", "unreachable"]),
    signals: z.array(reputationSignal)
  }),
  legalRiskSignals: z.array(reputationSignal),
  businessStabilitySignals: z.array(reputationSignal),
  cyberDomainSignals: z.array(reputationSignal),
  transparencySignals: z.array(reputationSignal),
  positiveSignals: z.array(reputationSignal),
  redFlags: z.array(reputationSignal),
  evidenceSummary: z.strictObject({
    totalEvidence: z.number().int(),
    independentSources: z.number().int(),
    highConfidenceSources: z.number().int(),
    freshestEvidenceAt: z.string().nullable(),
    oldestEvidenceAt: z.string().nullable(),
    duplicatesMerged: z.number().int(),
    excludedPossibleOtherEntity: z.number().int(),
    servedFromCache: z.number().int(),
    staleEvidence: z.number().int(),
    evidenceTruncated: z.boolean()
  }),
  evidence: z.array(evidenceItem),
  coverage: z.strictObject({
    providers: z.array(z.strictObject({
      provider: z.string(), category: z.enum(["registry", "sanctions", "news", "reviews", "website", "domain"]),
      status: z.enum(["ok", "not_configured", "not_applicable", "unavailable", "timeout", "rate_limited", "stale_cache"]),
      fromCache: z.boolean(), fetchedAt: z.string().nullable(), evidenceCount: z.number().int(), reason: z.string().nullable()
    })),
    dimensionsWithEvidence: z.array(dimension),
    jurisdictionRegistryChecked: z.boolean()
  }),
  warnings: z.array(z.strictObject({ code: z.enum(WARNING_CODES), message: z.string(), provider: z.string().nullable() })),
  limitations: z.array(z.string()),
  summary: z.string(),
  methodology: z.strictObject({
    scoringModelVersion: z.string(),
    weights: z.record(z.string(), z.number()),
    neutralPrior: z.number(),
    note: z.string()
  })
});

export type CompanyReputationCheckOutput = z.infer<typeof companyReputationCheckOutput>;
export type ReputationSignalOut = z.infer<typeof reputationSignal>;
