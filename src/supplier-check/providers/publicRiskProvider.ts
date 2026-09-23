import { NotConfiguredWebSearchProvider, type WebSearchProvider } from "../../intelligence/webSearch/provider.js";
import { buildWebSearchProvider } from "../../intelligence/webSearch/build.js";
import type { ProviderResult, SupplierDataProvider } from "../types.js";

/**
 * Public-web risk provider: runs ONE targeted web search through the existing, shared
 * WebSearchProvider seam (src/intelligence/webSearch — Tavily when WEB_SEARCH_PROVIDER=tavily,
 * otherwise the inert NotConfiguredWebSearchProvider). It only RETRIEVES results; deciding
 * whether a result is a signal about THIS supplier happens in ../analysis/publicRisk.ts, which
 * requires the supplier's distinctive name to actually appear alongside a risk keyword — a
 * generic "scam warning" article that doesn't name the supplier is never attributed to it.
 */

export interface PublicWebResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt: string | null;
  publisher: string | null;
}

export interface PublicRiskEvidence {
  query: string;
  results: PublicWebResult[];
}

export interface SupplierPublicRiskProvider extends SupplierDataProvider {
  readonly kind: "public_web";
  findSignals(companyName: string, now: Date): Promise<ProviderResult<PublicRiskEvidence>>;
}

export function publicRiskQuery(companyName: string): string {
  return `"${companyName}" Oman (fraud OR scam OR warning OR impersonation OR fake OR blacklist OR "regulatory warning")`;
}

export class WebSearchPublicRiskProvider implements SupplierPublicRiskProvider {
  readonly kind = "public_web" as const;
  readonly id = "supplier_public_web";
  readonly name: string;

  constructor(private readonly search: WebSearchProvider = buildWebSearchProvider({ requestId: null, capability: "oman_supplier_check" })) {
    this.name = `Public web search (${search.name})`;
  }

  async findSignals(companyName: string, now: Date): Promise<ProviderResult<PublicRiskEvidence>> {
    if (this.search instanceof NotConfiguredWebSearchProvider) {
      return { status: "not_configured", evidence: null, sources: [], reason: "No web search provider is configured for this deployment (WEB_SEARCH_PROVIDER)." };
    }
    const query = publicRiskQuery(companyName);
    try {
      const results = await this.search.search(query, { maxResults: 8 });
      return {
        status: "ok",
        evidence: { query, results: results.map(r => ({ title: r.title, url: r.url, snippet: r.snippet, publishedAt: r.publishedAt, publisher: r.publisher })) },
        sources: [{ type: "public_web", name: this.name, url: null, checkedAt: now.toISOString(), observedAt: null }],
        reason: null
      };
    } catch {
      return { status: "unavailable", evidence: null, sources: [], reason: "Public web search failed." };
    }
  }
}
