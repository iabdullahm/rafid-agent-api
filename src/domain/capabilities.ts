import { propertySchema, compareSchema, maintenanceSchema } from "../schemas/inputs.js";
import { analysisOutput, comparisonOutput, maintenanceOutput } from "../schemas/outputs.js";
import { analyzeProperty, compareProperties, estimateMaintenance } from "../services/property.js";
import { omanPropertyInput } from "../schemas/omanInputs.js";
import { omanPropertyOutput } from "../schemas/omanOutputs.js";
import { analyzeOmanProperty } from "../services/omanProperty.js";
import { searchOmanCompanyInput, getOmanCompanyProfileInput, analyzeOmanCompanyInput, dueDiligenceOmanCompanyInput } from "../schemas/businessInputs.js";
import { searchOmanCompanyOutput, getOmanCompanyProfileOutput, analyzeOmanCompanyOutput, dueDiligenceOmanCompanyOutput } from "../schemas/businessOutputs.js";
import { searchOmanCompany, getOmanCompanyProfile, analyzeOmanCompany, dueDiligenceOmanCompany } from "../services/omanBusiness.js";
import { researchCompanyInput, findCompaniesInput, analyzeCompanyRiskInput } from "../schemas/intelligenceInputs.js";
import { researchCompanyOutput, findCompaniesOutput, analyzeCompanyRiskOutput } from "../schemas/intelligenceOutputs.js";
import { researchCompany, findCompanies, analyzeCompanyRisk } from "../services/companyIntelligence.js";
import { omanSupplierCheckInput } from "../schemas/supplierCheckInputs.js";
import { omanSupplierCheckOutput } from "../schemas/supplierCheckOutputs.js";
import { omanSupplierCheck } from "../services/omanSupplierCheck.js";
import { OMAN_SUPPLIER_CHECK_EXAMPLE_OUTPUT } from "./examples/omanSupplierCheckExample.js";
import { companyReputationCheckInput } from "../schemas/companyReputationInputs.js";
import { companyReputationCheckOutput } from "../schemas/companyReputationOutputs.js";
import { companyReputationCheck } from "../services/companyReputationCheck.js";
import { COMPANY_REPUTATION_CHECK_EXAMPLE_OUTPUT } from "./examples/companyReputationCheckExample.js";
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
  /** Optional machine-readable category (e.g. "risk_intelligence"), surfaced additively on
   *  GET /api/v1/capabilities and /agent.json. */
  category?: string;
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

// Section: "Rafid Agent Intelligence" expansion, Phase 1. Every one of these three examples is
// evaluated with NO web-search or LLM provider configured (WEB_SEARCH_PROVIDER/
// INTELLIGENCE_LLM_PROVIDER unset — the default for a fresh deployment and for `npm test`'s
// generic per-capability loops) so the exampleOutput below is the honest, deterministic
// "not_configured" shape — never a fabricated live-looking result. Regenerate by calling
// researchCompany/findCompanies/analyzeCompanyRisk with the exact example inputs below, with no
// intelligence env vars set, whenever intelligence/companyResearch/provider.ts,
// intelligence/companyDiscovery/provider.ts or intelligence/risk/provider.ts change.
const RESEARCH_COMPANY_EXAMPLE_OUTPUT = {
  company: { name: "Acme Corporation", website: "https://acme.example.com", industry: null, headquarters: null, founded: null },
  overview: null,
  productsAndServices: [],
  leadership: [],
  funding: { summary: null, knownRounds: [] },
  competitors: [],
  technologySignals: [],
  recentDevelopments: [],
  riskFlags: [],
  sources: [],
  confidence: 0,
  dataFreshness: { latestSourceDate: null, freshnessDays: null },
  cached: false,
  dataMode: "not_configured",
  limitations: [
    "No web search provider is configured for this deployment (WEB_SEARCH_PROVIDER is not set) — no external research was performed.",
    "This result is derived from public web search results, not verified company records or a direct company disclosure.",
    "Coverage depends on what is publicly indexed and searchable — a real, established company with limited public web presence will correctly return sparse results, not a false negative about its existence."
  ]
} as unknown;

