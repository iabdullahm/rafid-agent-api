import type { CompanyRecord } from "../sources/companyRepository.js";
import { daysSince, type CompanySourceType, type ConfidenceLabel } from "../types.js";
import { sourceAuthority } from "./sourceTrust.js";

/**
 * Section 6: data confidence. No model or LLM ever invents this — a fixed, deterministic
 * combination of measurable evidence (which source types contributed, how many, how fresh, how
 * complete the resulting record is) computed the same way every time for the same inputs.
 */

/** Section 6's four confidence labels, applied at the source-type level — the one place this
 *  mapping is defined, reused by both the profile digitalPresence/sources view and the
 *  analyze/due-diligence confidence engine below.
 *
 *  Phase 9: derived from the continuous sourceAuthority() score (src/business-data/scoring/
 *  sourceTrust.ts) rather than a binary AUTHORITATIVE_SOURCE_TYPES.includes() check, so a new
 *  source type's label follows automatically from its trust weight — the same threshold banding
 *  scoring/verification.ts's rowVerificationStatus uses for the richer VerificationStatus. */
export function labelForSourceType(sourceType: CompanySourceType): ConfidenceLabel {
  if (sourceType === "demo") return "unknown"; // never presented as real evidence — Section 15
  const authority = sourceAuthority(sourceType);
  if (authority >= 0.90) return "verified";
  if (authority >= 0.60) return "reported";
  if (authority >= 0.30) return "estimated";
  return "inferred";
}

const WEIGHTS = { authority: 0.40, sourceCount: 0.20, completeness: 0.25, freshness: 0.15 } as const;
/** A row this many days old or older earns zero on the freshness factor. */
const MAX_FRESHNESS_DAYS = 540;
/** This many independently contributing sources earns full marks on the source-count factor. */
const TARGET_SOURCE_COUNT = 3;

export interface CompanyConfidenceResult {
  score: number;
  reasons: string[];
}

/**
 * Company-level confidence for analyze_oman_company / due_diligence_oman_company. `rows` are
 * every contributing source row for the company (see CompanyRepository.findByCompanyId /
 * CompanyDataProvider.getByCompanyId); `dataCompletenessScore` is 0-100, from
 * scoring/signals.ts's computeCommercialSignals (never recomputed here — one implementation of
 * "how complete is this record").
 */
export function computeCompanyConfidence(rows: readonly CompanyRecord[], dataCompletenessScore: number, hasIdentityConflict: boolean): CompanyConfidenceResult {
  const reasons: string[] = [];
  if (rows.length === 0) return { score: 0, reasons: ["No source records were found for this company."] };

  // Phase 9: the authority factor is the single MOST authoritative contributing source's continuous
  // sourceAuthority() score, not a binary "has an authoritative source or not" split — so a record
  // backed only by, say, a licensed feed (0.75) is scored more precisely than one backed only by a
  // directory listing (0.50), even though neither counts as "authoritative" in the strict sense.
  const authorityScore = Math.max(...rows.map(r => sourceAuthority(r.sourceType)));
  const hasAuthoritative = authorityScore >= 0.90;
  reasons.push(hasAuthoritative
    ? "At least one government, tax-authority or government-procurement source contributed to this record."
    : rows.every(r => r.sourceType === "demo")
      ? "This record is backed only by the curated demo dataset — not a real registry, website or directory source."
      : "No government, tax-authority or government-procurement source contributed; company-provided, licensed-feed or directory sources only.");

  const distinctSources = new Set(rows.map(r => `${r.sourceType}::${r.sourceName}`)).size;
  const sourceCountScore = Math.min(1, distinctSources / TARGET_SOURCE_COUNT);
  reasons.push(`${distinctSources} distinct source(s) contributed to this record (target is ${TARGET_SOURCE_COUNT}+ for full confidence on this factor).`);

  const completenessScore = Math.max(0, Math.min(1, dataCompletenessScore / 100));
  reasons.push(`Data completeness is ${Math.round(dataCompletenessScore)}%.`);

  const mostRecentObservedAt = rows.reduce((latest, r) => (r.observedAt > latest ? r.observedAt : latest), rows[0]!.observedAt);
  const ageDays = daysSince(mostRecentObservedAt);
  const freshnessScore = Math.max(0, 1 - ageDays / MAX_FRESHNESS_DAYS);
  reasons.push(`Most recent contributing source is ${ageDays} day(s) old.`);

  if (hasIdentityConflict) reasons.push("Sources disagree on this company's identity details (see riskFlags); confidence was reduced accordingly.");

  let score = authorityScore * WEIGHTS.authority + sourceCountScore * WEIGHTS.sourceCount
    + completenessScore * WEIGHTS.completeness + freshnessScore * WEIGHTS.freshness;
  if (hasIdentityConflict) score *= 0.8;
  if (rows.every(r => r.sourceType === "demo")) score *= 0.6;
  score = Math.max(0, Math.min(1, Math.round(score * 100) / 100));

  return { score, reasons };
}
