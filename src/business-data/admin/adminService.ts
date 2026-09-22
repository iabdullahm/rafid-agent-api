import type { CompanyAwardRecord, CompanyRiskFlag, CompanySourceType, CompanyStatus, VerificationStatus, AdminRowFlag } from "../types.js";
import { daysSince, AUTHORITATIVE_SOURCE_TYPES } from "../types.js";
import type { CompanyRecord, CompanyRepository, SyncRunRecord } from "../sources/companyRepository.js";
import { mergeCompanyRows, type MergeResult } from "../matching/merge.js";
import { computeCommercialSignals, type CommercialSignals } from "../scoring/signals.js";
import { assessCompanyRisk, type RiskAssessmentResult } from "../scoring/risk.js";
import { computeCompanyConfidence } from "../scoring/confidence.js";
import { isStale } from "../config/freshnessPolicy.js";
import { getDatasetTargets, type DatasetTargets } from "../config/datasetTargets.js";

/**
 * Admin & Data Operations Dashboard — the read model every admin page/API route is built from.
 *
 * This is deliberately NOT a new ingestion engine or a second scoring implementation: every
 * number here comes from re-running the exact same deterministic merge/scoring functions the
 * paid search/profile/analyze/due-diligence capabilities already use (mergeCompanyRows,
 * computeCommercialSignals, assessCompanyRisk, computeCompanyConfidence — see
 * src/services/omanBusiness.ts for the equivalent per-company usage). "Recalculate Intelligence"
 * (Section 22) is therefore structurally trivial: nothing here is ever cached or persisted, so
 * recalculating IS simply calling buildCompanyViews again against current evidence — it can never
 * go stale itself, and it never re-fetches an external site.
 *
 * Built for this MVP's target dataset scale (thousands of rows — see datasetTargets.ts): every
 * function below groups a full in-memory scan (CompanyRepository.adminListAllRows/
 * adminListAllAwards) rather than issuing N+1 queries. A future scale-up would replace the full
 * scan with materialized aggregates/pagination pushed into the database without changing any
 * calling code's shape.
 */

export interface CompanyAdminView {
  companyId: string;
  companyName: string;
  registrationNumber: string | null;
  legalType: string | null;
  status: CompanyStatus | null;
  registrationDate: string | null;
  governorate: string | null;
  wilayat: string | null;
  industry: string | null;
  website: string | null;
  vatNumber: string | null;
  verificationStatus: VerificationStatus;
  identityVerified: boolean;
  confidence: number;
  taxVerificationStatus: string | null;
  registeredSupplier: boolean | null;
  tendersParticipated: number | null;
  awardCount: number;
  knownAwardValueOMR: number;
  lastVerifiedAt: string | null;
  latestObservedAt: string | null;
  freshness: "fresh" | "stale" | "unknown";
  sourceCount: number;
  distinctSourceTypes: readonly CompanySourceType[];
  isReal: boolean;
  isDemoOnly: boolean;
  hasIdentityConflict: boolean;
  hasAddressConflict: boolean;
  hasConflict: boolean;
  adminFlags: readonly AdminRowFlag[];
  riskLevel: RiskAssessmentResult["riskLevel"];
  riskScore: number;
  riskFlags: readonly CompanyRiskFlag[];
  dataCompletenessScore: number;
  rows: readonly CompanyRecord[];
  activeRows: readonly CompanyRecord[];
  merge: MergeResult;
  awards: readonly CompanyAwardRecord[];
  signals: CommercialSignals;
}

function rowFreshness(row: CompanyRecord): "fresh" | "stale" {
  return isStale(row.sourceType, daysSince(row.observedAt)) ? "stale" : "fresh";
}

/** Groups every stored row/award by companyId and computes one CompanyAdminView per company —
 *  the single seam every admin page/route builds its data from, so the company list, the
 *  dashboard's counts and one company's detail page can never disagree with each other. Rows
 *  flagged `adminFlag: "rejected"` (Conflict Review Queue's "flag source record as incorrect",
 *  Section 14) are excluded from the merge/scoring computation but kept in `rows`/`allRows` so the
 *  detail page can still show them, clearly marked, for auditability. */