const FIND_COMPANIES_EXAMPLE_OUTPUT = {
  companies: [],
  resultCount: 0,
  sources: [],
  confidence: 0,
  cached: false,
  dataMode: "not_configured",
  requestedLimit: 10,
  appliedLimit: 0,
  limitations: [
    "No web search provider is configured for this deployment (WEB_SEARCH_PROVIDER is not set) — no discovery search was performed.",
    "Company discovery is based on public web search coverage — it cannot guarantee completeness, especially for small, private, or newly founded companies with limited public presence.",
    "A company not appearing in these results is not evidence that it doesn't exist or doesn't match the criteria — only that it wasn't found by this search."
  ]
} as unknown;

const ANALYZE_COMPANY_RISK_EXAMPLE_OUTPUT = {
  company: { name: "Acme Corporation", website: "https://acme.example.com", country: null },
  riskSignals: [
    {
      type: "corporate_identity", severity: "low",
      summary: "No confident match was found in Rafid's Oman company registry data.",
      evidence: [{ description: "No Oman registry match above the confidence threshold.", source: null, tier: "missing_information" }],
      source: null
    }
  ],
  checks: {
    corporateIdentity: { status: "performed", summary: "No confident match was found in Rafid's Oman company registry data.", findings: ["This check only covers Oman-registered companies known to Rafid; a company outside Oman, or one not yet covered, will correctly show no match here."], evidence: [{ description: "No Oman registry match above the confidence threshold.", source: null, tier: "missing_information" }] },
    domain: { status: "not_configured", summary: "Live checks are not enabled for this deployment (RISK_LIVE_CHECKS_ENABLED is not true).", findings: [], evidence: [] },
    website: { status: "not_configured", summary: "Live checks are not enabled for this deployment (RISK_LIVE_CHECKS_ENABLED is not true).", findings: [], evidence: [] },
    sanctions: { status: "not_configured", summary: "Live checks are not enabled for this deployment (RISK_LIVE_CHECKS_ENABLED is not true).", findings: [], evidence: [] },
    adverseNews: { status: "not_configured", summary: "No web search provider is configured for this deployment.", findings: [], evidence: [] },
    securitySignals: { status: "not_configured", summary: "Live checks are not enabled for this deployment (RISK_LIVE_CHECKS_ENABLED is not true).", findings: [], evidence: [] },
    reputation: { status: "not_configured", summary: "No web search provider is configured for this deployment.", findings: [], evidence: [] },
    legalSignals: { status: "not_configured", summary: "No web search provider is configured for this deployment.", findings: [], evidence: [] }
  },
  sources: [],
  confidence: 0.13,
  limitations: [
    "Sanctions screening (when enabled) is an automated name-matching indicator only and does not constitute a legal sanctions determination — verify directly against the source list before acting.",
    "Adverse news, reputation and legal-signal findings are search results, not confirmed facts — each must be reviewed at its source.",
    "This tool never returns a safe/unsafe verdict; it returns evidence for the calling agent or a human to weigh.",
    "Corporate identity verification only covers Oman-registered companies known to Rafid; a company elsewhere, or not yet covered, correctly shows no match rather than a false negative.",
    "domain: Live checks are not enabled for this deployment (RISK_LIVE_CHECKS_ENABLED is not true).",
    "website: Live checks are not enabled for this deployment (RISK_LIVE_CHECKS_ENABLED is not true).",
    "sanctions: Live checks are not enabled for this deployment (RISK_LIVE_CHECKS_ENABLED is not true).",
    "adverse_news: No web search provider is configured for this deployment.",
    "reputation: No web search provider is configured for this deployment.",
    "legal_signals: No web search provider is configured for this deployment.",
    "security_signals: Live checks are not enabled for this deployment (RISK_LIVE_CHECKS_ENABLED is not true)."
  ],
  cached: false,
  dataMode: "live"
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
  } satisfies AgentCapability,
  // ---------------------------------------------------------------------------------------------
  // "Rafid Agent Intelligence" expansion, Phase 1 (research_company, find_companies,
  // analyze_company_risk). Section "Prioritize shipping research_company, find_companies and
  // analyze_company_risk first so they can start generating real x402 usage as soon as possible."
  // Every one of these is entirely inert (no external network call, no cost) until an operator
  // sets WEB_SEARCH_PROVIDER/TAVILY_API_KEY, INTELLIGENCE_LLM_PROVIDER/ANTHROPIC_API_KEY/
  // INTELLIGENCE_LLM_MODEL and/or RISK_LIVE_CHECKS_ENABLED (see intelligence/config.ts) — the
  // existing Oman property/business capabilities above are completely unchanged by this addition.
  // ---------------------------------------------------------------------------------------------
  {
    name: "research_company" as const, path: "/intelligence/research-company",
    description: "Research a company from public web sources: overview, products, leadership, funding, competitors, technology signals, recent developments and risk flags, with cited sources and a confidence score.",
    whenToUse: "Use when an agent needs a structured research brief on a named company — for sales/investment/partnership research, competitive analysis, or general company background — beyond what a structured company registry alone provides.",
    useCases: ["company background research", "sales prospect research", "investment/competitor research", "build a company profile from public web sources"],
    input: researchCompanyInput, output: researchCompanyOutput,
    example: { company: "Acme Corporation", website: "https://acme.example.com", country: "United States", depth: "standard" },
    exampleOutput: RESEARCH_COMPANY_EXAMPLE_OUTPUT,
    execute: (input: unknown) => researchCompany(input),
    price: 0.15, currency: CURRENCY, paymentProtocol: "x402",
    idempotent: true, sideEffects: false,
    limitations: [
      "Every fact is drawn from public web search results, never invented or filled in from the model's own general knowledge — a field is null/empty when the evidence does not state it.",
      "Structured extraction (industry, leadership, funding, competitors, technology signals, recent developments) requires an LLM synthesis provider; without one configured, only raw cited sources are returned.",
      "Coverage depends on what is publicly indexed and searchable — sparse results for a real company reflect limited public web presence, not evidence the company doesn't exist.",
      "Not a substitute for a structured company registry (see search_oman_company/get_oman_company_profile for Oman-specific registry data) or for direct company disclosure/verification."
    ],
    agentGuidance: {
      priorityContexts: ["sales or investment research on a named company", "competitive/market research", "building context on a company before a partnership or transaction decision"],
      evidenceTypes: [
        { type: "web_search", description: "Snippets and metadata from public web search results — never a confirmed company disclosure or filing." },
        { type: "llm_synthesis", description: "Structured fields (leadership, funding, competitors, etc.) synthesized from the web-search evidence by an LLM when one is configured for this deployment; schema-validated before being returned, and null/empty wherever the evidence doesn't support a fact." }
      ],
      limitations: [
        "This is public-web research, not verified company records — always report confidence and dataFreshness alongside any fact drawn from this tool.",
        "riskFlags here are surface-level signals from public sources, not a risk assessment — use analyze_company_risk for evidence-tiered risk signals."
      ],
      sampleQueries: [
        { query: "Give me a quick overview of Acme Corporation before my call with them", guidance: "Call research_company with depth: \"quick\" and report the overview, productsAndServices and recentDevelopments fields, citing sources and noting the confidence score and dataFreshness." },
        { query: "Who are Acme Corporation's main competitors and how are they funded?", guidance: "Call research_company with focusAreas: [\"competitors\",\"funding\"], and report the competitors and funding fields with their sources — never fill in a competitor or funding round the evidence didn't state." }
      ]
    }
  } satisfies AgentCapability,
  {
    name: "find_companies" as const, path: "/intelligence/find-companies",
    description: "Discover companies from public web sources matching an industry, location, size and/or keyword criteria, returning cited candidate companies (never fabricated) with a stated confidence score.",
    whenToUse: "Use when an agent needs to discover a list of candidate companies matching criteria (industry, location, size, keywords) rather than analyze one already-known company.",
    useCases: ["find companies in an industry or location", "build a prospect/lead list", "market landscape scan", "shortlist potential partners or suppliers by criteria"],
    input: findCompaniesInput, output: findCompaniesOutput,
    example: { industry: "renewable energy", country: "Germany", limit: 10 },
    exampleOutput: FIND_COMPANIES_EXAMPLE_OUTPUT,
    execute: (input: unknown) => findCompanies(input),
    price: 0.05, currency: CURRENCY, paymentProtocol: "x402",
    idempotent: true, sideEffects: false,
    limitations: [
      "Every returned company is one actually named in the underlying web search evidence — this tool never invents a company to fill out a requested limit.",
      "Without an LLM synthesis provider configured, no structured company records can safely be extracted from raw search results; only cited raw sources are returned.",
      "Results are capped internally at 20 per request regardless of the requested limit (see requestedLimit vs appliedLimit in the output), to control upstream cost.",
      "Absence from these results is not evidence a matching company doesn't exist — only that this search didn't surface it."
    ]
  } satisfies AgentCapability,
  {
    name: "analyze_company_risk" as const, path: "/intelligence/analyze-company-risk",
    description: "Gather evidence-tiered risk signals for a company across corporate identity, domain, website, sanctions-list name-matching, adverse news, reputation and legal/regulatory signals — never a safe/unsafe verdict.",
    whenToUse: "Use when an agent needs risk evidence to weigh before a transaction, partnership, or onboarding decision — not a substitute for compliance/legal sign-off.",
    useCases: ["pre-transaction risk screening", "vendor/partner risk check", "sanctions name-matching indicator", "adverse media / reputation check"],
    input: analyzeCompanyRiskInput, output: analyzeCompanyRiskOutput,
    example: { company: "Acme Corporation", website: "https://acme.example.com" },
    exampleOutput: ANALYZE_COMPANY_RISK_EXAMPLE_OUTPUT,
    execute: (input: unknown) => analyzeCompanyRisk(input),
    price: 0.35, currency: CURRENCY, paymentProtocol: "x402",
    idempotent: true, sideEffects: false,
    limitations: [
      "This tool never returns a safe/unsafe verdict — it returns evidence, each explicitly tiered (confirmed_evidence / public_allegation / automated_indicator / missing_information), for the calling agent or a human to weigh.",
      "Sanctions screening is an automated name-matching indicator only, never a legal sanctions determination — verify directly against the source list before acting.",
      "Adverse news, reputation and legal-signal findings are search results, not confirmed facts.",
      "Domain/website/sanctions live checks are disabled by default (RISK_LIVE_CHECKS_ENABLED) and adverse-news/reputation/legal-signal checks require a web search provider; corporate_identity (Oman registry cross-check) is the only check performed by default.",
      "corporate_identity only covers Oman-registered companies known to Rafid; a company elsewhere, or not yet covered, correctly shows no match rather than a false negative."
    ]
  } satisfies AgentCapability,
  // ---------------------------------------------------------------------------------------------
  // Procurement: oman_supplier_check — pre-RFQ supplier screening for procurement agents. Reuses
  // the canonical Oman company registry (same provider/mode as search_oman_company) for identity,
  // plus independently cached website / sanctions-list / public-web evidence (src/supplier-check/).
  // Live sources are off by default (RISK_LIVE_CHECKS_ENABLED / WEB_SEARCH_PROVIDER), so the
  // example below is the deterministic, network-free result.
  // ---------------------------------------------------------------------------------------------
  {
    name: "oman_supplier_check" as const, path: "/procurement/oman-supplier-check",
    description: "Screen an Oman supplier for procurement using company identity, business activity, website, contact consistency, address signals, public-risk indicators and sanctions screening.",
    whenToUse: "Use before adding an Oman supplier to an RFQ, vendor shortlist, procurement process or supplier onboarding workflow.",
    useCases: ["pre-RFQ supplier screening", "vendor shortlist check", "supplier onboarding screening", "check whether a supplier's activity matches the required product or service", "detect identity or contact inconsistencies before procurement contact"],
    input: omanSupplierCheckInput, output: omanSupplierCheckOutput,
    example: { companyName: "Example Technical Services LLC", website: "https://example.om", email: "sales@example.om", requiredProductOrService: "HVAC maintenance" },
    exampleOutput: OMAN_SUPPLIER_CHECK_EXAMPLE_OUTPUT,
    execute: (input: unknown) => omanSupplierCheck(input),
    price: 0.50, currency: CURRENCY, paymentProtocol: "x402",
    // Idempotent: the same normalized input never creates duplicate records — provider evidence
    // is UPSERTED into the evidence cache on (provider, normalized key) and the final result is
    // recomputed from it. No canonical company record is ever written (sideEffects: false; the
    // evidence cache is an internal cache, not a state change a caller can observe).
    idempotent: true, sideEffects: false,
    limitations: [
      "Public-source procurement screening only — not a substitute for legal, AML, KYC or regulatory due diligence, and never a vendor approval.",
      "identityConfirmed means the identity is consistent across registry and contact evidence; it is not government verification or certification.",
      "Sanctions screening is automated name matching: potential_match is never a confirmed listing; clear does not guarantee the supplier is unlisted.",
      "Missing information lowers confidence rather than raising risk; a missing website or free email address is not treated as high risk on its own.",
      "Website, sanctions and public-web checks run only when enabled for the deployment (RISK_LIVE_CHECKS_ENABLED, WEB_SEARCH_PROVIDER); otherwise they report not_checked honestly."
    ],
    agentGuidance: {
      priorityContexts: ["procurement supplier screening in Oman", "pre-RFQ vendor check", "supplier onboarding", "vendor shortlist validation"],
      evidenceTypes: [
        { type: "company_registry", description: "Canonical Oman company records (registry, tax, procurement or directory sources) with per-source provenance; demo data is labeled demo_dataset and never treated as real." },
        { type: "company_website", description: "Public facts read from the supplier's own website (self-declared, not independently verified)." },
        { type: "sanctions_list", description: "Automated name matching against public sanctions lists (UN Consolidated List, US Consolidated Screening List incl. OFAC SDN) — potential matches only." },
        { type: "public_web", description: "Public web results naming the supplier alongside risk terms — unverified mentions, never findings." },
        { type: "derived_consistency_check", description: "Deterministic comparisons between the submitted details and the evidence above (email/website/phone/address/CR consistency)." }
      ],
      limitations: [
        "Report procurementSuitability, risk, confidence and riskFlags together — never present appears_suitable as an approval.",
        "Treat POTENTIAL_SANCTIONS_MATCH and PUBLIC_RISK_SIGNAL as items requiring human verification at the cited source, not as facts about the supplier."
      ],
      sampleQueries: [
        { query: "Check this supplier before I add it to an RFQ.", guidance: "Call oman_supplier_check with every detail you have (companyName, crNumber, website, email, phone, address, requiredProductOrService). Relay screeningResult.procurementSuitability, risk, confidence and riskFlags." },
        { query: "Is ABC Trading LLC in Oman a suitable supplier for HVAC maintenance?", guidance: "Call oman_supplier_check with companyName \"ABC Trading LLC\" and requiredProductOrService \"HVAC maintenance\"; answer from checks.businessActivity and screeningResult, citing sources." },
        { query: "Screen this supplier for identity inconsistencies and public risk before procurement contacts them.", guidance: "Call oman_supplier_check including the email, phone and website from the supplier's quotation; report checks.contactConsistency, checks.companyIdentity and checks.publicRisk with their explanations." },
        { query: "Check whether this Oman supplier appears legitimate and whether its business activity matches CCTV installation.", guidance: "Call oman_supplier_check with requiredProductOrService \"CCTV installation\"; report identityConfirmed and the identity level (never 'verified'), and checks.businessActivity.status." }
      ]
    }
  } satisfies AgentCapability,
  // ---------------------------------------------------------------------------------------------
  // Risk intelligence: company_reputation_check — GLOBAL, evidence-first company reputation and
  // commercial-risk intelligence (src/company-reputation/). Independent of oman_supplier_check
  // (which is Oman/procurement-specific); the two share only generic sanctions-list matching
  // (src/shared/sanctions/). Every networked provider is off by default, so execute(example) in
  // tests is network-free. NOTE: unlike most capabilities, exampleOutput is NOT execute(example)
  // in the default configuration — it is the real pipeline run over an explicitly synthetic
  // evidence scenario (see scripts/generateCompanyReputationExample.ts), so agents can see a
  // realistic, fully-populated response. tests/company-reputation.test.ts pins it to the pipeline.
  // ---------------------------------------------------------------------------------------------
  {
    name: "company_reputation_check" as const, path: "/risk/company-reputation-check",
    description: "Investigate the public reputation and commercial risk signals of a company in any country — identity consistency against official registries, sanctions-list name screening, adverse media (with legal stage: allegation vs. outcome), customer reputation, online presence, business stability and domain signals — returning evidence-linked scores with a separate confidence score.",
    whenToUse: "Use this capability when an AI agent needs to assess a company's public reputation, credibility, adverse-media exposure, sanctions signals, customer reputation, online presence, identity consistency and other publicly observable commercial risk indicators before entering a business relationship.",
    useCases: [
      "check a company before signing a contract", "vendor / SaaS vendor onboarding", "check a counterparty before sending payment",
      "partner or investment pre-screening", "marketplace seller approval", "contractor or supplier selection (any country)",
      "negative news / adverse media check", "sanctions name screening of a company"
    ],
    category: "risk_intelligence",
    input: companyReputationCheckInput, output: companyReputationCheckOutput,
    example: { companyName: "Example Technologies Ltd", country: "United Kingdom", website: "https://example.com", registrationNumber: "01234567" },
    exampleOutput: COMPANY_REPUTATION_CHECK_EXAMPLE_OUTPUT,
    execute: (input: unknown) => companyReputationCheck(input),
    price: 0.40, currency: CURRENCY, paymentProtocol: "x402",
    // Idempotent: no state a caller can observe changes; provider evidence is upserted into an
    // internal cache keyed by (provider, normalized identity) and the result is recomputed from it.
    idempotent: true, sideEffects: false,
    limitations: [
      "Evidence-based public-source screening — not a legal, KYC/AML, credit or compliance determination, and never a guarantee that a company is legitimate, safe or fraudulent.",
      "reputationScore and confidenceScore are separate: a mid-range score with low confidence means 'little evidence', not 'average reputation'. Missing data lowers confidence; it never raises the score.",
      "Sanctions screening is automated name matching; 'possible' matches are not listings and 'high' matches still require verification at the source list.",
      "Adverse media is reported at the legal stage the source states (allegation, investigation, lawsuit, charge, settlement, judgment, conviction); allegations are not findings.",
      "Coverage depends on the deployment's enabled providers (see coverage.providers in every response); companies with a small public footprint get low-confidence results.",
      "Company-level intelligence only — not designed for, and must not be used to, profile private individuals."
    ],
    agentGuidance: {
      priorityContexts: ["pre-contract counterparty check", "vendor onboarding", "pre-payment check", "partner / investment screening", "marketplace seller approval", "global company due-diligence screening (first pass)"],
      evidenceTypes: [
        { type: "registry", description: "Official company / LEI registry records (GLEIF, UK Companies House, Rafid's Oman registry) — tier 1; used for identity resolution and business status." },
        { type: "sanctions", description: "Entries returned by public sanctions lists (UN, US CSL incl. OFAC SDN, optionally EU / OpenSanctions) — matched conservatively into possible vs high-confidence matches." },
        { type: "news", description: "News and web coverage, deduplicated into events (syndicated copies = one event) and classified by category and legal stage." },
        { type: "regulatory", description: "Items published on government/regulator domains — tier 1." },
        { type: "review", description: "Review-platform pages; aggregate ratings are used, individual reviews are weak unverified signals." },
        { type: "forum", description: "Forum/social posts — lowest authority; never treated as facts." },
        { type: "website", description: "The company's own website (self-published): availability, HTTPS, contact/legal pages, registration details." },
        { type: "domain", description: "RDAP domain registration data (age, status)." }
      ],
      limitations: [
        "Always relay reputationScore together with confidenceScore, trustLevel and the top redFlags/positiveSignals with their evidence ids — never reduce the result to 'good' or 'bad'.",
        "Supply country (and registrationNumber, LEI or website when known): without them same-name companies cannot be excluded and confidence is capped.",
        "Treat sanctions 'possible' matches and allegation-stage adverse media as items requiring human verification, not as facts about the company."
      ],
      sampleQueries: [
        { query: "Check the reputation of this company before we sign a contract.", guidance: "Call company_reputation_check with companyName, country and every identifier you have (website, registrationNumber, lei). Report trustLevel, reputationScore with confidenceScore, redFlags and the summary." },
        { query: "Investigate this vendor before sending payment.", guidance: "Call company_reputation_check; if sanctions.status is possible_match or high_confidence_match, or identity.status is conflicting/ambiguous, recommend verification before payment." },
        { query: "Check this company for negative news.", guidance: "Call company_reputation_check and report adverseMedia.items with each item's legalStage and stageDescription — distinguish allegations from established outcomes." },
        { query: "Is Example Technologies Ltd in the UK credible?", guidance: "Call company_reputation_check with companyName \"Example Technologies Ltd\" and country \"GB\"; answer from resolution, identity, businessStabilitySignals and the evidence summary, stating the confidence." }
      ]
    }
  } satisfies AgentCapability
];

export type CapabilityName = (typeof capabilities)[number]["name"];
