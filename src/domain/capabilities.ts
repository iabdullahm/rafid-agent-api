import { propertySchema, compareSchema, maintenanceSchema } from "../schemas/inputs.js";
import { analysisOutput, comparisonOutput, maintenanceOutput } from "../schemas/outputs.js";
import { analyzeProperty, compareProperties, estimateMaintenance } from "../services/property.js";
import { omanPropertyInput } from "../schemas/omanInputs.js";
import { omanPropertyOutput } from "../schemas/omanOutputs.js";
import { analyzeOmanProperty } from "../services/omanProperty.js";
import { searchOmanCompanyInput, getOmanCompanyProfileInput, analyzeOmanCompanyInput, dueDiligenceOmanCompanyInput } from "../schemas/businessInputs.js";
import { searchOmanCompanyOutput, getOmanCompanyProfileOutput, analyzeOmanCompanyOutput, dueDiligenceOmanCompanyOutput } from "../schemas/businessOutputs.js";
import { searchOmanCompany, getOmanCompanyProfile, analyzeOmanCompany, dueDiligenceOmanCompany } from "../services/omanBusiness.js";
import type { z } from "zod";

/** The one currency every capability is priced in today. A single constant, not a literal
 *  repeated per capability, so pricing display never has to be kept in sync by hand. */
export const CURRENCY = "USD";

/**
 * A single, complete description of one thing an AI agent can do with Rafid Agent API.
 *
 * This is the ONE place a tool is described. Every consumer — REST route registration
 * (src/api/app.ts), the OpenAPI document (src/api/openapi.ts), the MCP server
 * (src/mcp/server.ts), the x402 payment gate (src/billing/x402.ts, via BillingService), the
 * agent-marketplace endpoints (src/api/agent.ts: /api/v1/agent, /api/v1/pricing,
 * /api/v1/tools, /api/v1/capabilities), the top-level manifests (src/api/manifest.ts:
 * /agent.json and the two /.well-known/ documents) and llms.txt (src/api/llms-txt.ts) all
 * read from the same `capabilities` array below — none of them hold a second copy of a name,
 * a price, a schema or a description. Adding a capability here is what makes it real
 * everywhere at once; nothing else needs to be told about it separately.
 */