export function buildCompanyViews(allRows: readonly CompanyRecord[], allAwards: readonly CompanyAwardRecord[]): CompanyAdminView[] {
  const byCompany = new Map<string, CompanyRecord[]>();
  for (const row of allRows) {
    const list = byCompany.get(row.companyId);
    if (list) list.push(row); else byCompany.set(row.companyId, [row]);
  }
  const awardsByCompany = new Map<string, CompanyAwardRecord[]>();
  for (const award of allAwards) {
    const list = awardsByCompany.get(award.companyId);
    if (list) list.push(award); else awardsByCompany.set(award.companyId, [award]);
  }

  const views: CompanyAdminView[] = [];
  for (const [companyId, rows] of byCompany) {
    const activeRows = rows.filter(r => r.adminFlag !== "rejected");
    const merge = mergeCompanyRows(companyId, activeRows);
    const awards = awardsByCompany.get(companyId) ?? [];
    const signals = computeCommercialSignals(merge.company);
    const risk = assessCompanyRisk(merge.company, activeRows, merge.identityConflict, merge.addressConflict);
    const confidence = computeCompanyConfidence(activeRows, signals.dataCompletenessScore, merge.identityConflict);
    const identityVerified = activeRows.some(r => AUTHORITATIVE_SOURCE_TYPES.includes(r.sourceType)) && !merge.identityConflict;
    const latestVerifiedAt = rows.reduce<string | null>((latest, r) => (r.lastVerifiedAt && (!latest || r.lastVerifiedAt > latest) ? r.lastVerifiedAt : latest), null);
    const latestObservedAt = rows.reduce<string | null>((latest, r) => (!latest || r.observedAt > latest ? r.observedAt : latest), null);
    const anyFresh = activeRows.some(r => rowFreshness(r) === "fresh");
    const anyStale = activeRows.some(r => rowFreshness(r) === "stale");
    const freshness: CompanyAdminView["freshness"] = activeRows.length === 0 ? "unknown" : anyFresh ? "fresh" : anyStale ? "stale" : "unknown";
    const distinctSourceTypes = [...new Set(rows.map(r => r.sourceType))];
    const distinctSourceKeys = new Set(rows.map(r => `${r.sourceType}::${r.sourceName}`));
    const isReal = rows.some(r => r.sourceType !== "demo");
    const isDemoOnly = rows.length > 0 && rows.every(r => r.sourceType === "demo");
    const adminFlags = [...new Set(rows.map(r => r.adminFlag).filter((f): f is AdminRowFlag => Boolean(f)))];
    const knownAwardValueOMR = awards.reduce((sum, a) => sum + (a.awardValueOMR ?? 0), 0);

    views.push({
      companyId, companyName: merge.company.companyName ?? rows[0]?.companyName ?? "(unnamed)",
      registrationNumber: merge.company.registrationNumber, legalType: merge.company.legalType, status: merge.company.status,
      registrationDate: merge.company.registrationDate, governorate: merge.company.governorate, wilayat: merge.company.wilayat,
      industry: merge.company.industry, website: merge.company.website, vatNumber: merge.company.vatNumber,
      verificationStatus: merge.verificationStatus, identityVerified, confidence: confidence.score,
      taxVerificationStatus: merge.company.taxVerificationStatus ?? null,
      registeredSupplier: merge.company.registeredSupplier ?? null, tendersParticipated: merge.company.tendersParticipated ?? null,
      awardCount: awards.length, knownAwardValueOMR, lastVerifiedAt: latestVerifiedAt, latestObservedAt, freshness,
      sourceCount: distinctSourceKeys.size, distinctSourceTypes, isReal, isDemoOnly,
      hasIdentityConflict: merge.identityConflict, hasAddressConflict: merge.addressConflict,
      hasConflict: merge.identityConflict || merge.addressConflict, adminFlags,
      riskLevel: risk.riskLevel, riskScore: risk.riskScore, riskFlags: risk.riskFlags,
      dataCompletenessScore: signals.dataCompletenessScore,
      rows, activeRows, merge, awards, signals
    });
  }
  return views.sort((a, b) => (a.companyName || "").localeCompare(b.companyName || ""));
}

