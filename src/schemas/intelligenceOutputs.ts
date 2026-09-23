import { z } from "zod";
import { INTELLIGENCE_SOURCE_TYPES, EVIDENCE_TIERS, SEVERITY_LEVELS, INTELLIGENCE_DATA_MODES } from "../intelligence/types.js";
import { RISK_CHECK_TYPES } from "./intelligenceInputs.js";

const n = z.number();

export const intelligenceSourceSchema = z.strictObject({
  url: z.string().nullable(),
  title: z.string(),
  publisher: z.string().nullable(),
  sourceType: z.enum(INTELLIGENCE_SOURCE_TYPES),
  observedAt: z.string()
});

export const dataFreshnessSchema = z.strictObject({
  latestSourceDate: z.string().nullable(),
  freshnessDays: n.int().nullable()
});

// ---------------------------------------------------------------------------------------------
// research_company
// ---------------------------------------------------------------------------------------------

const fundingRoundSchema = z.strictObject({
  round: z.string().nullable(),
  amount: z.string().nullable(),
  date: z.string().nullable(),
  investors: z.array(z.string())
});

const recentDevelopmentSchema = z.strictObject({
  title: z.string(),
  date: z.string().nullable(),
  summary: z.string(),
  source: z.string().nullable()
});

export const researchCompanyOutput = z.strictObject({
  company: z.strictObject({
    name: z.string(),
    website: z.string().nullable(),
    industry: z.string().nullable(),
    headquarters: z.string().nullable(),
    founded: z.string().nullable()
  }),
  overview: z.string().nullable(),
  productsAndServices: z.array(z.string()),
  leadership: z.array(z.strictObject({ name: z.string(), title: z.string().nullable() })),
  funding: z.strictObject({ summary: z.string().nullable(), knownRounds: z.array(fundingRoundSchema) }),
  competitors: z.array(z.strictObject({ name: z.string(), reason: z.string() })),
  technologySignals: z.array(z.string()),
  recentDevelopments: z.array(recentDevelopmentSchema),
  riskFlags: z.array(z.string()),
  sources: z.array(intelligenceSourceSchema),
  confidence: n.min(0).max(1),
  dataFreshness: dataFreshnessSchema,
  // Additive beyond the task's literal example shape, in the same spirit as
  // analyze_oman_company's dataCoverage/confidenceReasons additions — see Caching/Provenance
  // sections of the spec ("expose cached, dataFreshness where appropriate"; never claim data
  // came from a source when it did not).
  cached: z.boolean(),
  dataMode: z.enum(INTELLIGENCE_DATA_MODES),
  limitations: z.array(z.string())
});

// ---------------------------------------------------------------------------------------------
// find_companies
// ---------------------------------------------------------------------------------------------

const foundCompanySchema = z.strictObject({
  name: z.string(),
  website: z.string().nullable(),
  industry: z.string().nullable(),
  location: z.strictObject({ country: z.string().nullable(), city: z.string().nullable() }),
  employeeRange: z.string().nullable(),
  description: z.string().nullable(),
  whyMatched: z.string(),
  sources: z.array(intelligenceSourceSchema)
});

export const findCompaniesOutput = z.strictObject({
  companies: z.array(foundCompanySchema),
  resultCount: n.int(),
  sources: z.array(intelligenceSourceSchema),
  confidence: n.min(0).max(1),
  cached: z.boolean(),
  dataMode: z.enum(INTELLIGENCE_DATA_MODES),
  // Additive: Section "Pricing" explicitly anticipates the requested limit and the internal,
  // provider-cost-driven cap diverging ("can remain up to 20 initially... design so tiered
  // pricing can be added later") — surfacing both, honestly, rather than silently truncating.
  requestedLimit: n.int(),
  appliedLimit: n.int(),
  limitations: z.array(z.string())
});

// ---------------------------------------------------------------------------------------------
// analyze_company_risk
// ---------------------------------------------------------------------------------------------

const riskEvidenceItemSchema = z.strictObject({
  description: z.string(),
  source: z.string().nullable(),
  tier: z.enum(EVIDENCE_TIERS)
});

const riskSignalSchema = z.strictObject({
  type: z.enum(RISK_CHECK_TYPES),
  severity: z.enum(SEVERITY_LEVELS),
  summary: z.string(),
  evidence: z.array(riskEvidenceItemSchema),
  source: z.string().nullable()
});

const CHECK_STATUSES = ["performed", "not_configured", "unavailable", "not_applicable"] as const;
const checkResultSchema = z.strictObject({
  status: z.enum(CHECK_STATUSES),
  summary: z.string().nullable(),
  findings: z.array(z.string()),
  evidence: z.array(riskEvidenceItemSchema)
});

export const analyzeCompanyRiskOutput = z.strictObject({
  company: z.strictObject({ name: z.string().nullable(), website: z.string().nullable(), country: z.string().nullable() }),
  riskSignals: z.array(riskSignalSchema),
  checks: z.strictObject({
    corporateIdentity: checkResultSchema,
    domain: checkResultSchema,
    website: checkResultSchema,
    sanctions: checkResultSchema,
    adverseNews: checkResultSchema,
    securitySignals: checkResultSchema,
    // Additive beyond the task's literal `checks` example (which showed 6 keys) so all 8 valid
    // `checks` input values have a corresponding result object — reputation/legalSignals are
    // legitimate RISK_CHECK_TYPES values (input schema) that would otherwise have no place to
    // report their findings.
    reputation: checkResultSchema,
    legalSignals: checkResultSchema
  }),
  sources: z.array(intelligenceSourceSchema),
  confidence: n.min(0).max(1),
  limitations: z.array(z.string()),
  cached: z.boolean(),
  dataMode: z.enum(INTELLIGENCE_DATA_MODES)
});
