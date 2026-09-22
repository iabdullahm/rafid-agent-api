import { daysSince, type CompanySourceType, type VerificationStatus } from "../types.js";
import { sourceAuthority } from "./sourceTrust.js";
import { isStale } from "../config/freshnessPolicy.js";

/**
 * Phase 3: deterministically derives a single row's verificationStatus from its sourceType and
 * freshness — never stored as a frozen judgment, always recomputed at read time so a row that was
 * "verified" a year ago correctly shows "stale" today without needing a background job to update
 * it. "conflicting" is applied separately by the caller (mergeCompanyRows knows about
 * cross-source disagreement; a single row in isolation cannot), so this function only ever returns
 * one of verified/reported/estimated/inferred/stale/unknown.
 */
export function rowVerificationStatus(sourceType: CompanySourceType, observedAt: string): VerificationStatus {
  if (sourceType === "demo") return "unknown"; // never presented as real evidence — Section 15
  const ageDays = daysSince(observedAt);
  if (isStale(sourceType, ageDays)) return "stale";
  const authority = sourceAuthority(sourceType);
  if (authority >= 0.90) return "verified";
  if (authority >= 0.60) return "reported";
  if (authority >= 0.30) return "estimated";
  return "inferred";
}

/** The merged, company-level verificationStatus a caller sees on `get_oman_company_profile` /
 *  `due_diligence_oman_company` — "conflicting" outranks everything (an unresolved disagreement is
 *  the most important thing to surface), then the best individual contributing row's status wins
 *  (one authoritative, fresh source is enough to call the record "verified" even if an older or
 *  weaker source also contributed). */
export function mergedVerificationStatus(rowStatuses: readonly VerificationStatus[], hasConflict: boolean): VerificationStatus {
  if (hasConflict) return "conflicting";
  if (rowStatuses.length === 0) return "unknown";
  const rank: Record<VerificationStatus, number> = { verified: 6, reported: 5, estimated: 4, inferred: 3, stale: 2, conflicting: 1, unknown: 0 };
  return rowStatuses.reduce((best, s) => (rank[s] > rank[best] ? s : best), rowStatuses[0]!);
}
