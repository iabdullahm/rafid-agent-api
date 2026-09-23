import { buildWebSearchProvider, isWebSearchConfigured } from "../../intelligence/webSearch/build.js";
import type { WebSearchOutcome, WebSearchProvider, WebSearchResult } from "../../intelligence/webSearch/provider.js";
import { ESTIMATED_COST_PER_SEARCH_USD, LIMITS } from "../config.js";
import { evidenceId } from "../deduplication.js";
import { canonicalUrl, hostOf } from "../normalization.js";
import { sanitizeExternalText } from "../sanitize.js";
import { classifySourceTier, isForumOrSocial, isReviewPlatform, REVIEW_PLATFORM_DOMAINS, tierQuality } from "../sourceQuality.js";
import type { EvidenceType, NormalizedEvidence, ProviderFetchResult } from "../types.js";
import { outage, type Applicability, type ProviderContext, type ReputationProvider, type ReputationQuery } from "./types.js";

/**
 * Web-search-backed collection (news / adverse media, and customer reviews). Uses the SAME
 * WebSearchProvider seam as the Rafid Agent Intelligence capabilities (WEB_SEARCH_PROVIDER /
 * TAVILY_API_KEY), with a hard cap on searches per call for unit economics:
 *   news:    2 searches (targeted adverse-topic query + general company query)
 *   reviews: 1 search restricted to review platforms / forums
 * Search results are untrusted: titles/snippets are sanitized before they enter the evidence model,
 * and nothing is classified here — classification happens in the analyzers.
 */

type SearchFactory = () => WebSearchProvider;
const defaultFactory: SearchFactory = () => buildWebSearchProvider({ requestId: null, capability: "company_reputation_check" });

export async function runSearch(search: WebSearchProvider, query: string, options: Parameters<WebSearchProvider["search"]>[1]): Promise<WebSearchOutcome> {
  if (search.searchWithStatus) return search.searchWithStatus(query, options);
  // Providers without status reporting: results are trusted as "ok" (an empty list stays empty).
  return { status: "ok", results: await search.search(query, options) };
}

export function toSearchEvidence(providerId: string, r: WebSearchResult, now: Date, defaultType: EvidenceType, queryLabel: string): NormalizedEvidence | null {
  const url = canonicalUrl(r.url) ? r.url : null;
  if (!url) return null;
  const host = hostOf(url);
  const type: EvidenceType = isReviewPlatform(host) ? "review" : isForumOrSocial(host) ? "forum" : defaultType;
  const tierType: EvidenceType = type;
  const tier = classifySourceTier(host, tierType === "news" || tierType === "review" || tierType === "forum" ? tierType : "news");
  const title = sanitizeExternalText(r.title, 200);
  const summary = sanitizeExternalText(r.snippet, 600);
  const publishedAt = r.publishedAt && Number.isFinite(Date.parse(r.publishedAt)) ? new Date(Date.parse(r.publishedAt)).toISOString() : null;
  return {
    id: evidenceId(providerId, canonicalUrl(url)!), type: tier === 1 && type === "news" ? "regulatory" : type, providerId,
    sourceName: r.publisher ?? host ?? "web", sourceUrl: url, sourceDomain: host, sourceRecordId: null, sourceTier: tier,
    title: title.text || null, summary: summary.text || null, publishedAt, observedAt: now.toISOString(), jurisdiction: null,
    companyIdentifiers: {}, quality: tierQuality(tier), relevance: 1,
    metadata: { query: queryLabel, injectionDetected: title.injectionDetected || summary.injectionDetected }
  };
}

const ADVERSE_TERMS = "fraud OR scam OR lawsuit OR fined OR investigation OR sanctions OR bankruptcy OR insolvency OR breach OR convicted OR settlement";

export class NewsProvider implements ReputationProvider {
  readonly id = "news_web_search";
  readonly name = "News and public web search";
  readonly category = "news" as const;
  readonly retryable = false; // paid per search — never retried automatically

  constructor(private readonly factory: SearchFactory = defaultFactory, private readonly configured: () => boolean = isWebSearchConfigured) {}

  applicability(): Applicability {
    return this.configured() ? { status: "ready" } : { status: "not_configured", reason: "No web/news search provider is configured for this deployment (WEB_SEARCH_PROVIDER)." };
  }

  cacheKey(q: ReputationQuery): string {
    return `${q.nameKey}|${q.country?.code ?? "*"}|${q.domain ?? ""}`;
  }

  async fetch(q: ReputationQuery, ctx: ProviderContext): Promise<ProviderFetchResult> {
    const search = this.factory();
    const name = `"${q.legalName ?? q.companyName}"`;
    const where = q.country ? ` ${q.country.name}` : "";
    const queries = [
      { label: "adverse", text: `${name}${where} (${ADVERSE_TERMS})` },
      { label: "general", text: `${name}${where} company${q.domain ? ` ${q.domain}` : ""}` }
    ];
    const outcomes = await Promise.all(queries.map(query => runSearch(search, query.text, { maxResults: LIMITS.newsResultsPerQuery })));
    const okCount = outcomes.filter(o => o.status === "ok").length;
    if (okCount === 0) {
      const first = outcomes[0]!;
      return outage(first.status === "ok" ? "unavailable" : first.status, `The web/news search provider did not answer (${first.status}).`, queries.length);
    }
    const evidence = outcomes.flatMap((o, i) => o.results.map(r => toSearchEvidence(this.id, r, ctx.now, "news", queries[i]!.label))).filter((e): e is NormalizedEvidence => e !== null);
    return {
      status: "ok", evidence, requests: queries.length, estimatedCostUSD: okCount * ESTIMATED_COST_PER_SEARCH_USD,
      reason: okCount < queries.length ? "One of the two news searches failed; results are partial." : null
    };
  }
}

export class ReviewsProvider implements ReputationProvider {
  readonly id = "reviews_web_search";
  readonly name = "Review platforms and forums (web search)";
  readonly category = "reviews" as const;
  readonly retryable = false;

  constructor(private readonly factory: SearchFactory = defaultFactory, private readonly configured: () => boolean = isWebSearchConfigured) {}

  applicability(): Applicability {
    return this.configured() ? { status: "ready" } : { status: "not_configured", reason: "No web search provider is configured for review/forum discovery (WEB_SEARCH_PROVIDER)." };
  }

  cacheKey(q: ReputationQuery): string {
    return `${q.nameKey}|${q.country?.code ?? "*"}|${q.domain ?? ""}`;
  }

  async fetch(q: ReputationQuery, ctx: ProviderContext): Promise<ProviderFetchResult> {
    const search = this.factory();
    const domains = [...REVIEW_PLATFORM_DOMAINS].filter(d => d !== "google.com" && d !== "indeed.com" && d !== "glassdoor.com").concat(["reddit.com"]);
    const text = `"${q.legalName ?? q.companyName}" reviews${q.domain ? ` ${q.domain}` : ""}`;
    const outcome = await runSearch(search, text, { maxResults: LIMITS.reviewResults, domains });
    if (outcome.status !== "ok") return outage(outcome.status, `The review search did not answer (${outcome.status}).`);
    const evidence = outcome.results.map(r => toSearchEvidence(this.id, r, ctx.now, "review", "reviews")).filter((e): e is NormalizedEvidence => e !== null);
    return { status: "ok", evidence, reason: null, requests: 1, estimatedCostUSD: ESTIMATED_COST_PER_SEARCH_USD };
  }
}