export interface CompanyListFilters {
  q?: string;
  source?: CompanySourceType;
  verificationStatus?: VerificationStatus;
  taxStatus?: "verified" | "not_registered" | "pending" | "unknown" | "none";
  supplierStatus?: "supplier" | "not_supplier" | "unknown";
  status?: CompanyStatus;
  governorate?: string;
  industry?: string;
  freshness?: "fresh" | "stale";
  hasConflicts?: boolean;
  hasAwards?: boolean;
  realOrDemo?: "real" | "demo";
  page?: number;
  pageSize?: number;
  sortBy?: keyof CompanyAdminView;
  sortDir?: "asc" | "desc";
}

export interface CompanyListResult {
  rows: CompanyAdminView[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const SORTABLE_FIELDS = new Set<string>(["companyName", "confidence", "riskScore", "lastVerifiedAt", "latestObservedAt", "sourceCount", "awardCount"]);

/** Server-side filter/sort/paginate over an already-built view list (Section 6/36 — never sends
 *  the whole dataset to the browser; the admin API route is what enforces the page-size cap). */
export function filterCompanyViews(views: readonly CompanyAdminView[], filters: CompanyListFilters): CompanyListResult {
  const q = filters.q?.trim().toLowerCase();
  let filtered = views.filter(v => {
    if (q) {
      const hit = v.companyName.toLowerCase().includes(q)
        || v.registrationNumber?.toLowerCase() === q
        || v.vatNumber?.toLowerCase() === q
        || v.companyId.toLowerCase() === q
        || v.merge.company.normalizedName?.toLowerCase().includes(q);
      if (!hit) return false;
    }
    if (filters.source && !v.distinctSourceTypes.includes(filters.source)) return false;
    if (filters.verificationStatus && v.verificationStatus !== filters.verificationStatus) return false;
    if (filters.taxStatus) {
      const status = v.taxVerificationStatus ?? "none";
      if (status !== filters.taxStatus) return false;
    }
    if (filters.supplierStatus) {
      const s = v.registeredSupplier === true ? "supplier" : v.registeredSupplier === false ? "not_supplier" : "unknown";
      if (s !== filters.supplierStatus) return false;
    }
    if (filters.status && v.status !== filters.status) return false;
    if (filters.governorate && v.governorate?.toLowerCase() !== filters.governorate.toLowerCase()) return false;
    if (filters.industry && !v.industry?.toLowerCase().includes(filters.industry.toLowerCase())) return false;
    if (filters.freshness && v.freshness !== filters.freshness) return false;
    if (filters.hasConflicts !== undefined && v.hasConflict !== filters.hasConflicts) return false;
    if (filters.hasAwards !== undefined && (v.awardCount > 0) !== filters.hasAwards) return false;
    if (filters.realOrDemo === "real" && !v.isReal) return false;
    if (filters.realOrDemo === "demo" && !v.isDemoOnly) return false;
    return true;
  });

  const sortBy = filters.sortBy && SORTABLE_FIELDS.has(filters.sortBy) ? filters.sortBy : "companyName";
  const dir = filters.sortDir === "desc" ? -1 : 1;
  filtered = [...filtered].sort((a, b) => {
    const av = a[sortBy as keyof CompanyAdminView];
    const bv = b[sortBy as keyof CompanyAdminView];
    if (av === bv) return 0;
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    return (av > bv ? 1 : -1) * dir;
  });

  const pageSize = Math.max(1, Math.min(200, filters.pageSize ?? 50));
  const page = Math.max(1, filters.page ?? 1);
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  return { rows: filtered.slice(start, start + pageSize), total, page, pageSize, totalPages };
}

// ---- Dashboard (Section 4) -------------------------------------------------------------------

export const IMPORT_SOURCE_KEYS = ["mociip", "tax-oman", "tender-board-suppliers", "tender-board-awards", "generic"] as const;
export type ImportSourceKey = (typeof IMPORT_SOURCE_KEYS)[number];

export interface DashboardStats {
  totalCompanies: number;
  realCompanies: number;
  demoCompanies: number;
  identityVerified: number;
  taxVerified: number;
  governmentSuppliers: number;
  companiesWithProcurementHistory: number;
  companiesWithAwards: number;
  staleCompanyRecords: number;
  conflictingCompanies: number;
  failedImports: number;
  importsLast24Hours: number;
  latestSuccessfulImport: SyncRunRecord | null;
  latestFailedImport: SyncRunRecord | null;
  lastImportPerSource: Record<ImportSourceKey, SyncRunRecord | null>;
  targets: DatasetTargets;
  progress: { realCompanies: number; identityVerified: number; taxVerified: number; tenderBoardSuppliers: number; withProcurementHistory: number };
}

export function computeDashboardStats(views: readonly CompanyAdminView[], syncRuns: readonly SyncRunRecord[]): DashboardStats {
  const targets = getDatasetTargets();
  const realCompanies = views.filter(v => v.isReal).length;
  const identityVerified = views.filter(v => v.identityVerified).length;
  const taxVerified = views.filter(v => v.taxVerificationStatus === "verified").length;
  const tenderBoardSuppliers = views.filter(v => v.registeredSupplier === true).length;
  const withProcurementHistory = views.filter(v => v.awardCount > 0 || (v.tendersParticipated ?? 0) > 0).length;

  const lastImportPerSource = Object.fromEntries(IMPORT_SOURCE_KEYS.map(key => {
    const runs = syncRuns.filter(r => r.sourceName === key).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return [key, runs[0] ?? null];
  })) as Record<ImportSourceKey, SyncRunRecord | null>;

  const succeeded = syncRuns.filter(r => r.status === "succeeded").sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const failed = syncRuns.filter(r => r.status === "failed").sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const cutoff = Date.now() - 86_400_000;

  return {
    totalCompanies: views.length, realCompanies, demoCompanies: views.filter(v => v.isDemoOnly).length,
    identityVerified, taxVerified, governmentSuppliers: tenderBoardSuppliers,
    companiesWithProcurementHistory: withProcurementHistory, companiesWithAwards: views.filter(v => v.awardCount > 0).length,
    staleCompanyRecords: views.filter(v => v.freshness === "stale").length,
    conflictingCompanies: views.filter(v => v.hasConflict).length,
    failedImports: failed.length,
    importsLast24Hours: syncRuns.filter(r => Date.parse(r.startedAt) >= cutoff).length,
    latestSuccessfulImport: succeeded[0] ?? null, latestFailedImport: failed[0] ?? null,
    lastImportPerSource, targets,
    progress: {
      realCompanies: pct(realCompanies, targets.realCompanies),
      identityVerified: pct(identityVerified, targets.identityVerified),
      taxVerified: pct(taxVerified, targets.taxVerified),
      tenderBoardSuppliers: pct(tenderBoardSuppliers, targets.tenderBoardSuppliers),
      withProcurementHistory: pct(withProcurementHistory, targets.withProcurementHistory)
    }
  };
}

function pct(value: number, target: number): number {
  if (target <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / target) * 100)));
}