export interface AgentCapability {
  /** Stable machine identifier. Used as the MCP tool name, the OpenAPI operationId, and the
   *  key BillingService/the x402 gate price by — never reused, never renamed once shipped. */
  name: string;
  /** REST path suffix, mounted under both /api/v1 and (unauthenticated) /api/v1/x402. */
  path: string;
  /** One factual sentence: what it computes, in what unit, with what caveat if any. No
   *  marketing language — this string is read verbatim by MCP clients and agents deciding
   *  whether to call the tool, not by a human browsing a website. */
  description: string;
  /** A short, imperative sentence naming the situation this tool is the right answer to,
   *  e.g. "Use when an agent needs financial metrics for ONE property." — the raw material
   *  for the recommendation layer (GET /api/v1/capabilities, /agent.json, llms.txt): an agent
   *  (or the model behind it) should be able to pick the right tool from this line alone. */
  whenToUse: string;
  /** Short scenario keywords/phrases this tool answers — the same recommendation-layer intent
   *  as `whenToUse`, in list form for programmatic matching rather than prose. */
  useCases: readonly string[];
  input: z.ZodType;
  output: z.ZodType;
  example: unknown;
  /** The exact output `execute(example)` produces, hand-computed (or generated once via a probe
   *  script and pasted in) rather than obtained by calling execute() at module-load/build time.
   *  Consumed by OpenAPI's example generation (src/api/openapi.ts) — this is the only correct
   *  source for a documentation example now that execute() may perform real (async) I/O and can
   *  no longer safely be called as a side effect of building the OpenAPI document. */
  exampleOutput: unknown;
  /** Every capability's execution is asynchronous, whether or not it actually awaits anything —
   *  a pure calculation returns via an async function (or Promise.resolve), so that a capability
   *  whose data comes from a real network/database call (see analyze_oman_property) fits the
   *  exact same contract as one that doesn't. Every consumer (REST routes and the x402 route
   *  family in src/api/app.ts, the MCP server in src/mcp/server.ts) awaits this. */
  execute: (input: unknown) => Promise<unknown>;
  /** Price in `currency` per successful call, whether paid via API key (BillingGate, currently
   *  a no-op) or x402 — both read this same number, never a second literal. */
  price: number;
  currency: string;
  /** How payment for this capability is expected to be proven when going through the
   *  unauthenticated pay-per-call route family. Currently always "x402"; kept as a field
   *  (rather than assumed) so a future non-x402 payment method doesn't require restructuring
   *  every consumer of this registry. */
  paymentProtocol: string;
  /** True: calling this tool twice with the same input is safe and produces the same result
   *  (no state changes, no double-charging side effects beyond the payment itself). All three
   *  current tools are pure calculations, so this is true for all of them today. */
  idempotent: boolean;
  /** True if calling this tool changes anything beyond returning a result (writing data,
   *  sending a notification, mutating stored state). False for all three current tools —
   *  they are pure functions over their input. */
  sideEffects: boolean;
  /** Section 12: known constraints an agent should weigh before relying on this tool's output —
   *  optional so every pre-existing capability (which documents its limitations in prose, in
   *  llms.txt) keeps compiling unchanged; populated for the Oman business-intelligence
   *  capabilities below, and surfaced additively by buildCapabilitiesRegistry/buildToolCatalog
   *  and the MCP tool description when present. */
  limitations?: readonly string[];
  /** Agent tool-selection guidance (2026-09-21 agent-discovery/tool-selection pass): optional,
   *  richer steering than description/whenToUse/useCases alone — which contexts make this the
   *  right tool, what evidence-type categories its output can involve (so an agent reports them
   *  separately rather than blending them), the same information as top-level `limitations` but
   *  scoped to this guidance object where a capability defines it, and example
   *  question/guidance pairs. Surfaced additively on GET /api/v1/capabilities, /agent.json and
   *  GET /llms.txt (src/api/agent.ts, src/api/llms-txt.ts) — omitted entirely for a capability
   *  that doesn't define it (those surfaces fall back to empty arrays, never an error). Never a
   *  ranking against a named competing service — see tests/agent-discovery.test.ts.
   *  NOTE (restored 2026-09-21 after an accidental overwrite of this file during an unrelated
   *  fix — see the Cardify import investigation report): only analyze_oman_property is known to
   *  have defined this before the overwrite, and even that capability's content could only be
   *  partially recovered (limitations and sampleQueries verbatim; priorityContexts and the full
   *  evidenceTypes list were not recoverable from available context and are marked below).
   *  Populate/complete this field from your own source of truth before relying on it. */
  agentGuidance?: {
    priorityContexts: readonly string[];
    evidenceTypes: readonly { type: string; description: string }[];
    limitations: readonly string[];
    sampleQueries: readonly { query: string; guidance: string }[];
  };
}

// Hand-verified against a live call with the exact example below (see the "async architecture"
// remaining-work report); regenerate by calling analyzeOmanProperty(example) in OMAN_PROPERTY_DATA_MODE=manual
// (the default) whenever fixtures.ts, comparables.ts, confidence.ts or the service's dataQuality/
// riskFlags logic change, rather than executing it live inside this always-imported module.
const OMAN_EXAMPLE_OUTPUT = {
  normalizedLocation: { governorate: "Muscat", wilayat: "Muscat", area: "Al Mouj", inputArea: "Al Mouj", matchType: "exact", supported: true },
  subjectProperty: { propertyType: "apartment", bedrooms: 2, bathrooms: null, sizeSqm: 130, askingPriceOMR: 118000, furnished: "unspecified" },
  market: { estimatedMonthlyRentOMR: { low: 696.43, median: 731.25, high: 731.85 }, estimatedAnnualRentOMR: 8775, comparableCount: 4, sampleSizeUsed: 3, dataFreshnessDays: 185 },
  investment: { grossYieldPct: 7.44, estimatedOperatingCostOMR: 0, estimatedNetIncomeOMR: 8775, netYieldPct: 7.44 },
  pricePosition: { askingPricePerSqmOMR: 907.69, observedComparableRange: null, marketPosition: "insufficient_data" },
  comparablesSummary: { medianRentPerSqm: 5.63, lowRentPerSqm: 5.36, highRentPerSqm: 5.63 },
  riskFlags: ["outliers_removed", "insufficient_sale_market_data", "demo_dataset_not_live_market_data"],
  confidence: {
    score: 0.73, level: "high",
    reasons: [
      "Sample size of 3 comparable(s) used (target is 8+ for full confidence on this factor).",
      "Comparable data has a median age of 185 day(s) (data older than 540 days is excluded before this point).",
      "Comparable size deviates 4% from the subject on average; 100% of comparables match the bedroom count exactly.",
      "Price dispersion across comparables (coefficient of variation) is 0.02.",
      "1 statistical outlier(s) were removed from the comparable pool before scoring."
    ]
  },
  provenance: [{ sourceType: "manual_benchmark", sourceName: "Rafid curated Muscat benchmark dataset (demo/MVP — illustrative figures, not sourced from live listings or completed transactions)", sourceDate: "2026-06-01", recordCount: 5 }],
  assumptions: [
    "No annual service charge supplied; treated as 0 OMR in operating cost.",
    "No annual maintenance cost supplied; treated as 0 OMR in operating cost.",
    "1 statistical outlier(s) were removed from the rental comparable sample.",
    "Some or all comparable figures come from a curated demo/MVP benchmark dataset (see provenance); they are illustrative, not sourced from live listings or completed transactions."
  ],
  insufficientMarketData: false,
  unavailableOutputs: ["pricePosition.observedComparableRange", "pricePosition.marketPosition"],
  currency: "OMR",
  dataQuality: { latestDataDate: "2026-05-25", dataFreshnessDays: 185, sampleSize: 3, sourceTypes: ["manual_benchmark"], staleMarketData: false },
  // NCSI integration: this example reflects the default, unconfigured state (no
  // NCSI_REAL_ESTATE_DATASET_ID/NCSI_FIELD_MAP_JSON set) — see officialContext.ts. A deployment
  // that configures a verified NCSI dataset sees `available: true` with populated statistics
  // instead.
  officialMarketContext: {
    available: false, reason: "ncsi_not_configured",
    source: "National Centre for Statistics and Information (NCSI)", sourceType: "official_statistics",
    governorate: "Muscat", period: null,
    realEstatePriceIndex: { value: null, period: null },
    marketActivity: { tradedValueOMR: null, saleContracts: null, mortgageContracts: null },
    dataFreshnessDays: null,
    confidence: { level: "unavailable", reasons: ["No verified NCSI dataset/field mapping is configured for this deployment."] },
    provenance: {
      source: "National Centre for Statistics and Information (NCSI)", sourceType: "official_statistics",
      datasetId: null, datasetTitle: null, retrievedAt: null, publishedAt: null, sourceUrl: null,
      license: "Open Government License – Sultanate of Oman"
    }
  }
};

