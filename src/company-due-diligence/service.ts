import { previewBusinessRiskScore, runBusinessRiskScore } from "../business-risk/service.js";
import { runCompanyReputationCheck } from "../company-reputation/service.js";
import type { CompanyReputationCheckOutput } from "../schemas/companyReputationOutputs.js";
import type { BusinessRiskScoreOutput } from "../schemas/businessRiskOutputs.js";
import { companyDueDiligenceInput, type CompanyDueDiligenceInput } from "../schemas/companyDueDiligenceInputs.js";
import type { CompanyDueDiligenceOutput } from "../schemas/companyDueDiligenceOutputs.js";
import type { CapabilityPreviewBody } from "../preview/types.js";

const asRiskLevel = (score: number | null): CompanyDueDiligenceOutput["riskLevel"] =>
  score === null ? null : score <= 24 ? "low" : score <= 49 ? "moderate" : score <= 74 ? "high" : "critical";

function businessInput(input: CompanyDueDiligenceInput) {
  return { companyName: input.company, ...(input.domain ? { website: input.domain } : {}), ...(input.country ? { country: input.country } : {}), ...(input.registrationNumber ? { registrationNumber: input.registrationNumber } : {}), ...(input.lei ? { lei: input.lei } : {}), includeNews: input.checks.adverseMedia !== false, includeDigitalSignals: input.depth !== "quick" };
}

function reputationInput(input: CompanyDueDiligenceInput) {
  return { companyName: input.company, ...(input.domain ? { domain: input.domain } : {}), ...(input.country ? { country: input.country } : {}), ...(input.registrationNumber ? { registrationNumber: input.registrationNumber } : {}), ...(input.lei ? { lei: input.lei } : {}) };
}

function failed(error: unknown) { return { success: false, error: { code: error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "PROVIDER_UNAVAILABLE", message: error instanceof Error ? error.message : "Provider unavailable" } }; }
function success(data: unknown) { return { success: true, data }; }

function statusForProvider(status: string): "complete" | "partial" | "unavailable" | "not_checked" {
  if (status === "ok" || status === "stale_cache") return status === "ok" ? "complete" : "partial";
  if (status === "not_configured" || status === "not_applicable") return "not_checked";
  return "unavailable";
}