export interface SourceCoverageCard {
  key: string;
  label: string;
  accessMode: string;
  automationStatus: string;
  records: number;
  companiesCovered: number;
  latestObservedAt: string | null;
  latestImport: SyncRunRecord | null;
  freshRecords: number;
  staleRecords: number;
}

const KNOWN_PRODUCTION_SOURCE_TYPES = new Set<CompanySourceType>(["government", "tax_authority", "government_procurement", "demo"]);

/** Section 4/26: per-source cards. Everything except demo comes from `oman_companies` rows keyed
 *  by sourceType (unambiguous — each production adapter writes exactly one sourceType, see
 *  omanBusinessProvider.ts/taxOmanProvider.ts/tenderBoardProvider.ts); Tender Board AWARDS are
 *  their own card because award facts live in `oman_company_awards`, a separate list-shaped
 *  table, never mixed into the supplier-snapshot row count. "Other imports" buckets every row
 *  whose sourceType isn't one of the three production adapters or demo (company_website,
 *  licensed_feed, directory, news, other, admin_manual) — mostly rows brought in through the
 *  generic import path or manual evidence entry, which carry no adapter-specific tag of their
 *  own. */
export function computeSourceCoverage(allRows: readonly CompanyRecord[], allAwards: readonly CompanyAwardRecord[], syncRuns: readonly SyncRunRecord[]): SourceCoverageCard[] {
  const latestRunFor = (key: string) => syncRuns.filter(r => r.sourceName === key).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0] ?? null;

  const bySourceType = (type: CompanySourceType) => allRows.filter(r => r.sourceType === type);
  const cardFromRows = (rows: readonly CompanyRecord[]) => ({
    records: rows.length,
    companiesCovered: new Set(rows.map(r => r.companyId)).size,
    latestObservedAt: rows.reduce<string | null>((l, r) => (!l || r.observedAt > l ? r.observedAt : l), null),
    freshRecords: rows.filter(r => rowFreshness(r) === "fresh").length,
    staleRecords: rows.filter(r => rowFreshness(r) === "stale").length
  });

  const mociip = bySourceType("government");
  const taxOman = bySourceType("tax_authority");
  const suppliers = bySourceType("government_procurement");
  const demo = bySourceType("demo");
  const other = allRows.filter(r => !KNOWN_PRODUCTION_SOURCE_TYPES.has(r.sourceType));

  return [
    { key: "mociip", label: "Oman Business / MOCIIP", accessMode: "Manual/admin import (portal disallows automated fetching)", automationStatus: "Manual import only", latestImport: latestRunFor("mociip"), ...cardFromRows(mociip) },
    { key: "tax-oman", label: "Tax Oman", accessMode: "Manual/admin import (CAPTCHA-gated; human-verified lookups)", automationStatus: "Manual import only", latestImport: latestRunFor("tax-oman"), ...cardFromRows(taxOman) },
    { key: "tender-board-suppliers", label: "Tender Board / Esnad — Suppliers", accessMode: "Manual/admin import (portal requires PKI-certificate login)", automationStatus: "Manual import only", latestImport: latestRunFor("tender-board-suppliers"), ...cardFromRows(suppliers) },
    {
      key: "tender-board-awards", label: "Tender Board / Esnad — Awards", accessMode: "Manual/admin import (portal requires PKI-certificate login)", automationStatus: "Manual import only",
      latestImport: latestRunFor("tender-board-awards"), records: allAwards.length, companiesCovered: new Set(allAwards.map(a => a.companyId)).size,
      latestObservedAt: allAwards.reduce<string | null>((l, a) => (!l || a.observedAt > l ? a.observedAt : l), null),
      freshRecords: allAwards.filter(a => !isStale("government_procurement", daysSince(a.observedAt))).length,
      staleRecords: allAwards.filter(a => isStale("government_procurement", daysSince(a.observedAt))).length
    },
    { key: "demo", label: "Demo (curated fixture dataset)", accessMode: "Built-in fixture — never a live source", automationStatus: "N/A — not imported", latestImport: null, ...cardFromRows(demo) },
    { key: "other", label: "Other imports (generic / manual evidence)", accessMode: "Manual/admin import or manual evidence entry", automationStatus: "Manual only", latestImport: latestRunFor("generic"), ...cardFromRows(other) }
  ];
}