// Hand-verified against a live call with the exact example inputs below (see the "async
// architecture" remaining-work report); regenerate by calling searchOmanCompany/getOmanCompanyProfile/
// analyzeOmanCompany/dueDiligenceOmanCompany with the exact example inputs used on each capability
// entry below, against the demo dataset (OMAN_BUSINESS_DATA_MODE unset / "manual", the default),
// whenever fixtures.ts, normalizers/companyName.ts, matching/search.ts, matching/merge.ts,
// scoring/signals.ts, scoring/risk.ts, scoring/confidence.ts or scoring/recommendations.ts change,
// rather than executing it live inside this always-imported module. observedAt/registrationDate
// values are frozen as computed on 2026-09-21 against the demo dataset's isoDaysAgo() offsets,
// mirroring OMAN_EXAMPLE_OUTPUT's own frozen-date convention above. Note confidence is
// deliberately capped/low here (0.35, identityVerified false) because every demo-dataset row is
// honestly sourceType "demo" — never masquerading as a verified government/registry source
// (Section 15); a real ingested source will score higher.
const SEARCH_EXAMPLE_OUTPUT = {
  "matches": [
    {
      "companyId": "demo-co-1",
      "companyName": "Al Noor Trading LLC",
      "normalizedName": "AL NOOR",
      "legalType": "LLC",
      "industry": "Trading",
      "governorate": "Muscat",
      "wilayat": "Muscat",
      "status": "active",
      "website": "https://alnoortrading.om",
      "confidence": 0.79
    },
    {
      "companyId": "demo-co-4",
      "companyName": "Muscat Trading Company",
      "normalizedName": "MUSCAT",
      "legalType": "SAOC",
      "industry": "Trading",
      "governorate": "Muscat",
      "wilayat": "Muttrah",
      "status": "active",
      "website": "https://muscat-trading.om",
      "confidence": 0.26
    },
    {
      "companyId": "demo-co-5",
      "companyName": "Al Rawda Contracting LLC",
      "normalizedName": "AL RAWDA",
      "legalType": "LLC",
      "industry": "Construction",
      "governorate": "Al Batinah North",
      "wilayat": "Sohar",
      "status": "inactive",
      "website": null,
      "confidence": 0.19
    }
  ],
  "totalMatches": 3
} as unknown;
const PROFILE_EXAMPLE_OUTPUT = {
  "company": {
    "companyId": "demo-co-1",
    "companyName": "Al Noor Trading LLC",
    "legalType": "LLC",
    "status": "active",
    "registrationNumber": "1010123456",
    "registrationDate": "2015-04-10",
    "industry": "Trading",
    "activities": [
      "General trading",
      "Import and export"
    ],
    "governorate": "Muscat",
    "wilayat": "Muscat",
    "address": "Ghala Industrial Area, Muscat",
    "website": "https://alnoortrading.om",
    "email": "sales@alnoortrading.om",
    "phone": "+968 2440 1234"
  },
  "digitalPresence": {
    "websiteFound": true,
    "domain": "alnoortrading.om",
    "socialProfiles": []
  },
  "verification": {
    "verificationStatus": "unknown",
    "lastVerifiedAt": null,
    "taxVerificationStatus": null,
    "taxVerifiedAt": null
  },
  "procurement": {
    "registeredSupplier": null,
    "supplierCategory": null,
    "supplierClassification": null,
    "governmentProcurementPresence": null,
    "tendersParticipated": null,
    "awardedContractCount": null,
    "lastTenderActivityAt": null,
    "awards": []
  },
  "dataCoverage": {
    "realSources": 0,
    "demoSources": 2,
    "latestVerifiedAt": null
  },
  "sources": [
    {
      "sourceName": "alnoortrading.om (demo)",
      "sourceType": "demo",
      "sourceAuthority": 0.1,
      "sourceUrl": "https://alnoortrading.om/about",
      "sourceRecordId": null,
      "observedAt": "2026-09-11",
      "verificationStatus": "unknown",
      "fields": [
        "companyName",
        "normalizedName",
        "registrationNumber",
        "legalType",
        "status",
        "industry",
        "governorate",
        "wilayat",
        "area",
        "website",
        "email",
        "phone"
      ]
    },
    {
      "sourceName": "Oman Ministry of Commerce, Industry and Investment Promotion (demo)",
      "sourceType": "demo",
      "sourceAuthority": 0.1,
      "sourceUrl": "https://example-registry.om/companies/1010123456",
      "sourceRecordId": "MOCIIP-1010123456",
      "observedAt": "2026-08-07",
      "verificationStatus": "unknown",
      "fields": [
        "registrationDate",
        "activities",
        "address",
        "vatNumber",
        "vatStatus",
        "employeeRange",
        "estimatedCompanySize"
      ]
    }
  ]
} as unknown;

