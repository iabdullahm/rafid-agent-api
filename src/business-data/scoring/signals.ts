import type { MergedCompanyFields } from "../matching/merge.js";
import { yearsSince } from "../types.js";

/**
 * Section 8: deterministic commercial-intelligence signals. Every figure here is a fixed formula
 * over the merged company record — never an LLM estimate. Fields that ARE genuinely estimated
 * (never observed directly, only inferred from what little is on file) are documented as such in
 * this module's comments rather than labeled with false precision.
 */

/** Fixed list of fields this MVP considers "important" for a business-intelligence profile —
 *  dataCompletenessScore is the percentage of these that are populated. Deliberately excludes
 *  purely descriptive fields (nameAr/nameEn, area, activities) that many legitimately-complete
 *  records won't have. */
const IMPORTANT_FIELDS: readonly (keyof MergedCompanyFields)[] = [
  "registrationNumber", "legalType", "status", "registrationDate", "industry",
  "governorate", "wilayat", "address", "website", "email", "phone", "vatNumber", "employeeRange"
];

export interface CommercialSignals {
  yearsActive: number;
  operatingStatus: string;
  digitalPresenceScore: number;
  dataCompletenessScore: number;
  businessMaturity: "new" | "early_stage" | "growing" | "established";
  /** Phase 17: a deterministic summary of the company's Tender Board/Esnad procurement footprint —
   *  "active" when at least one award/contract is on file, "limited" when it has participated in
   *  tenders without (yet) an award, "none" when neither is on file. Never inferred from anything
   *  other than the procurement snapshot fields a government_procurement source actually reported. */
  governmentProcurementActivity: "active" | "limited" | "none";
}

/** Phase 17: the governmentProcurementActivity classification, from the MERGED SNAPSHOT FIELDS
 *  only (never the individually-fetched award list — this function never sees it). Used as-is by
 *  analyze_oman_company's commercialSignals (which doesn't fetch award records, to stay a cheaper,
 *  lighter capability than due_diligence_oman_company); due_diligence_oman_company overrides this
 *  with an awards-aware classification in src/services/omanBusiness.ts once it has actually fetched
 *  the award list, so it can correctly report "active" even when no supplier-snapshot source ever
 *  set awardedContractCount explicitly but a real award record exists. */
export function procurementActivityFromCompany(company: MergedCompanyFields): CommercialSignals["governmentProcurementActivity"] {
  if ((company.awardedContractCount ?? 0) > 0) return "active";
  if ((company.tendersParticipated ?? 0) > 0 || company.governmentProcurementPresence) return "limited";
  return "none";
}

export function computeDataCompletenessScore(company: MergedCompanyFields): number {
  const populated = IMPORTANT_FIELDS.filter(f => {
    const v = company[f];
    return v !== null && v !== undefined && v !== "";
  }).length;
  return Math.round((populated / IMPORTANT_FIELDS.length) * 100);
}

/** website 50 / email 25 / phone 25 — a simple, documented, additive score. Never inflated by
 *  social-media presence in this MVP (no verified social-profile ingestion pipeline yet — see
 *  src/business-data/sources/provider.ts's LicensedFeedCompanyProvider for where that would
 *  plug in). */
export function computeDigitalPresenceScore(company: MergedCompanyFields): number {
  let score = 0;
  if (company.website) score += 50;
  if (company.email) score += 25;
  if (company.phone) score += 25;
  return score;
}

export function businessMaturityFromYears(yearsActive: number): CommercialSignals["businessMaturity"] {
  if (yearsActive >= 6) return "established";
  if (yearsActive >= 3) return "growing";
  if (yearsActive >= 1) return "early_stage";
  return "new";
}

export function digitalFootprintLabel(digitalPresenceScore: number): "strong" | "moderate" | "weak" | "none" {
  if (digitalPresenceScore >= 70) return "strong";
  if (digitalPresenceScore >= 40) return "moderate";
  if (digitalPresenceScore > 0) return "weak";
  return "none";
}

export function coverageLabel(dataCompletenessScore: number): "high" | "medium" | "low" {
  if (dataCompletenessScore >= 70) return "high";
  if (dataCompletenessScore >= 40) return "medium";
  return "low";
}

export function computeCommercialSignals(company: MergedCompanyFields): CommercialSignals {
  // registrationDate unknown => yearsActive reports 0 (never fabricated) — the caller surfaces
  // "registrationDate" via missingInformation/recommendedChecks so an agent knows this is an
  // absence, not a genuine brand-new company, when status also isn't "active".
  const yearsActive = company.registrationDate ? yearsSince(company.registrationDate) : 0;
  const dataCompletenessScore = computeDataCompletenessScore(company);
  const digitalPresenceScore = computeDigitalPresenceScore(company);
  return {
    yearsActive,
    operatingStatus: company.status ?? "unknown",
    digitalPresenceScore,
    dataCompletenessScore,
    businessMaturity: businessMaturityFromYears(yearsActive),
    governmentProcurementActivity: procurementActivityFromCompany(company)
  };
}
