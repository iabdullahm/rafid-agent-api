import { z } from "zod";
import {
  ADDRESS_STATUSES, CHECK_STATUSES, EVIDENCE_SOURCE_TYPES, FLAG_SEVERITIES, IDENTITY_MATCH_LEVELS, OVERALL_RISK_LEVELS,
  PROCUREMENT_SUITABILITY, PUBLIC_RISK_STATUSES, SANCTIONS_STATUSES, SUPPLIER_RISK_FLAG_CODES
} from "../supplier-check/types.js";

const nullableBool = z.boolean().nullable();

export const omanSupplierCheckOutput = z.strictObject({
  supplier: z.strictObject({
    inputName: z.string(),
    normalizedName: z.string(),
    matchedName: z.string().nullable(),
    matchedNameAr: z.string().nullable(),
    companyId: z.string().nullable(),
    /** The registry CR number of the matched company when one exists, else the supplied CR. */
    crNumber: z.string().nullable(),
    crNumberSupplied: z.string().nullable(),
    country: z.literal("OM"),
    identityMatch: z.enum(IDENTITY_MATCH_LEVELS)
  }),
  screeningResult: z.strictObject({
    risk: z.enum(OVERALL_RISK_LEVELS),
    riskScore: z.number().min(0).max(100),
    procurementSuitability: z.enum(PROCUREMENT_SUITABILITY),
    identityConfirmed: z.boolean(),
    activityMatch: nullableBool,
    summary: z.string()
  }),
  checks: z.strictObject({
    companyIdentity: z.strictObject({ status: z.enum(CHECK_STATUSES), confidence: z.number().min(0).max(1), explanation: z.string(), corroborations: z.array(z.string()) }),
    website: z.strictObject({
      status: z.enum(CHECK_STATUSES), explanation: z.string(), url: z.string().nullable(), urlSource: z.enum(["supplied", "registry"]).nullable(),
      signals: z.strictObject({
        websiteExists: nullableBool, https: nullableBool, domainMatchesCompanyName: nullableBool, domainMatchesRegistry: nullableBool,
        companyNameOnWebsite: nullableBool, corporateEmailOnWebsite: nullableBool, phoneOnWebsite: nullableBool,
        physicalAddressOnWebsite: nullableBool, redirectedToDifferentDomain: nullableBool
      })
    }),
    businessActivity: z.strictObject({ status: z.enum(CHECK_STATUSES), explanation: z.string(), requiredCategories: z.array(z.string()), supplierCategories: z.array(z.string()) }),
    contactConsistency: z.strictObject({ status: z.enum(CHECK_STATUSES), explanation: z.string() }),
    addressConsistency: z.strictObject({ status: z.enum(ADDRESS_STATUSES), explanation: z.string() }),
    sanctions: z.strictObject({
      status: z.enum(SANCTIONS_STATUSES),
      matches: z.array(z.strictObject({
        name: z.string(), matchedAlias: z.string().nullable(), source: z.string(), reference: z.string().nullable(), sourceUrl: z.string().nullable(),
        matchScore: z.number().min(0).max(1), matchType: z.enum(["exact_normalized_name", "fuzzy_name"]), reason: z.string()
      })),
      listsChecked: z.array(z.string()),
      listsUnavailable: z.array(z.string()),
      explanation: z.string()
    }),
    publicRisk: z.strictObject({
      status: z.enum(PUBLIC_RISK_STATUSES),
      signals: z.array(z.strictObject({
        type: z.enum(["public_web_mention", "possible_impersonation", "contradictory_business_identity"]),
        description: z.string(), evidenceTier: z.enum(["public_allegation", "automated_indicator"]),
        sourceUrl: z.string().nullable(), sourceTitle: z.string().nullable()
      })),
      explanation: z.string()
    })
  }),
  riskFlags: z.array(z.strictObject({ code: z.enum(SUPPLIER_RISK_FLAG_CODES), severity: z.enum(FLAG_SEVERITIES), message: z.string() })),
  riskModel: z.strictObject({
    score: z.number().min(0).max(100),
    thresholds: z.strictObject({ medium: z.number(), high: z.number() }),
    components: z.array(z.strictObject({ factor: z.string(), points: z.number(), reason: z.string() }))
  }),
  normalizedInput: z.strictObject({
    companyName: z.string(), normalizedName: z.string(), nameVariants: z.array(z.string()), crNumber: z.string().nullable(),
    website: z.string().nullable(), websiteDomain: z.string().nullable(), email: z.string().nullable(), emailDomain: z.string().nullable(),
    freeEmailProvider: z.boolean(),
    phone: z.strictObject({ e164: z.string().nullable(), isOman: z.boolean(), lineType: z.enum(["mobile", "landline", "unknown"]) }).nullable(),
    address: z.string().nullable(), requiredProductOrService: z.string().nullable()
  }),
  sources: z.array(z.strictObject({ type: z.enum(EVIDENCE_SOURCE_TYPES), name: z.string(), url: z.string().nullable(), checkedAt: z.string(), observedAt: z.string().nullable() })),
  dataCoverage: z.strictObject({
    registryMatch: z.boolean(),
    demoDataOnly: z.boolean(),
    liveChecksPerformed: z.array(z.string()),
    unavailableSources: z.array(z.string())
  }),
  confidence: z.number().min(0).max(1),
  limitations: z.array(z.string())
});

export type OmanSupplierCheckOutput = z.infer<typeof omanSupplierCheckOutput>;