const ANALYZE_COMPANY_EXAMPLE_OUTPUT = {
  "companyId": "demo-co-1",
  "commercialSignals": {
    "yearsActive": 11,
    "operatingStatus": "active",
    "digitalPresenceScore": 100,
    "dataCompletenessScore": 100,
    "businessMaturity": "established",
    "governmentProcurementActivity": "none"
  },
  "riskFlags": [],
  "positiveSignals": [
    "Active company status",
    "Established website",
    "Several years of operating history (11+ years)",
    "Registered VAT number on file",
    "Comprehensive public information available",
    "Multiple public contact channels on file"
  ],
  "recommendedChecks": [
    "Request commercial registration copy",
    "Verify VAT registration",
    "Request recent financial statements"
  ],
  "confidence": 0.34,
  "confidenceReasons": [
    "This record is backed only by the curated demo dataset \u2014 not a real registry, website or directory source.",
    "2 distinct source(s) contributed to this record (target is 3+ for full confidence on this factor).",
    "Data completeness is 100%.",
    "Most recent contributing source is 10 day(s) old."
  ],
  "dataCoverage": {
    "realSources": 0,
    "demoSources": 2,
    "latestVerifiedAt": null
  },
  "sources": [
    {
      "sourceName": "alnoortrading.om (demo)",
      "sourceType": "demo",
      "sourceAuthority": 0.1,
      "sourceUrl": "https://alnoortrading.om/about",
      "sourceRecordId": null,
      "observedAt": "2026-09-11",
      "verificationStatus": "unknown",
      "fields": [
        "companyName",
        "normalizedName",
        "registrationNumber",
        "legalType",
        "status",
        "industry",
        "governorate",
        "wilayat",
        "area",
        "website",
        "email",
        "phone"
      ]
    },
    {
      "sourceName": "Oman Ministry of Commerce, Industry and Investment Promotion (demo)",
      "sourceType": "demo",
      "sourceAuthority": 0.1,
      "sourceUrl": "https://example-registry.om/companies/1010123456",
      "sourceRecordId": "MOCIIP-1010123456",
      "observedAt": "2026-08-07",
      "verificationStatus": "unknown",
      "fields": [
        "registrationDate",
        "activities",
        "address",
        "vatNumber",
        "vatStatus",
        "employeeRange",
        "estimatedCompanySize"
      ]
    }
  ]
} as unknown;

