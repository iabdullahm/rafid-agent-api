import { z } from "zod";
import { findCompaniesInput } from "../../schemas/intelligenceInputs.js";
import type { findCompaniesOutput } from "../../schemas/intelligenceOutputs.js";
import { buildWebSearchProvider, isWebSearchConfigured } from "../webSearch/build.js";
import { buildIntelligenceSynthesizer } from "../synthesis/build.js";
import { toIntelligenceSources, type WebSearchResult } from "../webSearch/provider.js";
import { TtlCache, cacheKey } from "../cache.js";
import { getIntelligenceCacheTtlMs } from "../config.js";
import type { IntelligenceSource } from "../types.js";

/**
 * find_companies orchestration. Section "Pricing": "the requested limit can remain up to 20
 * initially... design so tiered pricing can be added later" — INTERNAL_RESULT_CAP below is that
 * cap; a caller may request up to 100 (the input schema's own max) but never receives more than
 * INTERNAL_RESULT_CAP real, non-fabricated companies for a single call today, and `requestedLimit`
 * vs `appliedLimit` in the output makes the gap between "what was asked for" and "what was
 * actually returned" honest rather than silent.
 *
 * Section "Do NOT... invent research results": with no LLM synthesis provider configured, this
 * module does NOT attempt to guess company records out of raw search snippets by string-matching
 * domains/titles — that is exactly the kind of fabrication risk the spec calls out. Instead it
 * returns an honest empty `companies` list plus the raw search sources, so the calling agent can
 * still see what was found without Rafid asserting structured facts it cannot verify.
 */

type FindCompaniesOutput = z.infer<typeof findCompaniesOutput>;

const INTERNAL_RESULT_CAP = 20;

const cache = new TtlCache<FindCompaniesOutput>(getIntelligenceCacheTtlMs());

const discoverySynthesisSchema = z.object({
  companies: z.array(
    z.object({
      name: z.string(),
      website: z.string().nullable(),
      industry: z.string().nullable(),
      country: z.string().nullable(),
      city: z.string().nullable(),
      employeeRange: z.string().nullable(),
      description: z.string().nullable(),
      whyMatched: z.string()
    })
  )
});

export interface RunFindCompaniesOptions {
  requestId?: string | null;
}