// ---- Queues (Sections 12/14/15/16/19) ----------------------------------------------------------

/** Conflict Review Queue (Section 14): companies whose active rows disagree on identity/address,
 *  and haven't already been marked reviewed/confirmed/kept-separate by an operator. */
export function conflictQueue(views: readonly CompanyAdminView[]): CompanyAdminView[] {
  return views.filter(v => v.hasConflict && !v.adminFlags.some(f => f === "reviewed" || f === "confirmed_same" || f === "kept_separate"));
}

/** Stale Records Queue (Section 15), grouped by the source that went stale. A company can appear
 *  under more than one source if more than one of its rows is stale. */
export function staleQueue(allRows: readonly CompanyRecord[]): { sourceType: CompanySourceType; rows: CompanyRecord[] }[] {
  const stale = allRows.filter(r => r.adminFlag !== "reviewed" && rowFreshness(r) === "stale");
  const bySource = new Map<CompanySourceType, CompanyRecord[]>();
  for (const row of stale) {
    const list = bySource.get(row.sourceType);
    if (list) list.push(row); else bySource.set(row.sourceType, [row]);
  }
  return [...bySource.entries()].map(([sourceType, rows]) => ({
    sourceType, rows: rows.sort((a, b) => (a.observedAt < b.observedAt ? -1 : 1))
  }));
}