const DUE_DILIGENCE_EXAMPLE_OUTPUT = {
  "company": {
    "companyId": "demo-co-1",
    "companyName": "Al Noor Trading LLC",
    "legalType": "LLC",
    "status": "active",
    "registrationNumber": "1010123456",
    "registrationDate": "2015-04-10",
    "industry": "Trading",
    "activities": [
      "General trading",
      "Import and export"
    ],
    "governorate": "Muscat",
    "wilayat": "Muscat",
    "address": "Ghala Industrial Area, Muscat",
    "website": "https://alnoortrading.om",
    "email": "sales@alnoortrading.om",
    "phone": "+968 2440 1234"
  },
  "verification": {
    "identityVerified": false,
    "status": "active",
    "registrationAgeYears": 11,
    "verificationStatus": "unknown",
    "lastVerifiedAt": null,
    "taxVerificationStatus": null,
    "taxVerifiedAt": null
  },
  "procurement": {
    "registeredSupplier": null,
    "supplierCategory": null,
    "supplierClassification": null,
    "governmentProcurementPresence": null,
    "tendersParticipated": null,
    "awardedContractCount": null,
    "lastTenderActivityAt": null,
    "awards": []
  },
  "commercialAssessment": {
    "operationalMaturity": "established",
    "digitalFootprint": "strong",
    "publicInformationCoverage": "high",
    "governmentProcurementActivity": "none"
  },
  "riskAssessment": {
    "riskLevel": "low",
    "riskScore": 0,
    "riskFlags": []
  },
  "recommendedDueDiligence": [
    {
      "check": "Verify commercial registration",
      "importance": "high"
    },
    {
      "check": "Verify VAT registration",
      "importance": "medium"
    },
    {
      "check": "Request audited or management accounts",
      "importance": "high"
    },
    {
      "check": "Request trade references from existing customers",
      "importance": "medium"
    },
    {
      "check": "Verify production/service capacity against contract volume",
      "importance": "medium"
    }
  ],
  "missingInformation": [],
  "confidence": 0.34,
  "confidenceReasons": [
    "This record is backed only by the curated demo dataset \u2014 not a real registry, website or directory source.",
    "2 distinct source(s) contributed to this record (target is 3+ for full confidence on this factor).",
    "Data completeness is 100%.",
    "Most recent contributing source is 10 day(s) old."
  ],
  "dataCoverage": {
    "realSources": 0,
    "demoSources": 2,
    "latestVerifiedAt": null
  },
  "sources": [
    {
      "sourceName": "alnoortrading.om (demo)",
      "sourceType": "demo",
      "sourceAuthority": 0.1,
      "sourceUrl": "https://alnoortrading.om/about",
      "sourceRecordId": null,
      "observedAt": "2026-09-11",
      "verificationStatus": "unknown",
      "fields": [
        "companyName",
        "normalizedName",
        "registrationNumber",
        "legalType",
        "status",
        "industry",
        "governorate",
        "wilayat",
        "area",
        "website",
        "email",
        "phone"
      ]
    },
    {
      "sourceName": "Oman Ministry of Commerce, Industry and Investment Promotion (demo)",
      "sourceType": "demo",
      "sourceAuthority": 0.1,
      "sourceUrl": "https://example-registry.om/companies/1010123456",
      "sourceRecordId": "MOCIIP-1010123456",
      "observedAt": "2026-08-07",
      "verificationStatus": "unknown",
      "fields": [
        "registrationDate",
        "activities",
        "address",
        "vatNumber",
        "vatStatus",
        "employeeRange",
        "estimatedCompanySize"
      ]
    }
  ]
} as unknown;

