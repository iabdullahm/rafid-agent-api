import { z } from "zod";
import { COMPANY_SOURCE_TYPES, IMPORTANCE_LEVELS, RISK_SEVERITIES, VERIFICATION_STATUSES } from "../business-data/types.js";

const n = z.number();

/** Section 5's literal source-provenance object, shared by every capability's `sources` field.
 *  `sourceAuthority`/`verificationStatus` are Phase 2/3 additions — every source is now explainable
 *  as how trustworthy (0-1) and how verified (verified/reported/estimated/inferred/stale/
 *  conflicting/unknown) it is, not just which sourceType it came from. */
export const provenanceEntrySchema = z.strictObject({
  sourceName: z.string(),
  sourceType: z.enum(COMPANY_SOURCE_TYPES),
  sourceAuthority: n.min(0).max(1),
  sourceUrl: z.string().nullable(),
  sourceRecordId: z.string().nullable(),
  observedAt: z.string(),
  verificationStatus: z.enum(VERIFICATION_STATUSES),
  fields: z.array(z.string())
});

/** Phase 15: how much of a result is backed by real vs. demo evidence. */
const dataCoverageSchema = z.strictObject({
  realSources: n.int().min(0),
  demoSources: n.int().min(0),
  latestVerifiedAt: z.string().nullable()
});

/** Phase 6/16: one procurement award/contract fact, as surfaced in the `procurement.awards` list —
 *  never fabricated, only ever populated from an actual Tender Board/Esnad-sourced award record. */
const awardSchema = z.strictObject({
  tenderNumber: z.string(),
  buyer: z.string().nullable(),
  title: z.string().nullable(),
  status: z.string().nullable(),
  awardValueOMR: n.nullable(),
  category: z.string().nullable(),
  sourceName: z.string(),
  observedAt: z.string()
});

/** Phase 6/16/17: the merged procurement snapshot + individual awards for one company — shared by
 *  get_oman_company_profile and due_diligence_oman_company. */
const procurementSchema = z.strictObject({
  registeredSupplier: z.boolean().nullable(),
  supplierCategory: z.string().nullable(),
  supplierClassification: z.string().nullable(),
  governmentProcurementPresence: z.boolean().nullable(),
  tendersParticipated: n.int().nullable(),
  awardedContractCount: n.int().nullable(),
  lastTenderActivityAt: z.string().nullable(),
  awards: z.array(awardSchema)
});

const riskFlagSchema = z.strictObject({ code: z.string(), severity: z.enum(RISK_SEVERITIES), message: z.string() });

const businessMaturity = z.enum(["new", "early_stage", "growing", "established"]);
const governmentProcurementActivity = z.enum(["active", "limited", "none"]);

export const searchOmanCompanyOutput = z.strictObject({
  matches: z.array(z.strictObject({
    companyId: z.string(),
    companyName: z.string(),
    normalizedName: z.string(),
    legalType: z.string().nullable(),
    industry: z.string().nullable(),
    governorate: z.string().nullable(),
    wilayat: z.string().nullable(),
    status: z.string().nullable(),
    website: z.string().nullable(),
    confidence: n.min(0).max(1)
  })),
  totalMatches: n.int()
});

const companyProfileFields = z.strictObject({
  companyId: z.string(),
  companyName: z.string(),
  legalType: z.string().nullable(),
  status: z.string().nullable(),
  registrationNumber: z.string().nullable(),
  registrationDate: z.string().nullable(),
  industry: z.string().nullable(),
  activities: z.array(z.string()),
  governorate: z.string().nullable(),
  wilayat: z.string().nullable(),
  address: z.string().nullable(),
  website: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable()
});

export const getOmanCompanyProfileOutput = z.strictObject({
  company: companyProfileFields,
  digitalPresence: z.strictObject({
    websiteFound: z.boolean(),
    domain: z.string().nullable(),
    // Never populated with fabricated handles — see src/business-data/db schema doc comment on
    // oman_company_social_profiles (a documented, not-yet-wired seam). Always [] in this MVP.
    socialProfiles: z.array(z.string())
  }),
  // Phase 3/16: company-level verification metadata, merged across every contributing source.
  verification: z.strictObject({
    verificationStatus: z.enum(VERIFICATION_STATUSES),
    lastVerifiedAt: z.string().nullable(),
    taxVerificationStatus: z.string().nullable(),
    taxVerifiedAt: z.string().nullable()
  }),
  // Phase 6/16: the merged procurement snapshot + individual awards.
  procurement: procurementSchema,
  // Phase 15: real-vs-demo evidence coverage for this company.
  dataCoverage: dataCoverageSchema,
  sources: z.array(provenanceEntrySchema)
});

export const analyzeOmanCompanyOutput = z.strictObject({
  companyId: z.string(),
  commercialSignals: z.strictObject({
    yearsActive: n.int(),
    operatingStatus: z.string(),
    digitalPresenceScore: n.int().min(0).max(100),
    dataCompletenessScore: n.int().min(0).max(100),
    businessMaturity,
    // Phase 17: a deterministic summary of the company's Tender Board/Esnad procurement footprint.
    governmentProcurementActivity
  }),
  riskFlags: z.array(riskFlagSchema),
  positiveSignals: z.array(z.string()),
  recommendedChecks: z.array(z.string()),
  confidence: n.min(0).max(1),
  // Additive beyond the task's literal example (which shows a bare confidence number) — explains
  // what drove that number, in the same spirit as analyze_oman_property's confidence.reasons.
  confidenceReasons: z.array(z.string()),
  // Phase 15: real-vs-demo evidence coverage for this company.
  dataCoverage: dataCoverageSchema,
  sources: z.array(provenanceEntrySchema)
});

export const dueDiligenceOmanCompanyOutput = z.strictObject({
  company: companyProfileFields,
  verification: z.strictObject({
    identityVerified: z.boolean(),
    status: z.string().nullable(),
    registrationAgeYears: n.int(),
    // Phase 3/16: company-level verification metadata, merged across every contributing source —
    // the literal "Commercial registration: verified / Tax status: verified / Data last verified:
    // ..." facts the product principle calls for.
    verificationStatus: z.enum(VERIFICATION_STATUSES),
    lastVerifiedAt: z.string().nullable(),
    taxVerificationStatus: z.string().nullable(),
    taxVerifiedAt: z.string().nullable()
  }),
  // Phase 6/16: "Government supplier: yes / Tender Board activity: found / Known awarded
  // contracts: 3" — the merged procurement snapshot + individual awards.
  procurement: procurementSchema,
  commercialAssessment: z.strictObject({
    operationalMaturity: businessMaturity,
    digitalFootprint: z.enum(["strong", "moderate", "weak", "none"]),
    publicInformationCoverage: z.enum(["high", "medium", "low"]),
    governmentProcurementActivity
  }),
  riskAssessment: z.strictObject({
    riskLevel: z.enum(["low", "medium", "high"]),
    riskScore: n.int().min(0).max(100),
    riskFlags: z.array(riskFlagSchema)
  }),
  recommendedDueDiligence: z.array(z.strictObject({ check: z.string(), importance: z.enum(IMPORTANCE_LEVELS) })),
  missingInformation: z.array(z.string()),
  confidence: n.min(0).max(1),
  confidenceReasons: z.array(z.string()),
  // Phase 15: real-vs-demo evidence coverage for this company.
  dataCoverage: dataCoverageSchema,
  sources: z.array(provenanceEntrySchema)
});
