import type { MergedCompanyFields } from "../matching/merge.js";
import type { CompanyRecord } from "../sources/companyRepository.js";
import type { CompanyRiskFlag, DueDiligenceTransactionType, ImportanceLevel } from "../types.js";
import { AUTHORITATIVE_SOURCE_TYPES } from "../types.js";
import type { CommercialSignals } from "./signals.js";

/**
 * Section 8/21: deterministic, table-driven recommendation logic — never an LLM suggestion. Every
 * item is triggered by a fixed rule over the merged company record, its risk flags, or the
 * caller's stated purpose/transaction type.
 */

const BASELINE_CHECKS = [
  "Request commercial registration copy",
  "Verify VAT registration",
  "Request recent financial statements"
] as const;

export function buildPositiveSignals(company: MergedCompanyFields, rows: readonly CompanyRecord[], signals: CommercialSignals): string[] {
  const positives: string[] = [];
  if (company.status === "active") positives.push("Active company status");
  if (company.website) positives.push("Established website");
  if (signals.yearsActive >= 3) positives.push(`Several years of operating history (${signals.yearsActive}+ years)`);
  if (rows.some(r => AUTHORITATIVE_SOURCE_TYPES.includes(r.sourceType))) positives.push("Identity verified via a government or public-registry source");
  if (company.vatNumber) positives.push("Registered VAT number on file");
  if (signals.dataCompletenessScore >= 70) positives.push("Comprehensive public information available");
  if (company.email && company.phone) positives.push("Multiple public contact channels on file");
  if (company.taxVerificationStatus === "verified") positives.push("Tax registration verified with Tax Oman");
  if ((company.awardedContractCount ?? 0) > 0) positives.push("Has been awarded government procurement contracts on record");
  else if (company.registeredSupplier) positives.push("Registered government supplier");
  return positives;
}

export function buildRecommendedChecks(riskFlags: readonly CompanyRiskFlag[]): string[] {
  const checks: string[] = [...BASELINE_CHECKS];
  const codes = new Set(riskFlags.map(f => f.code));
  if (codes.has("NO_WEBSITE") || codes.has("NO_PUBLIC_CONTACT_INFO")) checks.push("Verify physical business address and contact details");
  if (codes.has("IDENTITY_CONFLICT") || codes.has("CONFLICTING_ADDRESSES")) checks.push("Resolve conflicting company identity/address details across sources before proceeding");
  if (codes.has("INACTIVE_COMPANY") || codes.has("SUSPENDED_COMPANY") || codes.has("UNKNOWN_OPERATING_STATUS")) checks.push("Confirm current operating status directly with the company or registry");
  if (codes.has("MISSING_REGISTRATION_NUMBER")) checks.push("Obtain the company's official registration number before proceeding");
  if (codes.has("TAX_NOT_REGISTERED")) checks.push("Confirm tax registration status directly with Tax Oman before proceeding");
  return checks;
}

interface DueDiligenceItem { check: string; importance: ImportanceLevel }

const TRANSACTION_SPECIFIC_CHECKS: Record<DueDiligenceTransactionType, DueDiligenceItem[]> = {
  supplier_contract: [
    { check: "Request trade references from existing customers", importance: "medium" },
    { check: "Verify production/service capacity against contract volume", importance: "medium" }
  ],
  partnership: [
    { check: "Review ownership and governance structure", importance: "high" },
    { check: "Confirm signatory authority of the company's representative", importance: "high" }
  ],
  investment: [
    { check: "Request audited or management accounts", importance: "high" },
    { check: "Review capitalization table and existing ownership structure", importance: "high" }
  ],
  customer_credit: [
    { check: "Assess creditworthiness and request recent financial statements", importance: "high" },
    { check: "Check for outstanding payment disputes or credit history where available", importance: "medium" }
  ],
  other: []
};

export function buildDueDiligenceChecklist(riskFlags: readonly CompanyRiskFlag[], transactionType: DueDiligenceTransactionType): DueDiligenceItem[] {
  const items: DueDiligenceItem[] = [
    { check: "Verify commercial registration", importance: "high" },
    { check: "Verify VAT registration", importance: "medium" },
    { check: "Request audited or management accounts", importance: "high" },
    ...TRANSACTION_SPECIFIC_CHECKS[transactionType]
  ];
  const codes = new Set(riskFlags.map(f => f.code));
  if (codes.has("IDENTITY_CONFLICT") || codes.has("CONFLICTING_ADDRESSES")) items.push({ check: "Resolve conflicting identity/address details across sources before proceeding", importance: "high" });
  if (codes.has("INACTIVE_COMPANY") || codes.has("SUSPENDED_COMPANY")) items.push({ check: "Confirm current operating status directly with the registry before proceeding", importance: "high" });
  if (codes.has("NO_WEBSITE") || codes.has("NO_PUBLIC_CONTACT_INFO")) items.push({ check: "Independently verify the company's physical address and contact details", importance: "medium" });
  if (codes.has("TAX_NOT_REGISTERED")) items.push({ check: "Confirm current tax registration status directly with Tax Oman before proceeding", importance: "high" });
  return items;
}

/** Fixed list of fields whose absence is worth calling out explicitly in
 *  due_diligence_oman_company's `missingInformation`. */
const DUE_DILIGENCE_FIELDS: readonly (keyof MergedCompanyFields)[] = [
  "registrationNumber", "legalType", "registrationDate", "industry", "address", "website", "email", "phone", "vatNumber", "employeeRange"
];

export function buildMissingInformation(company: MergedCompanyFields): string[] {
  return DUE_DILIGENCE_FIELDS.filter(f => {
    const v = company[f];
    return v === null || v === undefined || v === "";
  });
}
