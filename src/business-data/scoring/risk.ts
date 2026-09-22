import type { MergedCompanyFields } from "../matching/merge.js";
import type { CompanyRecord } from "../sources/companyRepository.js";
import { daysSince, type CompanyRiskFlag } from "../types.js";
import { getBusinessStaleDataDays, getRecentRegistrationMonths } from "../config.js";
import { computeDataCompletenessScore } from "./signals.js";

/**
 * Section 7: a deterministic risk engine. No model or LLM ever generates a risk score — a fixed,
 * documented weight table applied to measurable facts about the merged company record, capped to
 * 0-100. Weights marked as matching the task's own example are used verbatim; every other weight
 * is this implementation's own reasonable, documented extension covering an indicator the task
 * listed without assigning it a number (Section 7: "Example weighting" — illustrative, not
 * exhaustive).
 *
 * Never claims fraud, criminal activity, insolvency, sanctions or illegal conduct — every message
 * below describes an observable data fact ("status is inactive", "sources disagree"), not a legal
 * conclusion.
 */

export interface RiskWeight { code: string; weight: number; severity: CompanyRiskFlag["severity"] }

export const RISK_WEIGHTS = {
  INACTIVE_COMPANY: { code: "INACTIVE_COMPANY", weight: 50, severity: "high" },
  SUSPENDED_COMPANY: { code: "SUSPENDED_COMPANY", weight: 35, severity: "high" },
  IDENTITY_CONFLICT: { code: "IDENTITY_CONFLICT", weight: 25, severity: "high" },
  CONFLICTING_ADDRESSES: { code: "CONFLICTING_ADDRESSES", weight: 15, severity: "medium" },
  RECENT_REGISTRATION: { code: "RECENT_REGISTRATION", weight: 10, severity: "medium" },
  STALE_SOURCE_DATA: { code: "STALE_SOURCE_DATA", weight: 10, severity: "medium" },
  MISSING_REGISTRATION_NUMBER: { code: "MISSING_REGISTRATION_NUMBER", weight: 10, severity: "medium" },
  MISSING_REGISTRATION_DATE: { code: "MISSING_REGISTRATION_DATE", weight: 5, severity: "low" },
  LIMITED_OPERATING_HISTORY: { code: "LIMITED_OPERATING_HISTORY", weight: 5, severity: "low" },
  MISSING_LEGAL_STATUS: { code: "MISSING_LEGAL_STATUS", weight: 5, severity: "low" },
  NO_WEBSITE: { code: "NO_WEBSITE", weight: 5, severity: "low" },
  NO_PUBLIC_CONTACT_INFO: { code: "NO_PUBLIC_CONTACT_INFO", weight: 5, severity: "low" },
  LIMITED_PUBLIC_INFORMATION: { code: "LIMITED_PUBLIC_INFORMATION", weight: 5, severity: "low" },
  UNKNOWN_OPERATING_STATUS: { code: "UNKNOWN_OPERATING_STATUS", weight: 5, severity: "low" },
  // Phase 18: a real Tax Oman verification outcome, not an absence — only fires when a
  // tax_authority-sourced row explicitly reported "not_registered" (see taxOmanProvider.ts),
  // never merely because no tax_authority source has contributed yet (that stays unflagged,
  // same as any other not-yet-verified fact — an honest gap, not a risk signal).
  TAX_NOT_REGISTERED: { code: "TAX_NOT_REGISTERED", weight: 20, severity: "high" }
} as const satisfies Record<string, RiskWeight>;

export interface RiskAssessmentResult {
  riskScore: number;
  riskLevel: "low" | "medium" | "high";
  riskFlags: CompanyRiskFlag[];
}

/**
 * Computes riskFlags (each code added at most once — the weight table above is keyed by code, so
 * summing `riskFlags.map(f => weight of f.code)` can never double-count a single indicator) and
 * the capped 0-100 riskScore/riskLevel derived from them.
 */
export function assessCompanyRisk(
  company: MergedCompanyFields,
  rows: readonly CompanyRecord[],
  identityConflict: boolean,
  addressConflict: boolean
): RiskAssessmentResult {
  const flags: CompanyRiskFlag[] = [];
  const add = (w: RiskWeight, message: string) => flags.push({ code: w.code, severity: w.severity, message });

  if (company.status === "inactive") add(RISK_WEIGHTS.INACTIVE_COMPANY, "The company's recorded status is inactive.");
  else if (company.status === "suspended") add(RISK_WEIGHTS.SUSPENDED_COMPANY, "The company's recorded status is suspended.");
  else if (!company.status || company.status === "unknown") add(RISK_WEIGHTS.UNKNOWN_OPERATING_STATUS, "No reliable operating status is on file for this company.");

  if (identityConflict) add(RISK_WEIGHTS.IDENTITY_CONFLICT, "Contributing sources report different company names for the same registration/identity.");
  if (addressConflict) add(RISK_WEIGHTS.CONFLICTING_ADDRESSES, "Contributing sources report different registered addresses.");

  if (company.registrationDate) {
    const ageMonths = daysSince(company.registrationDate) / 30.44;
    const recentMonths = getRecentRegistrationMonths();
    if (ageMonths < recentMonths) add(RISK_WEIGHTS.RECENT_REGISTRATION, `Company was registered ${Math.max(0, Math.round(ageMonths))} month(s) ago, under this deployment's ${recentMonths}-month recent-registration threshold.`);
    else if (ageMonths < 24) add(RISK_WEIGHTS.LIMITED_OPERATING_HISTORY, "Company has under two years of recorded operating history.");
  } else {
    add(RISK_WEIGHTS.MISSING_REGISTRATION_DATE, "No registration date is on file; operating history cannot be assessed.");
  }

  if (company.taxVerificationStatus === "not_registered") add(RISK_WEIGHTS.TAX_NOT_REGISTERED, "Tax Oman reports this company as not registered for tax purposes.");

  if (!company.registrationNumber) add(RISK_WEIGHTS.MISSING_REGISTRATION_NUMBER, "No registration number is on file for this company.");
  if (!company.legalType) add(RISK_WEIGHTS.MISSING_LEGAL_STATUS, "No legal type/status is on file for this company.");
  if (!company.website) add(RISK_WEIGHTS.NO_WEBSITE, "No website is on file for this company.");
  if (!company.email && !company.phone) add(RISK_WEIGHTS.NO_PUBLIC_CONTACT_INFO, "No public contact information (email or phone) is on file.");

  const dataCompletenessScore = computeDataCompletenessScore(company);
  if (dataCompletenessScore < 50) add(RISK_WEIGHTS.LIMITED_PUBLIC_INFORMATION, "Limited public company information is available.");

  const mostRecentObservedAt = rows.length ? rows.reduce((latest, r) => (r.observedAt > latest ? r.observedAt : latest), rows[0]!.observedAt) : null;
  const staleDays = getBusinessStaleDataDays();
  if (mostRecentObservedAt && daysSince(mostRecentObservedAt) > staleDays) {
    add(RISK_WEIGHTS.STALE_SOURCE_DATA, `The most recent contributing source is over ${staleDays} days old.`);
  }

  const weightByCode = new Map<string, number>(Object.values(RISK_WEIGHTS).map(w => [w.code, w.weight]));
  const riskScore = Math.max(0, Math.min(100, flags.reduce((sum, f) => sum + (weightByCode.get(f.code) ?? 0), 0)));
  const riskLevel: RiskAssessmentResult["riskLevel"] = riskScore >= 60 ? "high" : riskScore >= 25 ? "medium" : "low";
  return { riskScore, riskLevel, riskFlags: flags };
}
