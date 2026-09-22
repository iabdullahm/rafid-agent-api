import { searchOmanCompanyInput, getOmanCompanyProfileInput, analyzeOmanCompanyInput, dueDiligenceOmanCompanyInput } from "../schemas/businessInputs.js";
import { ApiError } from "../utils/errors.js";
import { getOmanBusinessDataMode, getOmanBusinessDatabaseUrl } from "../business-data/config.js";
import { CompositeCompanyProvider, DatabaseCompanyProvider, DemoCompanyProvider, LicensedFeedCompanyProvider, type CompanyDataProvider } from "../business-data/sources/provider.js";
import { PostgresCompanyRepository } from "../db/businessStore.js";
import { rankCompanies } from "../business-data/matching/search.js";
import { mergeCompanyRows, type MergeResult } from "../business-data/matching/merge.js";
import { computeCommercialSignals, coverageLabel, digitalFootprintLabel } from "../business-data/scoring/signals.js";
import { assessCompanyRisk } from "../business-data/scoring/risk.js";
import { computeCompanyConfidence } from "../business-data/scoring/confidence.js";
import { buildPositiveSignals, buildRecommendedChecks, buildDueDiligenceChecklist, buildMissingInformation } from "../business-data/scoring/recommendations.js";
import { AUTHORITATIVE_SOURCE_TYPES, yearsSince, type CompanyAwardRecord, type CompanyProvenanceEntry, type DataCoverage } from "../business-data/types.js";
import type { CompanyRecord } from "../business-data/sources/companyRepository.js";

/**
 * Section 6/14: builds the provider this capability actually queries, from
 * OMAN_BUSINESS_DATA_MODE — identical structure to src/services/omanProperty.ts's
 * buildProviders():
 *  - "manual" (default): only the curated demo dataset.
 *  - "database": only the production CompanyRepository-backed provider.
 *  - "composite": database first, demo last (real data wins on an id collision).
 * Constructed once at module load; a `pg.Pool` does not open a connection until a query
 * actually runs, so this is safe even when the database is not currently reachable — a
 * per-provider failure degrades to "no records from that provider" (CompositeCompanyProvider).
 */
function buildProvider(): CompanyDataProvider {
  const mode = getOmanBusinessDataMode();
  const licensed = new LicensedFeedCompanyProvider();
  const demo = new DemoCompanyProvider();
  if (mode === "manual") return new CompositeCompanyProvider([licensed, demo]);

  const databaseUrl = getOmanBusinessDatabaseUrl();
  if (!databaseUrl) throw new Error(`OMAN_BUSINESS_DATA_MODE=${mode} requires DATABASE_URL or OMAN_BUSINESS_DATABASE_URL to be set`);
  const database = new DatabaseCompanyProvider(new PostgresCompanyRepository(databaseUrl));
  return mode === "database" ? new CompositeCompanyProvider([licensed, database]) : new CompositeCompanyProvider([licensed, database, demo]);
}

const provider = buildProvider();

function domainFromWebsite(website: string | null): string | null {
  if (!website) return null;
  try { return new URL(website).hostname.replace(/^www\./, ""); } catch { return null; }
}

async function loadCompany(companyId: string, activeProvider: CompanyDataProvider): Promise<{ rows: readonly CompanyRecord[]; merge: MergeResult; awards: readonly CompanyAwardRecord[] }> {
  const rows = await activeProvider.getByCompanyId(companyId);
  if (rows.length === 0) throw new ApiError(404, "COMPANY_NOT_FOUND", "No company was found for the given companyId");
  const awards = await activeProvider.getAwardsByCompanyId(companyId);
  return { rows, merge: mergeCompanyRows(companyId, rows), awards };
}

function toProfileFields(merge: MergeResult) {
  const c = merge.company;
  return {
    companyId: c.companyId, companyName: c.companyName, legalType: c.legalType, status: c.status,
    registrationNumber: c.registrationNumber, registrationDate: c.registrationDate, industry: c.industry,
    activities: [...c.activities], governorate: c.governorate, wilayat: c.wilayat, address: c.address,
    website: c.website, email: c.email, phone: c.phone
  };
}

