import { z } from "zod";

const unit = z.number().min(0).max(1);
const riskScore = z.number().int().min(0).max(100).nullable();
const riskLevel = z.enum(["low", "moderate", "high", "critical"]).nullable();
const subcheck = z.strictObject({ success: z.boolean(), data: z.unknown().optional(), error: z.unknown().optional() });

export const companyDueDiligenceOutput = z.strictObject({
  success: z.literal(true),
  company: z.strictObject({ name: z.string(), domain: z.string().nullable(), country: z.string().nullable(), registrationNumber: z.string().nullable() }),
  purpose: z.string(),
  depth: z.enum(["quick", "standard", "enhanced"]),
  checks: z.record(z.string(), z.boolean()),
  entityResolution: z.strictObject({ status: z.enum(["resolved", "ambiguous", "unresolved"]), confidence: unit, matchedIdentifiers: z.array(z.string()), candidateCount: z.number().int().min(0) }),
  registrationCheck: subcheck,
  sanctionsCheck: subcheck,
  adverseMediaCheck: subcheck,
  reputationCheck: subcheck,
  businessRiskCheck: subcheck,
  entityMatch: z.strictObject({ status: z.enum(["matched", "probable", "unverified"]), confidence: unit, matchedOn: z.array(z.string()) }),
  registration: z.strictObject({ status: z.enum(["active", "inactive", "dissolved", "liquidation", "unknown", "not_verified"]), incorporatedAt: z.string().nullable(), source: z.string().nullable() }),
  websiteSignals: z.strictObject({ domainAgeYears: z.number().min(0).nullable(), ssl: z.boolean().nullable(), businessIdentityMatch: z.boolean().nullable(), confidence: unit }),
  management: z.array(z.unknown()),
  sanctions: z.strictObject({ status: z.enum(["clear", "potential_match", "confirmed_match", "not_checked", "unavailable"]), matches: z.array(z.unknown()), listsChecked: z.array(z.string()), listsUnavailable: z.array(z.string()) }),
  legalSignals: z.array(z.unknown()),
  negativeNews: z.strictObject({ materialCount: z.number().int().min(0), items: z.array(z.unknown()) }),
  financialSignals: z.strictObject({ status: z.enum(["available", "limited_data", "unavailable"]), signals: z.array(z.unknown()) }),
  reputation: z.strictObject({ score: riskScore, risk: riskLevel }),
  riskScore,
  riskLevel,
  confidence: unit,
  riskBreakdown: z.strictObject({ identity: riskScore, registration: riskScore, sanctions: riskScore, legal: riskScore, negativeNews: riskScore, financial: riskScore, reputation: riskScore }),
  redFlags: z.array(z.unknown()),
  recommendation: z.enum(["proceed", "proceed_with_standard_checks", "manual_review_required", "enhanced_due_diligence_required", "reject_counterparty", "insufficient_data"]),
  reasonCodes: z.array(z.string()),
  sources: z.array(z.unknown()),
  decision: z.strictObject({ action: z.enum(["continue_onboarding", "continue_with_enhanced_checks", "request_additional_documents", "manual_review_required", "reject_due_to_sanctions", "reject_due_to_identity_mismatch", "reject_due_to_material_risk", "insufficient_data"]), requiresHumanReview: z.boolean() }),
  evidence: z.array(z.unknown()),
  coverage: z.record(z.string(), z.enum(["complete", "partial", "unavailable", "not_checked"])),
  providers: z.array(z.unknown()),
  generatedAt: z.string()
});

export type CompanyDueDiligenceOutput = z.infer<typeof companyDueDiligenceOutput>;
