import { toIntelligenceSources, type WebSearchProvider } from "../../webSearch/provider.js";
import { isWebSearchConfigured } from "../../webSearch/build.js";
import type { CheckOutcome } from "./liveChecks.js";

/**
 * adverse_news / reputation / legal_signals — all three are "search the open web for evidence,
 * present it labeled by tier, never assert the truth of what's found" (Section: "Do NOT make
 * unsupported allegations", "Do NOT infer fraud/criminality from weak signals", "clearly
 * distinguish confirmed evidence / public allegations / missing information / automated
 * indicators"). Every result found is tiered "public_allegation" — a search result is, by
 * definition, something publicly reported, never something this check independently confirmed.
 */

interface NewsCheckConfig {
  label: string;
  queryTemplate: (company: string) => string;
}

const CHECK_CONFIGS: Record<"adverse_news" | "reputation" | "legal_signals", NewsCheckConfig> = {
  adverse_news: { label: "adverse news", queryTemplate: c => `"${c}" lawsuit OR fraud OR scandal OR investigation OR fine` },
  reputation: { label: "reputation", queryTemplate: c => `"${c}" reviews OR complaints OR reputation` },
  legal_signals: { label: "legal/regulatory", queryTemplate: c => `"${c}" lawsuit OR litigation OR regulatory action OR settlement` }
};

export async function runNewsBackedCheck(
  kind: "adverse_news" | "reputation" | "legal_signals",
  companyName: string | null,
  provider: WebSearchProvider,
  now: () => Date = () => new Date()
): Promise<CheckOutcome> {
  if (!companyName) return { status: "not_applicable", summary: "No company name was provided.", findings: [], evidence: [], sources: [] };
  if (!isWebSearchConfigured()) {
    return { status: "not_configured", summary: "No web search provider is configured for this deployment.", findings: [], evidence: [], sources: [] };
  }
  const config = CHECK_CONFIGS[kind];
  const observedAt = now().toISOString();
  const results = await provider.search(config.queryTemplate(companyName), { maxResults: 5, freshness: "year" });
  if (results.length === 0) {
    return {
      status: "performed",
      summary: `No ${config.label} coverage was found in the configured web search.`,
      findings: [`No results — absence of ${config.label} coverage in a web search is not proof of a clean record; it only reflects what this search found.`],
      evidence: [{ description: `No ${config.label} results found.`, source: null, tier: "missing_information" }],
      sources: []
    };
  }
  return {
    status: "performed",
    summary: `${results.length} ${config.label}-related result(s) found. These are public search results, not confirmed facts — review each source directly.`,
    findings: results.map(r => `${r.title} (${r.publisher ?? "unknown publisher"}${r.publishedAt ? `, ${r.publishedAt}` : ""})`),
    evidence: results.map(r => ({ description: r.snippet || r.title, source: r.url, tier: "public_allegation" as const })),
    sources: toIntelligenceSources(results, observedAt)
  };
}
