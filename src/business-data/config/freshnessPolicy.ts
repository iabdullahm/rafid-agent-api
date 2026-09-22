import type { CompanySourceType } from "../types.js";

/**
 * Phase 10: explicit, source-specific freshness policy — how many days old a contributing
 * source's data can be before it's considered stale, per source type. Centralized here (never
 * hardcoded per-call-site) so tuning one threshold changes behavior everywhere it matters:
 * confidence scoring's freshness component, risk scoring's STALE_SOURCE_DATA/registry-specific
 * staleness flags, and a row's derived `verificationStatus` ("stale" once past this threshold).
 *
 * Defaults mirror the task's own suggested starting points; overridable per-deployment via env
 * vars (never required — sensible defaults apply when unset), the same convention
 * src/business-data/config.ts already uses for OMAN_BUSINESS_RECENT_REGISTRATION_MONTHS etc.
 */
const DEFAULT_FRESHNESS_DAYS: Readonly<Record<CompanySourceType, number>> = {
  government: 30,
  public_registry: 30,
  tax_authority: 30,
  government_procurement: 7,
  company_website: 90,
  licensed_feed: 30,
  directory: 180,
  news: 180,
  other: 180,
  // Demo data's freshness is irrelevant to its trustworthiness — see sourceTrust.ts's 0.10
  // authority score, which already caps confidence regardless of how "fresh" a demo row looks.
  demo: 3650,
  // Admin-entered evidence has no external source to "re-sync" against, so it is never flagged
  // stale purely by age — sourceTrust.ts's 0.20 authority already keeps its influence low.
  admin_manual: 3650
};

function envOverrideDays(sourceType: CompanySourceType): number | null {
  const key = `OMAN_BUSINESS_FRESHNESS_DAYS_${sourceType.toUpperCase()}`;
  const raw = process.env[key];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** How many days old a row of this sourceType can be before it's considered stale. Configurable
 *  per source type via OMAN_BUSINESS_FRESHNESS_DAYS_<SOURCETYPE> (e.g.
 *  OMAN_BUSINESS_FRESHNESS_DAYS_GOVERNMENT_PROCUREMENT=14); falls back to the documented default. */
export function freshnessThresholdDays(sourceType: CompanySourceType): number {
  return envOverrideDays(sourceType) ?? DEFAULT_FRESHNESS_DAYS[sourceType];
}

/** Whether a row observed `ageDays` ago, from `sourceType`, should be treated as stale. */
export function isStale(sourceType: CompanySourceType, ageDays: number): boolean {
  return ageDays > freshnessThresholdDays(sourceType);
}