function toProvenance(entries: readonly CompanyProvenanceEntry[]) {
  return entries.map(e => ({ ...e, fields: [...e.fields] }));
}

/** Phase 15: how much of this result is backed by real vs. demo evidence — computed from the raw
 *  contributing rows (never the merged/deduplicated view) so every distinct source is counted.
 *  `latestVerifiedAt` is the most recent lastVerifiedAt across every contributing row, or null when
 *  no row has ever been actively verified (e.g. demo-only evidence). */
function toDataCoverage(rows: readonly CompanyRecord[]): DataCoverage {
  const distinctSourceKeys = new Set(rows.map(r => `${r.sourceType}::${r.sourceName}`));
  let realSources = 0, demoSources = 0;
  for (const key of distinctSourceKeys) { if (key.startsWith("demo::")) demoSources++; else realSources++; }
  const latestVerifiedAt = rows.reduce<string | null>((latest, r) => {
    if (!r.lastVerifiedAt) return latest;
    return !latest || r.lastVerifiedAt > latest ? r.lastVerifiedAt : latest;
  }, null);
  return { realSources, demoSources, latestVerifiedAt };
}

/** Phase 6/16/17: the procurement snapshot + individual award/contract facts for one company —
 *  shared verbatim by get_oman_company_profile and due_diligence_oman_company. `awards` comes from
 *  the provider directly (never fabricated from the snapshot fields), so it can legitimately be []
 *  even when governmentProcurementPresence is true (participation on file, no award yet). */
function toProcurement(merge: MergeResult, awards: readonly CompanyAwardRecord[]) {
  const c = merge.company;
  return {
    registeredSupplier: c.registeredSupplier ?? null,
    supplierCategory: c.supplierCategory ?? null,
    supplierClassification: c.supplierClassification ?? null,
    governmentProcurementPresence: c.governmentProcurementPresence ?? null,
    tendersParticipated: c.tendersParticipated ?? null,
    // Prefer the actual count of individually-imported award records when any exist (self-
    // consistent with the `awards` list below by construction); fall back to a supplier-snapshot's
    // own reported count only when no individual award record has been imported for this company —
    // never let the two silently disagree when both are available.
    awardedContractCount: awards.length > 0 ? awards.length : (c.awardedContractCount ?? null),
    lastTenderActivityAt: c.lastTenderActivityAt ?? null,
    awards: awards.map(a => ({
      tenderNumber: a.tenderNumber, buyer: a.buyer, title: a.title, status: a.status,
      awardValueOMR: a.awardValueOMR, category: a.category, sourceName: a.sourceName, observedAt: a.observedAt
    }))
  };
}

/** Phase 3/16: the merged verification metadata block — company-level verificationStatus (from
 *  mergeCompanyRows), the most recent lastVerifiedAt across contributing rows, and the Tax
 *  Oman-specific verification outcome when a tax_authority source has contributed one. */
function toVerificationMetadata(merge: MergeResult, dataCoverage: DataCoverage) {
  return {
    verificationStatus: merge.verificationStatus,
    lastVerifiedAt: dataCoverage.latestVerifiedAt,
    taxVerificationStatus: merge.company.taxVerificationStatus ?? null,
    taxVerifiedAt: merge.company.taxVerifiedAt ?? null
  };
}

export async function runSearchOmanCompany(input: unknown, activeProvider: CompanyDataProvider = provider) {
  const p = searchOmanCompanyInput.parse(input);
  const rows = await activeProvider.search({ query: p.query, governorate: p.governorate, wilayat: p.wilayat, industry: p.industry, candidateLimit: 200 });
  const ranked = rankCompanies(rows, p);
  return {
    matches: ranked.map(({ record, confidence }) => ({
      companyId: record.companyId, companyName: record.companyName, normalizedName: record.normalizedName,
      legalType: record.legalType, industry: record.industry, governorate: record.governorate, wilayat: record.wilayat,
      status: record.status, website: record.website, confidence
    })),
    totalMatches: ranked.length
  };
}

