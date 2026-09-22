/**
 * Admin & Data Operations Dashboard (Section 5): configurable dataset-progress targets — the
 * dashboard home page shows a simple progress bar for each of these against the live counts
 * adminService.ts computes. Centralized here (never hardcoded deep inside a page component) so a
 * deployment can raise/lower a target without touching any rendering code; every value is
 * overridable via env, falling back to the spec's own initial suggested targets.
 */
export interface DatasetTargets {
  /** Total companies backed by at least one real (non-demo) source. */
  realCompanies: number;
  /** Companies with an authoritative, non-conflicting identity (identityVerified). */
  identityVerified: number;
  /** Companies with a Tax Oman-verified outcome on file (verified or not_registered). */
  taxVerified: number;
  /** Companies registered as a Tender Board/Esnad supplier. */
  tenderBoardSuppliers: number;
  /** Companies with at least one award/contract or tender participation on file. */
  withProcurementHistory: number;
}

const DEFAULTS: DatasetTargets = {
  realCompanies: 5000,
  identityVerified: 1000,
  taxVerified: 500,
  tenderBoardSuppliers: 300,
  withProcurementHistory: 100
};

function envOverride(key: string): number | null {
  const raw = process.env[key];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** Reads every target fresh from process.env each call (never cached at module load) so a test
 *  can override OMAN_BUSINESS_TARGET_* between runs and see it take effect immediately — mirrors
 *  every other env-driven config function in this codebase (e.g. business-data/config.ts). */
export function getDatasetTargets(): DatasetTargets {
  return {
    realCompanies: envOverride("OMAN_BUSINESS_TARGET_REAL_COMPANIES") ?? DEFAULTS.realCompanies,
    identityVerified: envOverride("OMAN_BUSINESS_TARGET_IDENTITY_VERIFIED") ?? DEFAULTS.identityVerified,
    taxVerified: envOverride("OMAN_BUSINESS_TARGET_TAX_VERIFIED") ?? DEFAULTS.taxVerified,
    tenderBoardSuppliers: envOverride("OMAN_BUSINESS_TARGET_TENDER_BOARD_SUPPLIERS") ?? DEFAULTS.tenderBoardSuppliers,
    withProcurementHistory: envOverride("OMAN_BUSINESS_TARGET_WITH_PROCUREMENT_HISTORY") ?? DEFAULTS.withProcurementHistory
  };
}