export type ReviewReason = "unknown_verification" | "low_confidence" | "identity_conflict" | "stale_government_record" | "unknown_tax_status" | "missing_cr" | "supplier_status_needs_review";
export interface ReviewQueueItem { companyId: string; companyName: string; reasons: ReviewReason[]; priority: "high" | "medium" | "low"; recommendedAction: string }

const LOW_CONFIDENCE_THRESHOLD = 0.4;

/** Verification Work Queue (Section 16) — priority is a fixed, documented, deterministic
 *  function of which reasons apply (never an LLM judgment call): HIGH when an identity conflict
 *  or a stale AUTHORITATIVE (government/tax_authority/government_procurement) record is present;
 *  MEDIUM when confidence is low or the tax status is unknown for a company old enough to
 *  plausibly be tax-registered; LOW otherwise. */
export function reviewQueue(views: readonly CompanyAdminView[]): ReviewQueueItem[] {
  const items: ReviewQueueItem[] = [];
  for (const v of views) {
    const reasons: ReviewReason[] = [];
    if (v.verificationStatus === "unknown") reasons.push("unknown_verification");
    if (v.confidence < LOW_CONFIDENCE_THRESHOLD) reasons.push("low_confidence");
    if (v.hasIdentityConflict) reasons.push("identity_conflict");
    const staleAuthoritative = v.activeRows.some(r => AUTHORITATIVE_SOURCE_TYPES.includes(r.sourceType) && rowFreshness(r) === "stale");
    if (staleAuthoritative) reasons.push("stale_government_record");
    if (!v.taxVerificationStatus) reasons.push("unknown_tax_status");
    if (!v.registrationNumber) reasons.push("missing_cr");
    if (v.registeredSupplier === null && (v.tendersParticipated ?? 0) > 0) reasons.push("supplier_status_needs_review");
    if (reasons.length === 0) continue;

    const priority: ReviewQueueItem["priority"] = (reasons.includes("identity_conflict") || reasons.includes("stale_government_record"))
      ? "high"
      : (reasons.includes("low_confidence") || reasons.includes("unknown_tax_status")) ? "medium" : "low";
    const recommendedAction = reasons.includes("identity_conflict") ? "Resolve in the Conflict Review Queue"
      : reasons.includes("missing_cr") ? "Obtain and record the company's registration number"
      : reasons.includes("unknown_tax_status") ? "Add to the Tax Oman manual verification queue"
      : reasons.includes("stale_government_record") ? "Re-verify with the originating government source"
      : "Review manually";
    items.push({ companyId: v.companyId, companyName: v.companyName, reasons, priority, recommendedAction });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return items.sort((a, b) => rank[a.priority] - rank[b.priority] || a.companyName.localeCompare(b.companyName));
}

/** Tax Oman manual verification queue (Section 12): real (non-demo) companies with no tax
 *  verification outcome on file yet. */
export function taxVerificationQueue(views: readonly CompanyAdminView[]): CompanyAdminView[] {
  return views.filter(v => v.isReal && !v.taxVerificationStatus);
}

// ---- Data Quality (Section 23) -----------------------------------------------------------------

export interface DataQualityStats {
  missingCR: number; missingIndustry: number; missingGovernorate: number; missingRegistrationDate: number;
  missingTaxStatus: number; lowConfidence: number; staleRecords: number; conflictingRecords: number;
  unmatchedSourceRecords: number; companiesWithOnlySource: number;
  /** Mean per-company data-completeness score (0-100) from scoring/signals.ts — a DIFFERENT,
   *  deterministic metric from `confidence` above (which also weighs source authority/count/
   *  freshness). Never conflated: this is "how many of the important fields are populated",
   *  confidence is "how much should an agent trust this record". */
  dataCompletenessPercent: number;
}

export function computeDataQuality(views: readonly CompanyAdminView[], unmatchedUnresolvedCount: number): DataQualityStats {
  const n = views.length || 1;
  return {
    missingCR: views.filter(v => !v.registrationNumber).length,
    missingIndustry: views.filter(v => !v.industry).length,
    missingGovernorate: views.filter(v => !v.governorate).length,
    missingRegistrationDate: views.filter(v => !v.registrationDate).length,
    missingTaxStatus: views.filter(v => !v.taxVerificationStatus).length,
    lowConfidence: views.filter(v => v.confidence < LOW_CONFIDENCE_THRESHOLD).length,
    staleRecords: views.filter(v => v.freshness === "stale").length,
    conflictingRecords: views.filter(v => v.hasConflict).length,
    unmatchedSourceRecords: unmatchedUnresolvedCount,
    companiesWithOnlySource: views.filter(v => v.sourceCount === 1).length,
    dataCompletenessPercent: Math.round((views.reduce((sum, v) => sum + v.dataCompletenessScore, 0) / n) * 100) / 100
  };
}

// ---- Procurement dashboard (Section 17/18) -------------------------------------------------------

export interface ProcurementStats {
  registeredSuppliers: number;
  companiesWithTenderActivity: number;
  companiesWithAwards: number;
  totalAwardRecords: number;
  knownGovernmentBuyers: number;
  recentProcurementActivity: number;
  knownAwardValueOMR: number;
  awardsMissingValueCount: number;
  topCompaniesByAwardCount: { companyId: string; companyName: string; awardCount: number; knownAwardValueOMR: number }[];
  recentAwards: CompanyAwardRecord[];
  recentImports: SyncRunRecord[];
  suppliersWithoutCRMatch: number;
}

export function computeProcurementStats(views: readonly CompanyAdminView[], allAwards: readonly CompanyAwardRecord[], allRows: readonly CompanyRecord[], syncRuns: readonly SyncRunRecord[]): ProcurementStats {
  const recentCutoff = Date.now() - 90 * 86_400_000;
  const topCompanies = views.filter(v => v.awardCount > 0)
    .sort((a, b) => b.awardCount - a.awardCount)
    .slice(0, 10)
    .map(v => ({ companyId: v.companyId, companyName: v.companyName, awardCount: v.awardCount, knownAwardValueOMR: v.knownAwardValueOMR }));

  // Section 17: a government_procurement supplier-snapshot row with no registrationNumber
  // resolves to its own, unlinked companyId (tenderBoardProvider.ts never assigns a governorate,
  // so it can never share an identity with a name+governorate match either) — these are the
  // "companies with supplier data but no CR match" the spec calls out.
  const suppliersWithoutCRMatch = new Set(
    allRows.filter(r => r.sourceType === "government_procurement" && !r.registrationNumber).map(r => r.companyId)
  ).size;

  return {
    registeredSuppliers: views.filter(v => v.registeredSupplier === true).length,
    companiesWithTenderActivity: views.filter(v => v.registeredSupplier || (v.tendersParticipated ?? 0) > 0).length,
    companiesWithAwards: views.filter(v => v.awardCount > 0).length,
    totalAwardRecords: allAwards.length,
    knownGovernmentBuyers: new Set(allAwards.map(a => a.buyer).filter((b): b is string => Boolean(b))).size,
    recentProcurementActivity: allAwards.filter(a => Date.parse(a.observedAt) >= recentCutoff).length,
    knownAwardValueOMR: allAwards.reduce((sum, a) => sum + (a.awardValueOMR ?? 0), 0),
    awardsMissingValueCount: allAwards.filter(a => a.awardValueOMR === null).length,
    topCompaniesByAwardCount: topCompanies,
    recentAwards: [...allAwards].sort((a, b) => (a.observedAt < b.observedAt ? 1 : -1)).slice(0, 20),
    recentImports: syncRuns.filter(r => r.sourceName === "tender-board-suppliers" || r.sourceName === "tender-board-awards").slice(0, 10),
    suppliersWithoutCRMatch
  };
}

// ---- Coverage analysis (Section 24) --------------------------------------------------------------

export interface CoverageBreakdownRow { key: string; companies: number; realCompanies: number; identityVerified: number }

function breakdownBy(views: readonly CompanyAdminView[], keyOf: (v: CompanyAdminView) => string | null): CoverageBreakdownRow[] {
  const groups = new Map<string, CompanyAdminView[]>();
  for (const v of views) {
    const key = keyOf(v) ?? "(unknown)";
    const list = groups.get(key);
    if (list) list.push(v); else groups.set(key, [v]);
  }
  return [...groups.entries()]
    .map(([key, list]) => ({ key, companies: list.length, realCompanies: list.filter(v => v.isReal).length, identityVerified: list.filter(v => v.identityVerified).length }))
    .sort((a, b) => b.companies - a.companies);
}

export interface CoverageBreakdowns {
  byGovernorate: CoverageBreakdownRow[];
  byIndustry: CoverageBreakdownRow[];
  bySourceType: CoverageBreakdownRow[];
  byVerificationStatus: CoverageBreakdownRow[];
}

/** Section 24: "Current Dataset Coverage" breakdowns — deliberately named that way everywhere
 *  it's rendered (never implied to represent the true distribution of all companies in Oman). */
export function computeCoverageBreakdowns(views: readonly CompanyAdminView[]): CoverageBreakdowns {
  return {
    byGovernorate: breakdownBy(views, v => v.governorate),
    byIndustry: breakdownBy(views, v => v.industry),
    bySourceType: breakdownBy(views, v => v.distinctSourceTypes[0] ?? null),
    byVerificationStatus: breakdownBy(views, v => v.verificationStatus)
  };
}

// ---- CSV export (Section 25) ----------------------------------------------------------------------

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) lines.push(row.map(csvEscape).join(","));
  return lines.join("\r\n") + "\r\n";
}