export async function runGetOmanCompanyProfile(input: unknown, activeProvider: CompanyDataProvider = provider) {
  const p = getOmanCompanyProfileInput.parse(input);
  const { rows, merge, awards } = await loadCompany(p.companyId, activeProvider);
  const domain = domainFromWebsite(merge.company.website);
  const dataCoverage = toDataCoverage(rows);
  return {
    company: toProfileFields(merge),
    digitalPresence: { websiteFound: Boolean(merge.company.website), domain, socialProfiles: [] as string[] },
    verification: toVerificationMetadata(merge, dataCoverage),
    procurement: toProcurement(merge, awards),
    dataCoverage,
    sources: toProvenance(merge.provenance)
  };
}

export async function runAnalyzeOmanCompany(input: unknown, activeProvider: CompanyDataProvider = provider) {
  const p = analyzeOmanCompanyInput.parse(input);
  const { rows, merge } = await loadCompany(p.companyId, activeProvider);
  const signals = computeCommercialSignals(merge.company);
  const risk = assessCompanyRisk(merge.company, rows, merge.identityConflict, merge.addressConflict);
  const confidence = computeCompanyConfidence(rows, signals.dataCompletenessScore, merge.identityConflict);
  return {
    companyId: p.companyId,
    commercialSignals: signals,
    riskFlags: risk.riskFlags,
    positiveSignals: buildPositiveSignals(merge.company, rows, signals),
    recommendedChecks: buildRecommendedChecks(risk.riskFlags),
    confidence: confidence.score,
    confidenceReasons: confidence.reasons,
    dataCoverage: toDataCoverage(rows),
    sources: toProvenance(merge.provenance)
  };
}

export async function runDueDiligenceOmanCompany(input: unknown, activeProvider: CompanyDataProvider = provider) {
  const p = dueDiligenceOmanCompanyInput.parse(input);
  const { rows, merge, awards } = await loadCompany(p.companyId, activeProvider);
  const signals = computeCommercialSignals(merge.company);
  const risk = assessCompanyRisk(merge.company, rows, merge.identityConflict, merge.addressConflict);
  const confidence = computeCompanyConfidence(rows, signals.dataCompletenessScore, merge.identityConflict);
  const identityVerified = rows.some(r => AUTHORITATIVE_SOURCE_TYPES.includes(r.sourceType)) && !merge.identityConflict;
  const dataCoverage = toDataCoverage(rows);
  return {
    company: toProfileFields(merge),
    verification: {
      identityVerified, status: merge.company.status,
      registrationAgeYears: merge.company.registrationDate ? yearsSince(merge.company.registrationDate) : 0,
      ...toVerificationMetadata(merge, dataCoverage)
    },
    procurement: toProcurement(merge, awards),
    commercialAssessment: {
      operationalMaturity: signals.businessMaturity,
      digitalFootprint: digitalFootprintLabel(signals.digitalPresenceScore),
      publicInformationCoverage: coverageLabel(signals.dataCompletenessScore),
      // due_diligence_oman_company (unlike analyze_oman_company) fetches the individual award
      // records, so its classification can be more precise than commercialSignals.
      // governmentProcurementActivity (which only sees the merged snapshot fields, never the raw
      // award list) — a fetched award always means "active" here, even when no supplier-snapshot
      // source ever set awardedContractCount explicitly.
      governmentProcurementActivity: awards.length > 0 ? "active" : signals.governmentProcurementActivity
    },
    riskAssessment: { riskLevel: risk.riskLevel, riskScore: risk.riskScore, riskFlags: risk.riskFlags },
    recommendedDueDiligence: buildDueDiligenceChecklist(risk.riskFlags, p.transactionType),
    missingInformation: buildMissingInformation(merge.company),
    confidence: confidence.score,
    confidenceReasons: confidence.reasons,
    dataCoverage,
    sources: toProvenance(merge.provenance)
  };
}

/** The capabilities' real entry points (src/domain/capabilities.ts) — always run against the
 *  module-level provider built from OMAN_BUSINESS_DATA_MODE. */
export async function searchOmanCompany(input: unknown) { return runSearchOmanCompany(input, provider); }
export async function getOmanCompanyProfile(input: unknown) { return runGetOmanCompanyProfile(input, provider); }
export async function analyzeOmanCompany(input: unknown) { return runAnalyzeOmanCompany(input, provider); }
export async function dueDiligenceOmanCompany(input: unknown) { return runDueDiligenceOmanCompany(input, provider); }
