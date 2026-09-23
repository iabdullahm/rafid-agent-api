/**
 * Shared vocabulary for the new "Rafid Agent Intelligence" capabilities (research_company,
 * find_companies, analyze_company_risk — Phase 1 of the broader agent-intelligence expansion).
 * Mirrors src/business-data/types.ts / src/domain/oman/types.ts's own "one file, one shared
 * vocabulary" discipline: no schema or provider redefines these unions a second time.
 *
 * Every one of these capabilities starts with genuinely NO existing data source (unlike Oman
 * business data, which already had a real imported dataset to fall back to) — so the honest
 * default everywhere in this module is "not configured", never a fabricated fact. See
 * src/intelligence/config.ts for the env vars that turn each real provider on.
 */

/** How a piece of evidence backing an intelligence result was obtained. "not_configured" is a
 *  distinct, explicit value (never silently omitted or conflated with "web_search") so a caller
 *  can tell "we looked and found nothing" apart from "no live provider was even configured for
 *  this deployment" — the same discipline as COMPANY_SOURCE_TYPES's "demo" value. */
export const INTELLIGENCE_SOURCE_TYPES = [
  "web_search", "company_website", "news", "government_registry", "regulatory_registry",
  "sanctions_list", "domain_registry", "rafid_oman_registry", "not_configured"
] as const;
export type IntelligenceSourceType = (typeof INTELLIGENCE_SOURCE_TYPES)[number];

/** One cited source, shared across all three Phase 1 capabilities' `sources` arrays. `url` is
 *  nullable — a source can be named (e.g. "OFAC Consolidated Screening List") without a
 *  caller-followable URL. Never carries a provider API key, request signature or any other
 *  provider-internal credential. */
export interface IntelligenceSource {
  url: string | null;
  title: string;
  publisher: string | null;
  sourceType: IntelligenceSourceType;
  observedAt: string;
}

/** Evidence tiers (spec: "clearly distinguish confirmed evidence / public allegations / missing
 *  information / automated indicators"). Applied uniformly across analyze_company_risk's
 *  riskSignals AND every other capability's confidence/limitations reasoning, so an agent never
 *  has to guess how much weight one piece of evidence deserves. */
export const EVIDENCE_TIERS = ["confirmed_evidence", "public_allegation", "automated_indicator", "missing_information"] as const;
export type EvidenceTier = (typeof EVIDENCE_TIERS)[number];

export const SEVERITY_LEVELS = ["low", "medium", "high"] as const;
export type Severity = (typeof SEVERITY_LEVELS)[number];

/** Whether a result actually drew on a live, configured provider, or is the honest empty/limited
 *  result produced when no provider is configured for this deployment — read by
 *  src/analytics/dataSource.ts exactly like analyze_oman_property's provenance/dataCoverage
 *  fields are, so operator-facing analytics can tell live-provider traffic apart from inert
 *  traffic without a second signal. Never a claim about correctness — only about whether a real
 *  external provider was consulted at all. */
export const INTELLIGENCE_DATA_MODES = ["live", "not_configured"] as const;
export type IntelligenceDataMode = (typeof INTELLIGENCE_DATA_MODES)[number];

/** A generic per-request cost record — Section "Upstream Cost Control": every external provider
 *  call (a web search, an LLM synthesis call) should be able to record what it estimates it cost,
 *  for later unit-economics analysis. Never surfaced publicly, never counted as revenue (see
 *  costEstimator.ts's doc comment), and never exposes a provider's actual confidential pricing —
 *  only Rafid's own internal ESTIMATE of the cost. */
export interface ProviderCostRecord {
  provider: string;
  estimatedCostUSD: number;
  requestId: string | null;
  capability: string;
}