export function companyListToCsv(rows: readonly CompanyAdminView[]): string {
  return toCsv(
    ["companyId", "companyName", "registrationNumber", "status", "governorate", "industry", "verificationStatus", "confidence", "taxVerificationStatus", "registeredSupplier", "awardCount", "lastVerifiedAt", "freshness", "sourceCount"],
    rows.map(v => [v.companyId, v.companyName, v.registrationNumber, v.status, v.governorate, v.industry, v.verificationStatus, v.confidence, v.taxVerificationStatus, v.registeredSupplier, v.awardCount, v.lastVerifiedAt, v.freshness, v.sourceCount])
  );
}

// ---- Audit trail helper (Section 29) ---------------------------------------------------------

/** Best-effort audit write: the underlying admin action has already happened by the time this is
 *  called, so a failure here is logged to stderr rather than thrown — it must never roll back or
 *  block the action it's recording. Never pass a password, cookie, token or full file body in
 *  `metadata`. */
export async function writeAudit(repository: CompanyRepository, adminUser: string, action: string, entityType: string | null, entityId: string | null, metadata: Record<string, unknown> = {}): Promise<void> {
  try {
    await repository.writeAuditLog({ adminUser, action, entityType, entityId, metadata });
  } catch (error) {
    process.stderr.write(`Admin audit log write failed (action=${action}): ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