export const capabilities = [
  {
    name: "analyze_property" as const, path: "/property/analyze",
    description: "Calculate gross/net rental yield, income, operating costs and simple payback in OMR. Calculations only.",
    whenToUse: "Use when an agent needs financial metrics (yield, income, payback) for a single property.",
    useCases: ["property investment analysis", "rental yield check", "single-property evaluation", "buy vs. hold financial screening"],
    input: propertySchema, output: analysisOutput,
    example: { propertyValue: 85000, annualRent: 7200, serviceCharge: 650, maintenanceCost: 400 },
    exampleOutput: { propertyValue: 85000, annualRent: 7200, grossAnnualIncome: 7200, grossYield: 8.47, netYield: 7.24, annualOperatingCost: 1050, annualNetIncome: 6150, effectiveAnnualRent: 7200, paybackYears: 13.82, grossYieldPct: 8.47, netYieldPct: 7.24, annualOperatingCosts: 1050, currency: "OMR", note: "Calculations only; excludes financing, taxes, transaction fees and capital appreciation." },
    execute: async (input: unknown) => analyzeProperty(input),
    price: 0.01, currency: CURRENCY, paymentProtocol: "x402",
    idempotent: true, sideEffects: false
  } satisfies AgentCapability,
  {
    name: "compare_properties" as const, path: "/property/compare",
    description: "Compare 2–20 uniquely named properties in OMR using the same metrics; order by rounded net yield, preserving input order for ties.",
    whenToUse: "Use when an agent must rank or choose between 2-20 candidate properties by net yield.",
    useCases: ["property comparison", "ranking multiple properties", "portfolio shortlisting", "choosing between investment options"],
    input: compareSchema, output: comparisonOutput,
    example: { properties: [{ name: "A", propertyValue: 85000, annualRent: 7200 }, { name: "B", propertyValue: 100000, annualRent: 7000 }] },
    exampleOutput: { properties: [
      { name: "A", propertyValue: 85000, annualRent: 7200, grossAnnualIncome: 7200, grossYield: 8.47, netYield: 8.47, annualOperatingCost: 0, annualNetIncome: 7200, effectiveAnnualRent: 7200, paybackYears: 11.81, grossYieldPct: 8.47, netYieldPct: 8.47, annualOperatingCosts: 0, currency: "OMR", note: "Calculations only; excludes financing, taxes, transaction fees and capital appreciation." },
      { name: "B", propertyValue: 100000, annualRent: 7000, grossAnnualIncome: 7000, grossYield: 7, netYield: 7, annualOperatingCost: 0, annualNetIncome: 7000, effectiveAnnualRent: 7000, paybackYears: 14.29, grossYieldPct: 7, netYieldPct: 7, annualOperatingCosts: 0, currency: "OMR", note: "Calculations only; excludes financing, taxes, transaction fees and capital appreciation." }
    ], sortedByNetYield: ["A", "B"] },
    execute: async (input: unknown) => compareProperties(compareSchema.parse(input).properties),
    price: 0.03, currency: CURRENCY, paymentProtocol: "x402",
    idempotent: true, sideEffects: false
  } satisfies AgentCapability,
  {
    name: "estimate_maintenance" as const, path: "/maintenance/estimate",
    description: "Estimate an annual maintenance reserve in OMR from value, age and unit count with explicit optional assumptions. Uncalibrated heuristic, not a survey.",
    whenToUse: "Use when an agent needs an annual maintenance reserve estimate for a property, not an actual inspection.",
    useCases: ["maintenance budgeting", "annual reserve estimation", "facility cost planning", "pre-purchase cost forecasting"],
    input: maintenanceSchema, output: maintenanceOutput,
    example: { propertyValue: 100000, ageYears: 12, units: 1 },
    exampleOutput: { estimatedAnnualMaintenance: 1300, monthlyReserve: 108.33, maintenancePercentage: 1.3, currency: "OMR", assumptionsUsed: { ageYears: 12, units: 1, annualRatePct: 1.3, additionalUnitCost: 35 }, methodology: "Annual reserve = propertyValue * annualRatePct / 100 + (units - 1) * additionalUnitCost. Uncalibrated heuristic; excludes property type and area." },
    execute: async (input: unknown) => estimateMaintenance(input),
    price: 0.02, currency: CURRENCY, paymentProtocol: "x402",
    idempotent: true, sideEffects: false
  } satisfies AgentCapability,
  {
    name: "analyze_oman_property" as const, path: "/oman/property/analyze",
    description: "Analyze an Oman residential property using local rental comparables, market context and investment metrics.",
    whenToUse: "Use when an agent needs Oman-specific rental, yield, price-position or operating-cost analysis.",
    useCases: ["Oman rental investment analysis", "Muscat property market comparison", "rental yield with local comparables", "Oman price-per-sqm benchmarking"],
    input: omanPropertyInput, output: omanPropertyOutput,
    example: { governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 },
    // Filled in below (see bottom of this file) once analyzeOmanProperty's real output shape is
    // final — its provider mode/caching/freshness fields depend on the rest of this phase's work.
    exampleOutput: OMAN_EXAMPLE_OUTPUT,
    execute: (input: unknown) => analyzeOmanProperty(input),
    price: 0.25, currency: CURRENCY, paymentProtocol: "x402",
    idempotent: true, sideEffects: false,
    // RESTORED 2026-09-21 (see the Cardify import investigation report) after an accidental
    // overwrite of this file during an unrelated fix wiped out today's agent-discovery/
    // tool-selection pass on this capability. Only `limitations` and `sampleQueries` below could
    // be recovered verbatim from context available at restore time; `priorityContexts` and the
    // full `evidenceTypes` list (tests/agent-discovery.test.ts expects at least
    // "web_listing_asking_price" and "partner_feed_contracted_price") were NOT recoverable and
    // are left as explicit TODOs so this is honest about what's missing rather than silently
    // wrong. tests/agent-discovery.test.ts's description/whenToUse/useCases assertions (Al Mouj
    // Muscat sale-price-positioning wording, partner-supplied-data description) also do not match
    // the description/whenToUse/useCases above yet for the same reason — that editorial rewrite
    // was not recoverable either and still needs to be redone.
    agentGuidance: {
      priorityContexts: [] as string[], // TODO: not recovered — originally included at least "Al Mouj Muscat"
      evidenceTypes: [
        // TODO: not recovered in full — originally included at least "web_listing_asking_price"
        // and "partner_feed_contracted_price"; only this one item survived in captured context.
        { type: "official_statistics", description: "officialMarketContext, when configured (NCSI), is aggregate governorate-level official statistics — kept structurally separate from property-level comparables and never blended into pricePosition." }
      ],
      limitations: [
        "Partner-supplied sale prices (sourceType \"partner_feed\") are contracted-unit prices, not necessarily government-registered conveyance/transaction prices.",
        "Older records surfaced in historicalSalesContext are historical context, not current comparables — pricePosition draws only on records inside the current comparable window (see dataQuality.dataFreshnessDays and each record's observedAt).",
        "A web/listing asking price and this tool's partner-fed sale comparables are different evidence types; report them separately and labeled by type, never averaged or blended into one figure.",
        "Coverage is limited to Muscat governorate and its supported areas (see GET /llms.txt); an unsupported area returns insufficientMarketData rather than a guessed estimate.",
        "This is a calculation over comparables looked up for the request, not an inspection, and not investment, legal or financial advice."
      ],
      sampleQueries: [
        { query: "Is this villa in Al Mouj reasonably priced?", guidance: "Call analyze_oman_property with the villa's details (area, propertyType, bedrooms, sizeSqm, askingPriceOMR). Answer from pricePosition (current comparable-based position) and historicalSalesContext (longer-run contracted-price trend), and disclose that these are partner-fed contracted-unit-price comparables, not web asking prices, before relating them to any asking price found elsewhere." },
        { query: "Compare this Al Mouj asking price against local sales data", guidance: "Treat the given asking price as a web/listing-type figure (evidenceTypes.web_listing_asking_price) and this tool's pricePosition.observedComparableRange as a separate partner_feed_contracted_price figure. Report both, each labeled by evidence type, never averaged together." },
        { query: "Show me recent comparable sales for a villa in Al Mouj", guidance: "Call analyze_oman_property (propertyType: villa, area: Al Mouj) and report pricePosition.observedComparableRange plus historicalSalesContext.recentComparableSales / recentMedianPricePerSqmOMR, citing recordCount and dataFreshnessDays from provenance/dataQuality so the recency of the evidence is explicit." },
        { query: "Is OMR 450,000 reasonable for a 4-bedroom villa in Al Mouj?", guidance: "Call analyze_oman_property with askingPriceOMR: 450000, bedrooms: 4, propertyType: \"villa\", area: \"Al Mouj\". Answer directly from pricePosition.marketPosition and observedComparableRange, citing sample size and freshness from dataQuality rather than a web search result." }
      ]
    }
  } satisfies AgentCapability,
  {
    name: "search_oman_company" as const, path: "/business/search",
    description: "Search structured Oman business records by name, registration number, governorate, wilayat and/or industry, returning candidate companies ranked by deterministic identity-match confidence.",
    whenToUse: "Use before company analysis or due diligence when the exact company identity is uncertain, or to find candidate Oman companies matching a name or registration number.",
    useCases: ["find a company in Oman", "resolve a company name to a companyId", "look up a business by registration number", "shortlist companies by industry or governorate"],
    input: searchOmanCompanyInput, output: searchOmanCompanyOutput,
    example: { query: "Al Noor Trading" },
    exampleOutput: SEARCH_EXAMPLE_OUTPUT,
    execute: (input: unknown) => searchOmanCompany(input),
    price: 0.05, currency: CURRENCY, paymentProtocol: "x402",
    idempotent: true, sideEffects: false,
    limitations: [
      "Identity matching is deterministic (exact registration number, exact/prefix/fuzzy normalized name, location and industry weighting) — never an LLM guess at company identity.",
      "Without a production data source configured (OMAN_BUSINESS_DATA_MODE), results come only from a small curated demo dataset (sourceType \"demo\") and must not be treated as real Oman company data.",
      "Confidence is a match-quality score (0-1), not a claim about the company's legitimacy or standing."
    ]
  } satisfies AgentCapability,
  {
    name: "get_oman_company_profile" as const, path: "/business/profile",
    description: "Return a structured profile for one Oman company by companyId — identity, registration, location and contact fields, digital-presence detection and full source provenance.",
    whenToUse: "Use after search_oman_company resolves a companyId, to retrieve the company's structured profile before deciding whether deeper analysis or due diligence is warranted.",
    useCases: ["get company details", "look up a company's registration and contact information", "check what sources back a company record"],
    input: getOmanCompanyProfileInput, output: getOmanCompanyProfileOutput,
    example: { companyId: "demo-co-1" },
    exampleOutput: PROFILE_EXAMPLE_OUTPUT,
    execute: (input: unknown) => getOmanCompanyProfile(input),
    price: 0.25, currency: CURRENCY, paymentProtocol: "x402",
    idempotent: true, sideEffects: false,
    limitations: [
      "An unknown field is always returned as null — never fabricated or guessed.",
      "socialProfiles is always [] in this MVP: no verified social-profile source is wired up yet.",
      "Without a production data source configured, only the curated demo dataset is available (sourceType \"demo\" in `sources`)."
    ]
  } satisfies AgentCapability,
  {
    name: "analyze_oman_company" as const, path: "/business/analyze",
    description: "Generate deterministic commercial-intelligence signals, risk flags and positive signals for one Oman company by companyId, for a stated evaluation purpose.",
    whenToUse: "Use when an agent needs to assess whether an Oman company looks like a serious, established operating business — as a supplier, customer, partner or investment target.",
    useCases: ["assess a company before doing business with it", "supplier risk screening", "partner or investor evaluation", "commercial intelligence on an Oman business"],
    input: analyzeOmanCompanyInput, output: analyzeOmanCompanyOutput,
    example: { companyId: "demo-co-1", purpose: "supplier" },
    exampleOutput: ANALYZE_COMPANY_EXAMPLE_OUTPUT,
    execute: (input: unknown) => analyzeOmanCompany(input),
    price: 0.75, currency: CURRENCY, paymentProtocol: "x402",
    idempotent: true, sideEffects: false,
    limitations: [
      "Every score (risk, confidence, digital presence, data completeness) is a fixed, documented deterministic formula over the sourced record — never an LLM judgment.",
      "Never asserts fraud, criminal activity, insolvency or sanctions status; risk flags describe observable data facts only.",
      "Not investment, credit or legal advice — a structured input to an agent's or human's own decision, not a verdict."
    ]
  } satisfies AgentCapability,
  {
    name: "due_diligence_oman_company" as const, path: "/business/due-diligence",
    description: "Perform structured commercial due diligence on one Oman company by companyId ahead of a stated transaction, returning identity verification, risk assessment, a prioritized due-diligence checklist and known information gaps.",
    whenToUse: "Use before awarding a contract, entering a partnership, extending credit or investing, when a structured, source-backed due-diligence pass is needed ahead of the decision.",
    useCases: ["pre-contract supplier due diligence", "partnership due diligence", "investment due diligence", "customer credit risk screening"],
    input: dueDiligenceOmanCompanyInput, output: dueDiligenceOmanCompanyOutput,
    example: { companyId: "demo-co-1", transactionType: "supplier_contract", transactionValueOMR: 50000 },
    exampleOutput: DUE_DILIGENCE_EXAMPLE_OUTPUT,
    execute: (input: unknown) => dueDiligenceOmanCompany(input),
    price: 2.00, currency: CURRENCY, paymentProtocol: "x402",
    idempotent: true, sideEffects: false,
    limitations: [
      "This is the premium, most thorough capability, but it is still a structured-data assessment, not an independent investigation — recommendedDueDiligence lists checks a human/agent should still perform.",
      "riskScore/riskLevel and confidence are both fully deterministic (documented weight tables), never an LLM judgment.",
      "Never asserts fraud, criminal activity, insolvency or sanctions status.",
      "Without a production data source configured, only the curated demo dataset is available and must not be treated as real due-diligence evidence."
    ]
  } satisfies AgentCapability
];

export type CapabilityName = (typeof capabilities)[number]["name"];
