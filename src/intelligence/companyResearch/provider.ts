import { z } from "zod";
import { researchCompanyInput, RESEARCH_DEPTHS, RESEARCH_FOCUS_AREAS } from "../../schemas/intelligenceInputs.js";
import type { researchCompanyOutput } from "../../schemas/intelligenceOutputs.js";
import { buildWebSearchProvider, isWebSearchConfigured } from "../webSearch/build.js";
import { buildIntelligenceSynthesizer } from "../synthesis/build.js";
import { toIntelligenceSources, type WebSearchResult } from "../webSearch/provider.js";
import { TtlCache, cacheKey } from "../cache.js";
import { getIntelligenceCacheTtlMs } from "../config.js";
import type { IntelligenceSource } from "../types.js";

/**
 * research_company orchestration. Section "Caching": "cache by normalized company/domain + depth
 * + focus areas." Section "AI / LLM Usage": structured fields (industry, leadership, funding,
 * competitors, etc.) are extracted from raw web-search evidence by an LLM ONLY when one is
 * configured, and the extraction is schema-validated before use (see synthesis/synthesizer.ts).
 * With no LLM configured — the honest default, and what the generic capability tests exercise —
 * every structured field is null/empty rather than guessed from snippets by hand-rolled string
 * matching; raw sources are still returned so the calling agent has something to work with.
 */

type ResearchCompanyOutput = z.infer<typeof researchCompanyOutput>;

const cache = new TtlCache<ResearchCompanyOutput>(getIntelligenceCacheTtlMs());

const DEPTH_SEARCH_COUNT: Record<(typeof RESEARCH_DEPTHS)[number], number> = {
  quick: 1,
  standard: 3,
  deep: 6
};

const QUERY_TEMPLATES: Partial<Record<(typeof RESEARCH_FOCUS_AREAS)[number], (company: string) => string>> = {
  overview: c => `"${c}" company overview what does it do`,
  products: c => `"${c}" products OR services`,
  leadership: c => `"${c}" CEO OR founder OR leadership team`,
  funding: c => `"${c}" funding OR investment OR raised OR valuation`,
  competitors: c => `"${c}" competitors OR alternatives`,
  technology: c => `"${c}" technology OR platform OR built with OR tech stack`,
  recent_news: c => `"${c}" news`,
  market_position: c => `"${c}" market position OR industry ranking OR market share`,
  risks: c => `"${c}" lawsuit OR controversy OR investigation OR risk`
};

const synthesisSchema = z.object({
  industry: z.string().nullable(),
  headquarters: z.string().nullable(),
  founded: z.string().nullable(),
  overview: z.string().nullable(),
  productsAndServices: z.array(z.string()),
  leadership: z.array(z.object({ name: z.string(), title: z.string().nullable() })),
  fundingSummary: z.string().nullable(),
  knownRounds: z.array(z.object({ round: z.string().nullable(), amount: z.string().nullable(), date: z.string().nullable(), investors: z.array(z.string()) })),
  competitors: z.array(z.object({ name: z.string(), reason: z.string() })),
  technologySignals: z.array(z.string()),
  recentDevelopments: z.array(z.object({ title: z.string(), date: z.string().nullable(), summary: z.string(), source: z.string().nullable() })),
  riskFlags: z.array(z.string())
});

export interface RunResearchCompanyOptions {
  requestId?: string | null;
}

