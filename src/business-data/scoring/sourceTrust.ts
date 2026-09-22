import type { CompanySourceType } from "../types.js";

/**
 * Phase 2: the single, centralized source-authority model. Every place that needs to know "how
 * much should this source be trusted" — confidence scoring, risk scoring, field-evidence
 * precedence, search-ranking's representative-row choice — imports `sourceAuthority()` from here.
 * Nothing else in this codebase hardcodes a trust number; if a weight needs to change, it changes
 * once, here.
 *
 * Trust is keyed by `CompanySourceType`, not by an ad-hoc string, so it can never silently drift
 * out of sync with the sourceType enum itself (see src/business-data/types.ts). The literal
 * category names the task used (government_registry, tax_authority, government_procurement,
 * official_company_website, licensed_feed, public_directory, other_public_source, demo) map onto
 * this project's existing sourceType values one-to-one — no parallel category system was
 * introduced:
 *
 *   government_registry      → "government", "public_registry"   (MOCIIP / any company registry)
 *   tax_authority             → "tax_authority"                    (Tax Oman)
 *   government_procurement    → "government_procurement"           (Tender Board / Esnad)
 *   official_company_website → "company_website"
 *   licensed_feed              → "licensed_feed"
 *   public_directory           → "directory"
 *   other_public_source        → "news", "other"
 *   demo                       → "demo"
 */
export const SOURCE_TRUST: Readonly<Record<CompanySourceType, number>> = {
  government: 1.00,
  public_registry: 1.00,
  tax_authority: 1.00,
  government_procurement: 0.95,
  company_website: 0.80,
  licensed_feed: 0.75,
  directory: 0.50,
  news: 0.40,
  other: 0.40,
  demo: 0.10,
  // Admin dashboard (Section 20/21): below every real source, including "other" — a fact an
  // operator typed in by hand carries less evidentiary weight than even a low-trust public
  // source, and must never be able to make a company look government-verified.
  admin_manual: 0.20
};

/** The authority score (0-1) for a given sourceType — the one function every scoring module
 *  should call rather than re-deriving trust from sourceType itself. */
export function sourceAuthority(sourceType: CompanySourceType): number {
  return SOURCE_TRUST[sourceType];
}

/** Source types trusted enough to establish identity/status on their own (authority >= 0.90) —
 *  government registries, the tax authority, and government procurement — computed from
 *  SOURCE_TRUST above rather than hand-listed, so it can never drift from the numbers. Note
 *  types.ts's own `AUTHORITATIVE_SOURCE_TYPES` predates this module and is hand-maintained (kept
 *  for the code written before this module existed); it was updated alongside this file to
 *  include "tax_authority" and "government_procurement" so the two lists agree in practice, but
 *  new code should prefer this one, since it is the one guaranteed to track SOURCE_TRUST. */
export const HIGH_TRUST_SOURCE_TYPES: readonly CompanySourceType[] =
  (Object.keys(SOURCE_TRUST) as CompanySourceType[]).filter(t => SOURCE_TRUST[t] >= 0.90);
