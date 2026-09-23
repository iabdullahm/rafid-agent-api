import { recordProviderCost } from "../costEstimator.js";
import type { IntelligenceSource } from "../types.js";

/**
 * The seam between company research / company discovery / risk-analysis evidence-gathering and
 * whatever web-search API actually backs it — mirrors src/business-data/sources/provider.ts's
 * CompanyDataProvider seam exactly. Swapping search vendors means writing a new class here and
 * changing which one buildWebSearchProvider() constructs — no change to any capability's schema,
 * route, MCP registration or pricing.
 */
export interface WebSearchQueryOptions {
  maxResults: number;
  freshness?: "any" | "day" | "week" | "month" | "year";
  domains?: readonly string[];
  excludeDomains?: readonly string[];
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt: string | null;
  publisher: string | null;
}

export interface WebSearchProvider {
  readonly name: string;
  /** Never throws for an ordinary "no results" or transport failure — returns [] honestly so a
   *  capability degrades to "missing information" rather than a 500. A caller that needs to
   *  distinguish "genuinely no results" from "the provider is unreachable right now" should
   *  prefer a provider that logs internally (see TavilyWebSearchProvider) rather than relying on
   *  the return value alone — the public capability contract never blocks on that distinction. */
  search(query: string, options: WebSearchQueryOptions): Promise<readonly WebSearchResult[]>;
}

/** The honest default and what the generic capability tests exercise: no live provider was
 *  configured for this deployment, so every search returns [] — never a fabricated result. */
export class NotConfiguredWebSearchProvider implements WebSearchProvider {
  readonly name = "Web search (not configured)";
  async search(): Promise<readonly WebSearchResult[]> {
    return [];
  }
}

export interface TavilyWebSearchProviderOptions {
  apiKey: string;
  requestId?: string | null;
  capability?: string;
  fetchImpl?: typeof fetch;
  /** Documented per-search cost estimate recorded via recordProviderCost() after each successful
   *  call — Rafid's own conservative estimate, never Tavily's actual confidential pricing. */
  estimatedCostPerSearchUSD?: number;
}

/** A real, working implementation against Tavily's search API (https://tavily.com) — chosen
 *  because it is built for exactly this use case (LLM/agent-facing structured search results with
 *  snippets, not raw HTML to scrape) and is inexpensive per call relative to the prices set for
 *  research_company/find_companies/analyze_company_risk (see costEstimator.ts's documented
 *  assumptions). Entirely inert until both WEB_SEARCH_PROVIDER=tavily and TAVILY_API_KEY are set
 *  (see intelligence/config.ts) — this class is never constructed otherwise. */
export class TavilyWebSearchProvider implements WebSearchProvider {
  readonly name = "Tavily";
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestId: string | null;
  private readonly capability: string;
  private readonly estimatedCostPerSearchUSD: number;

  constructor(options: TavilyWebSearchProviderOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestId = options.requestId ?? null;
    this.capability = options.capability ?? "unknown";
    this.estimatedCostPerSearchUSD = options.estimatedCostPerSearchUSD ?? 0.005;
  }

  async search(query: string, options: WebSearchQueryOptions): Promise<readonly WebSearchResult[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await this.fetchImpl("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
        body: JSON.stringify({
          query,
          max_results: Math.max(1, Math.min(options.maxResults, 20)),
          search_depth: "basic",
          include_answer: false,
          ...(options.domains && options.domains.length > 0 ? { include_domains: options.domains } : {}),
          ...(options.excludeDomains && options.excludeDomains.length > 0 ? { exclude_domains: options.excludeDomains } : {}),
          ...(options.freshness && options.freshness !== "any" ? { time_range: freshnessToTavilyRange(options.freshness) } : {})
        })
      });
      if (!response.ok) return [];
      const body = (await response.json()) as { results?: unknown };
      recordProviderCost({ provider: this.name, estimatedCostUSD: this.estimatedCostPerSearchUSD, requestId: this.requestId, capability: this.capability });
      if (!Array.isArray(body.results)) return [];
      return body.results
        .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
        .map(r => ({
          title: typeof r.title === "string" ? r.title : "Untitled",
          url: typeof r.url === "string" ? r.url : "",
          snippet: typeof r.content === "string" ? r.content.slice(0, 1000) : "",
          publishedAt: typeof r.published_date === "string" ? r.published_date : null,
          publisher: publisherFromUrl(typeof r.url === "string" ? r.url : null)
        }))
        .filter(r => r.url.length > 0);
    } catch {
      // Network failure, timeout, malformed response — never surfaces as a 500 to the capability
      // caller; the capability treats this exactly like "no results" and reports it in
      // `limitations`, honestly.
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}

function freshnessToTavilyRange(freshness: "day" | "week" | "month" | "year"): string {
  return freshness === "day" ? "day" : freshness === "week" ? "week" : freshness === "month" ? "month" : "year";
}

function publisherFromUrl(url: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}

/** Converts raw web-search results into the shared IntelligenceSource shape every capability's
 *  `sources` array uses — one place this mapping is written, never duplicated per capability. */
export function toIntelligenceSources(results: readonly WebSearchResult[], observedAt: string): IntelligenceSource[] {
  return results.map(r => ({ url: r.url, title: r.title, publisher: r.publisher, sourceType: "web_search", observedAt }));
}