export async function runFindCompanies(rawInput: unknown, options: RunFindCompaniesOptions = {}): Promise<FindCompaniesOutput> {
  const input = findCompaniesInput.parse(rawInput);
  const appliedLimit = Math.min(input.limit, INTERNAL_RESULT_CAP);
  const key = cacheKey(
    "discovery", input.query, input.industry, input.country, input.city,
    input.employeeMin, input.employeeMax, (input.keywords ?? []).slice().sort().join(","), appliedLimit
  );
  const cached = cache.get(key);
  if (cached) return { ...cached, cached: true };

  const baseLimitations: string[] = [
    "Company discovery is based on public web search coverage — it cannot guarantee completeness, especially for small, private, or newly founded companies with limited public presence.",
    "A company not appearing in these results is not evidence that it doesn't exist or doesn't match the criteria — only that it wasn't found by this search."
  ];
  if (appliedLimit < input.limit) {
    baseLimitations.push(`Results are capped internally at ${INTERNAL_RESULT_CAP} per request to control upstream cost, regardless of the requested limit (${input.limit}).`);
  }

  if (!isWebSearchConfigured()) {
    return buildResult({
      companies: [], sources: [], confidence: 0, dataMode: "not_configured",
      requestedLimit: input.limit, appliedLimit: 0,
      limitations: ["No web search provider is configured for this deployment (WEB_SEARCH_PROVIDER is not set) — no discovery search was performed.", ...baseLimitations]
    });
  }

  const provider = buildWebSearchProvider({ requestId: options.requestId ?? null, capability: "find_companies" });
  const query = buildSearchQuery(input);
  const results = await provider.search(query, { maxResults: Math.min(appliedLimit, 20), freshness: "year" });
  const deduped = dedupeByUrl(results);

  if (deduped.length === 0) {
    return buildResult({
      companies: [], sources: [], confidence: 0.05, dataMode: "live",
      requestedLimit: input.limit, appliedLimit,
      limitations: ["No web search results were found for the given criteria.", ...baseLimitations]
    }, key);
  }

  const observedAt = new Date().toISOString();
  const sources = toIntelligenceSources(deduped, observedAt);
  const synthesizer = buildIntelligenceSynthesizer();
  const synthesized = await synthesizer.synthesize(
    {
      instruction:
        "Extract a list of DISTINCT, REAL companies that match the search criteria, using only the evidence below. " +
        "Never invent a company that is not actually named in the evidence. For each company, cite in whyMatched which evidence source(s) support it (e.g. \"mentioned in source-2\"). " +
        `Criteria: ${describeCriteria(input)}.`,
      evidence: deduped.map((r, i) => ({ id: `source-${i + 1}`, title: r.title, text: r.snippet })),
      capability: "find_companies",
      requestId: options.requestId ?? null
    },
    discoverySynthesisSchema
  );

  const limitations = [...baseLimitations];
  if (!synthesized) {
    limitations.unshift(
      "Structured company extraction requires an LLM synthesis provider, which is not configured for this deployment — no candidate companies could be safely extracted from raw search results without risking fabrication; the underlying search sources are returned below for the calling agent to review directly."
    );
  }

  const companies = (synthesized?.companies ?? [])
    .slice(0, appliedLimit)
    .map(c => ({
      name: c.name, website: c.website, industry: c.industry,
      location: { country: c.country, city: c.city },
      employeeRange: c.employeeRange, description: c.description, whyMatched: c.whyMatched,
      sources
    }));

  const sourceConfidence = Math.min(0.35, deduped.length * 0.05);
  const confidence = Math.round(Math.min(0.85, 0.15 + sourceConfidence + (synthesized ? 0.25 : 0)) * 100) / 100;

  return buildResult({
    companies, sources, confidence, dataMode: "live",
    requestedLimit: input.limit, appliedLimit, limitations
  }, key);
}

function buildSearchQuery(input: z.infer<typeof findCompaniesInput>): string {
  const parts: string[] = [];
  if (input.query) parts.push(input.query);
  if (input.industry) parts.push(`${input.industry} companies`);
  if (input.keywords && input.keywords.length > 0) parts.push(input.keywords.join(" "));
  if (input.city) parts.push(`in ${input.city}`);
  if (input.country) parts.push(input.country);
  if (parts.length === 0) parts.push("companies");
  return parts.join(" ");
}

function describeCriteria(input: z.infer<typeof findCompaniesInput>): string {
  const bits: string[] = [];
  if (input.query) bits.push(`query="${input.query}"`);
  if (input.industry) bits.push(`industry="${input.industry}"`);
  if (input.country) bits.push(`country="${input.country}"`);
  if (input.city) bits.push(`city="${input.city}"`);
  if (input.employeeMin !== undefined || input.employeeMax !== undefined) bits.push(`employees between ${input.employeeMin ?? 0} and ${input.employeeMax ?? "unbounded"}`);
  if (input.keywords && input.keywords.length > 0) bits.push(`keywords=[${input.keywords.join(", ")}]`);
  return bits.length > 0 ? bits.join("; ") : "no specific filters provided";
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

interface BuildResultArgs {
  companies: FindCompaniesOutput["companies"];
  sources: IntelligenceSource[];
  confidence: number;
  dataMode: "live" | "not_configured";
  requestedLimit: number;
  appliedLimit: number;
  limitations: string[];
}

function buildResult(args: BuildResultArgs, cacheKeyForResult?: string): FindCompaniesOutput {
  const result: FindCompaniesOutput = {
    companies: args.companies,
    resultCount: args.companies.length,
    sources: args.sources,
    confidence: args.confidence,
    cached: false,
    dataMode: args.dataMode,
    requestedLimit: args.requestedLimit,
    appliedLimit: args.appliedLimit,
    limitations: args.limitations
  };
  if (args.dataMode === "live" && cacheKeyForResult) cache.set(cacheKeyForResult, result);
  return result;
}