function transform(input: CompanyDueDiligenceInput, result: BusinessRiskScoreOutput, reputation: CompanyReputationCheckOutput | null, reputationFailure: ReturnType<typeof failed> | null): CompanyDueDiligenceOutput {
  const b = result.business;
  const materialFlags = result.riskFlags.filter(f => f.severity === "high" || f.severity === "critical");
  // business_risk_score's high_confidence_match is deliberately still a potential name match
  // (its own contract requires source verification), so do not upgrade it to confirmed_match.
  const sanctionsStatus = result.sanctionsScreening.status === "no_match_found" ? "clear" : result.sanctionsScreening.status === "high_confidence_match" || result.sanctionsScreening.status === "possible_match" || result.sanctionsScreening.status === "partial" ? "potential_match" : result.sanctionsScreening.status;
  const newsEvidence = result.evidence.filter(e => e.type === "news" || e.type === "regulatory_publication");
  const newsIds = new Set(materialFlags.flatMap(f => f.evidenceIds));
  const materialNews = newsEvidence.filter(e => newsIds.has(e.id));
  const component = (key: keyof typeof result.components) => result.components[key];
  const recommendation: CompanyDueDiligenceOutput["recommendation"] = result.status === "insufficient_data" ? "insufficient_data" : result.recommendation.action === "proceed" ? "proceed_with_standard_checks" : result.sanctionsScreening.status === "high_confidence_match" ? "reject_counterparty" : result.recommendation.action === "proceed_with_monitoring" || result.recommendation.action === "enhanced_due_diligence" ? "enhanced_due_diligence_required" : result.recommendation.action === "manual_review" ? "manual_review_required" : "reject_counterparty";
  const identityMismatch = materialFlags.some(f => f.code.includes("IDENTITY") || f.code.includes("CORPORATE"));
  const decision: CompanyDueDiligenceOutput["decision"] = result.status === "insufficient_data"
    ? { action: "insufficient_data", requiresHumanReview: false }
    : result.sanctionsScreening.status === "high_confidence_match" ? { action: "reject_due_to_sanctions", requiresHumanReview: true }
    : sanctionsStatus === "potential_match" ? { action: "manual_review_required", requiresHumanReview: true }
    : identityMismatch ? { action: "reject_due_to_identity_mismatch", requiresHumanReview: true }
    : result.recommendation.action === "avoid_automated_transaction" ? { action: "reject_due_to_material_risk", requiresHumanReview: true }
    : result.recommendation.action === "manual_review" ? { action: "manual_review_required", requiresHumanReview: true }
    : recommendation === "enhanced_due_diligence_required" ? { action: "continue_with_enhanced_checks", requiresHumanReview: false }
    : { action: "continue_onboarding", requiresHumanReview: false };
  const websiteEvidence = result.evidence.filter(e => e.type === "company_website" || e.type === "domain_registration");
  const websiteMismatch = materialFlags.some(f => f.category === "digital" && /mismatch|identity/i.test(`${f.code} ${f.title}`));
  const coverageForRole = (role: string): "complete" | "partial" | "unavailable" | "not_checked" => {
    const statuses = result.providers.filter(p => p.role === role).map(p => statusForProvider(p.status));
    if (statuses.includes("complete")) return statuses.includes("unavailable") || statuses.includes("partial") ? "partial" : "complete";
    if (statuses.includes("partial")) return "partial";
    if (statuses.includes("unavailable")) return "unavailable";
    return "not_checked";
  };
  const coverage = { registration: coverageForRole("corporate"), website: websiteEvidence.length ? "complete" : coverageForRole("digital"), sanctions: coverageForRole("sanctions"), negativeNews: coverageForRole("news"), financial: result.dataCoverage.financial === "none" ? "unavailable" : result.dataCoverage.financial === "high" ? "complete" : "partial" } as CompanyDueDiligenceOutput["coverage"];
  const reputationRisk = component("reputationRisk");
  return {
    success: true,
    company: { name: b.name, domain: b.domain, country: b.country, registrationNumber: b.registrationNumber },
    purpose: input.purpose, depth: input.depth, checks: input.checks,
    entityResolution: { status: b.resolutionStatus === "resolved" ? "resolved" : b.resolutionStatus === "probable" ? "resolved" : "unresolved", confidence: b.entityMatchConfidence, matchedIdentifiers: b.matchedOn, candidateCount: b.matchedOn.length ? 1 : 0 },
    registrationCheck: success({ status: b.registrationStatus, legalName: b.legalName, registrationNumber: b.registrationNumber, jurisdiction: b.country, incorporationDate: b.incorporationDate, source: b.registry }),
    sanctionsCheck: success(result.sanctionsScreening),
    adverseMediaCheck: success({ articlesChecked: newsEvidence.length, negativeArticles: materialNews.length, materialFindings: materialNews, riskScore: materialNews.length ? Math.min(100, materialNews.length * 20) : 0, riskLevel: materialNews.length ? "medium" : "low", confidence: result.confidence }),
    reputationCheck: reputation ? success(reputation) : reputationFailure ?? { success: false, error: { code: "NOT_CHECKED", message: "Reputation check disabled by request." } },
    businessRiskCheck: success(result),
    entityMatch: { status: b.resolutionStatus === "resolved" ? "matched" : b.resolutionStatus === "probable" ? "probable" : "unverified", confidence: b.entityMatchConfidence, matchedOn: b.matchedOn },
    registration: { status: b.registrationStatus, incorporatedAt: b.incorporationDate, source: b.registry },
    websiteSignals: { domainAgeYears: null, ssl: websiteEvidence.some(e => /\bHTTPS\b/i.test(e.claim)) ? true : websiteEvidence.some(e => /\bHTTP\b/i.test(e.claim)) ? false : null, businessIdentityMatch: websiteEvidence.length ? !websiteMismatch : null, confidence: websiteEvidence.length ? 0.75 : 0 },
    management: [],
    sanctions: { status: sanctionsStatus, matches: result.sanctionsScreening.matches, listsChecked: result.sanctionsScreening.listsChecked, listsUnavailable: result.sanctionsScreening.listsUnavailable },
    legalSignals: result.riskFlags.filter(f => f.category === "compliance" || f.category === "corporate"),
    negativeNews: { materialCount: materialNews.length, items: materialNews },
    financialSignals: { status: result.dataCoverage.financial === "none" ? "unavailable" : result.dataCoverage.financial === "high" ? "available" : "limited_data", signals: result.riskFlags.filter(f => f.category === "financial") },
    reputation: { score: reputationRisk === null ? null : Math.max(0, Math.min(100, 100 - reputationRisk)), risk: asRiskLevel(reputationRisk) },
    riskScore: result.riskScore,
    riskLevel: asRiskLevel(result.riskScore),
    confidence: result.confidence,
    riskBreakdown: { identity: b.entityMatchConfidence === 0 ? null : Math.round((1 - b.entityMatchConfidence) * 100), registration: component("corporateRisk"), sanctions: result.sanctionsScreening.status === "high_confidence_match" ? 100 : sanctionsStatus === "potential_match" ? 50 : sanctionsStatus === "clear" ? 0 : null, legal: component("complianceRisk"), negativeNews: materialNews.length ? Math.min(100, materialNews.length * 20) : result.dataCoverage.reputation === "none" ? null : 0, financial: component("financialRisk"), reputation: reputationRisk },
    redFlags: result.riskFlags,
    recommendation, reasonCodes: result.recommendation.reasonCodes, sources: result.evidence.map(e => ({ type: e.type, provider: e.sourceName, url: e.sourceUrl, retrievedAt: e.retrievedAt, status: "success" })),
    decision,
    evidence: result.evidence,
    coverage,
    providers: result.providers,
    // A no-provider result has no observation timestamp. Keep its serialized result stable so
    // retries and MCP idempotency comparisons do not differ only because of wall-clock time.
    generatedAt: result.evaluatedAt ?? "1970-01-01T00:00:00.000Z"
  };
}

export async function runCompanyDueDiligence(rawInput: unknown): Promise<CompanyDueDiligenceOutput> {
  const input = companyDueDiligenceInput.parse(rawInput);
  const [businessResult, reputationResult] = await Promise.allSettled([
    runBusinessRiskScore(businessInput(input)),
    input.checks.reputation ? runCompanyReputationCheck(reputationInput(input)) : Promise.resolve(null)
  ]);
  if (businessResult.status === "rejected") throw businessResult.reason;
  return transform(input, businessResult.value, reputationResult.status === "fulfilled" && reputationResult.value ? reputationResult.value : null, reputationResult.status === "rejected" ? failed(reputationResult.reason) : null);
}

export async function previewCompanyDueDiligence(rawInput: unknown): Promise<CapabilityPreviewBody> {
  const input = companyDueDiligenceInput.parse(rawInput);
  const preview = await previewBusinessRiskScore(businessInput(input));
  return { ...preview, capability: "company_due_diligence", preview: { ...preview.preview, entity: input.company, entityType: "company", availableSections: ["entityMatch", "registration", "websiteSignals", "sanctions", "negativeNews", "financialSignals", "reputation", "riskScore", "recommendation", "decision", "evidence"], signals: { ...preview.preview.signals, purpose: input.purpose } } };
}
