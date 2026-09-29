import type { BillingStatus, Mode, CompanyInput, ItemResult, SafeError } from "./types.js";

export function mapResult(mode: Mode, company: CompanyInput, result: unknown, billing: BillingStatus): ItemResult {
  const value = result as Record<string, unknown>;
  return {
    success: true, mode, company, billing,
    companyName: company.name ?? null, domain: company.domain ?? null, country: company.country ?? null,
    reputationScore: typeof value.reputationScore === "number" ? value.reputationScore : null,
    riskScore: typeof value.riskScore === "number" ? value.riskScore : null,
    riskLevel: typeof value.riskLevel === "string" ? value.riskLevel : null,
    confidence: typeof value.confidence === "number" ? value.confidence : typeof value.confidenceScore === "number" ? value.confidenceScore : null,
    result, generatedAt: new Date().toISOString()
  };
}

export function mapFailure(mode: Mode, company: CompanyInput, error: SafeError, billing: BillingStatus): ItemResult {
  const { resolution, ...publicError } = error;
  return {
    success: false, mode, company,
    companyName: company.name ?? null, domain: company.domain ?? null, country: company.country ?? null,
    reputationScore: null, riskScore: null, riskLevel: null, confidence: null,
    result: null, generatedAt: new Date().toISOString(), error: publicError,
    ...(resolution ? { resolution, resolutionStatus: resolution.status, candidateCount: resolution.candidateCount } : {}),
    billing
  };
}
