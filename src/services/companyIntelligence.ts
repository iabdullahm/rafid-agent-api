import { runResearchCompany } from "../intelligence/companyResearch/provider.js";
import { runFindCompanies } from "../intelligence/companyDiscovery/provider.js";
import { runAnalyzeCompanyRisk } from "../intelligence/risk/provider.js";
import { researchCompanyInput } from "../schemas/intelligenceInputs.js";
import { getIntelligenceLlmMode, getWebSearchProviderMode } from "../intelligence/config.js";
import type { CapabilityPreviewBody } from "../preview/types.js";

/**
 * The Phase 1 "Rafid Agent Intelligence" capabilities' real entry points
 * (src/domain/capabilities.ts) — mirrors services/omanBusiness.ts's own
 * "thin wrapper, module-level default options" pattern exactly. No requestId is threaded through
 * here (AgentCapability["execute"] is `(input: unknown) => Promise<unknown>` with no second
 * argument — see domain/capabilities.ts) so cost-attribution records for calls made this way carry
 * requestId: null; that's expected and harmless (see intelligence/costEstimator.ts, which never
 * requires a requestId to aggregate correctly).
 */
export async function researchCompany(input: unknown) { return runResearchCompany(input); }
export async function findCompanies(input: unknown) { return runFindCompanies(input); }
export async function analyzeCompanyRisk(input: unknown) { return runAnalyzeCompanyRisk(input); }

/** Free Preview (src/preview/) for research_company. research_company has no cheap real registry
 *  or cache lookup of its own (its evidence is public web search, gated entirely behind
 *  WEB_SEARCH_PROVIDER) — so, rather than making a real (billable-cost-to-the-operator) search
 *  call just to answer "is there data", this preview does a zero-network configuration check:
 *  whether a web-search provider and an LLM synthesis provider are configured for this
 *  deployment (intelligence/config.ts — the exact same checks runResearchCompany() itself makes
 *  before attempting either). This never returns the company overview, leadership, funding,
 *  competitors, technology signals, recent developments or risk flags themselves — only whether
 *  this deployment is even positioned to look them up. */
export async function previewResearchCompany(rawInput: unknown): Promise<CapabilityPreviewBody> {
  const input = researchCompanyInput.parse(rawInput);
  const webSearchConfigured = getWebSearchProviderMode() !== "none";
  const llmConfigured = getIntelligenceLlmMode() !== "none";
  const configuredCount = (webSearchConfigured ? 1 : 0) + (llmConfigured ? 1 : 0);
  // Real output-schema top-level fields (schemas/intelligenceOutputs.ts's researchCompanyOutput)
  // the paid result populates — a static list, independent of this call's input.
  const availableSections = ["overview", "productsAndServices", "leadership", "funding", "competitors", "technologySignals", "recentDevelopments", "riskFlags"];

  return {
    capability: "research_company",
    status: webSearchConfigured ? "available" : "limited",
    inputRecognized: true,
    preview: {
      entity: input.company, entityType: "company",
      coverageScore: Math.round((configuredCount / 2) * 100) / 100,
      dataCoverage: webSearchConfigured && llmConfigured ? "high" : webSearchConfigured || llmConfigured ? "medium" : "low",
      availableSections,
      signals: { webSearchConfigured, structuredSynthesisConfigured: llmConfigured }
    }
  };
}