export async function runResearchCompany(rawInput: unknown, options: RunResearchCompanyOptions = {}): Promise<ResearchCompanyOutput> {
  const input = researchCompanyInput.parse(rawInput);
  const focusAreas = input.focusAreas && input.focusAreas.length > 0 ? input.focusAreas : [...RESEARCH_FOCUS_AREAS];
  const key = cacheKey("research", input.company, input.website, input.country, input.depth, [...focusAreas].sort().join(","));
  const cached = cache.get(key);
  if (cached) return { ...cached, cached: true };

  const now = new Date();
  const baseLimitations = [
    "This result is derived from public web search results, not verified company records or a direct company disclosure.",
    "Coverage depends on what is publicly indexed and searchable — a real, established company with limited public web presence will correctly return sparse results, not a false negative about its existence."
  ];

  if (!isWebSearchConfigured()) {
    return buildResult({
      input, sources: [], overview: null, productsAndServices: [], leadership: [],
      fundingSummary: null, knownRounds: [], competitors: [], technologySignals: [], recentDevelopments: [], riskFlags: [],
      industry: null, headquarters: null, founded: null,
      confidence: 0, freshness: { latestSourceDate: null, freshnessDays: null },
      dataMode: "not_configured",
      limitations: ["No web search provider is configured for this deployment (WEB_SEARCH_PROVIDER is not set) — no external research was performed.", ...baseLimitations]
    });
  }

  const provider = buildWebSearchProvider({ requestId: options.requestId ?? null, capability: "research_company" });
  const queries = selectQueries(focusAreas, input.depth);
  const searchResults = await Promise.all(queries.map(q => provider.search(q(input.company), { maxResults: 5, freshness: "year" })));
  const flat = dedupeByUrl(searchResults.flat());

  if (flat.length === 0) {
    return buildResult({
      input, sources: [], overview: null, productsAndServices: [], leadership: [],
      fundingSummary: null, knownRounds: [], competitors: [], technologySignals: [], recentDevelopments: [], riskFlags: [],
      industry: null, headquarters: null, founded: null,
      confidence: 0.05, freshness: { latestSourceDate: null, freshnessDays: null },
      dataMode: "live",
      limitations: ["No relevant web search results were found for this company.", ...baseLimitations]
    }, key);
  }

  const observedAt = now.toISOString();
  const sources = toIntelligenceSources(flat, observedAt);
  const synthesizer = buildIntelligenceSynthesizer();
  const synthesized = await synthesizer.synthesize(
    {
      instruction:
        `Extract structured company information about "${input.company}" from the evidence below. ` +
        "Only state facts explicitly present in the evidence — set any field to null (or an empty array) when the evidence does not state it. Never invent or infer a fact not present in the evidence.",
      evidence: flat.map((r, i) => ({ id: `source-${i + 1}`, title: r.title, text: r.snippet })),
      capability: "research_company",
      requestId: options.requestId ?? null
    },
    synthesisSchema
  );

  const freshness = computeFreshness(flat, now);
  const sourceConfidence = Math.min(0.35, flat.length * 0.05);
  const confidence = Math.round(Math.min(0.9, 0.15 + sourceConfidence + (synthesized ? 0.3 : 0)) * 100) / 100;

  const limitations = [...baseLimitations];
  if (!synthesized) {
    limitations.unshift(
      "Structured extraction (industry, leadership, funding, competitors, etc.) requires an LLM synthesis provider, which is not configured for this deployment — only raw web sources are returned below for the calling agent to review directly."
    );
  }

  return buildResult({
    input, sources,
    overview: synthesized?.overview ?? null,
    productsAndServices: synthesized?.productsAndServices ?? [],
    leadership: synthesized?.leadership ?? [],
    fundingSummary: synthesized?.fundingSummary ?? null,
    knownRounds: synthesized?.knownRounds ?? [],
    competitors: synthesized?.competitors ?? [],
    technologySignals: synthesized?.technologySignals ?? [],
    recentDevelopments: synthesized?.recentDevelopments ?? [],
    riskFlags: synthesized?.riskFlags ?? [],
    industry: synthesized?.industry ?? null,
    headquarters: synthesized?.headquarters ?? null,
    founded: synthesized?.founded ?? null,
    confidence, freshness, dataMode: "live", limitations
  }, key);
}

function selectQueries(focusAreas: readonly (typeof RESEARCH_FOCUS_AREAS)[number][], depth: "quick" | "standard" | "deep") {
  const ordered = focusAreas.length > 0 ? focusAreas : [...RESEARCH_FOCUS_AREAS];
  const templates = ordered.map(f => QUERY_TEMPLATES[f]).filter((t): t is (c: string) => string => Boolean(t));
  const count = Math.max(1, DEPTH_SEARCH_COUNT[depth]);
  return (templates.length > 0 ? templates : [QUERY_TEMPLATES.overview!]).slice(0, count);
}

function dedupeByUrl(results: readonly WebSearchResult[]): WebSearchResult[] {
  const seen = new Set<string>();
  const out: WebSearchResult[] = [];
  for (const r of results) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
  }
  return out;
}

function computeFreshness(results: readonly WebSearchResult[], now: Date): { latestSourceDate: string | null; freshnessDays: number | null } {
  const dates = results.map(r => r.publishedAt).filter((d): d is string => Boolean(d)).map(d => Date.parse(d)).filter(n => !Number.isNaN(n));
  if (dates.length === 0) return { latestSourceDate: null, freshnessDays: null };
  const latest = Math.max(...dates);
  return { latestSourceDate: new Date(latest).toISOString(), freshnessDays: Math.max(0, Math.round((now.getTime() - latest) / 86_400_000)) };
}

interface BuildResultArgs {
  input: z.infer<typeof researchCompanyInput>;
  sources: IntelligenceSource[];
  overview: string | null;
  productsAndServices: string[];
  leadership: { name: string; title: string | null }[];
  fundingSummary: string | null;
  knownRounds: { round: string | null; amount: string | null; date: string | null; investors: string[] }[];
  competitors: { name: string; reason: string }[];
  technologySignals: string[];
  recentDevelopments: { title: string; date: string | null; summary: string; source: string | null }[];
  riskFlags: string[];
  industry: string | null;
  headquarters: string | null;
  founded: string | null;
  confidence: number;
  freshness: { latestSourceDate: string | null; freshnessDays: number | null };
  dataMode: "live" | "not_configured";
  limitations: string[];
}

function buildResult(args: BuildResultArgs, cacheKeyForResult?: string): ResearchCompanyOutput {
  const result: ResearchCompanyOutput = {
    company: { name: args.input.company, website: args.input.website ?? null, industry: args.industry, headquarters: args.headquarters, founded: args.founded },
    overview: args.overview,
    productsAndServices: args.productsAndServices,
    leadership: args.leadership,
    funding: { summary: args.fundingSummary, knownRounds: args.knownRounds },
    competitors: args.competitors,
    technologySignals: args.technologySignals,
    recentDevelopments: args.recentDevelopments,
    riskFlags: args.riskFlags,
    sources: args.sources,
    confidence: args.confidence,
    dataFreshness: args.freshness,
    cached: false,
    dataMode: args.dataMode,
    limitations: args.limitations
  };
  if (args.dataMode === "live" && cacheKeyForResult) cache.set(cacheKeyForResult, result);
  return result;
}
