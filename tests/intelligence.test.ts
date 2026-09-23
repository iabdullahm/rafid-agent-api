import assert from "node:assert/strict";
import { test } from "node:test";
import { researchCompanyInput, findCompaniesInput, analyzeCompanyRiskInput } from "../src/schemas/intelligenceInputs.js";
import { researchCompanyOutput, findCompaniesOutput, analyzeCompanyRiskOutput } from "../src/schemas/intelligenceOutputs.js";
import { TtlCache, cacheKey } from "../src/intelligence/cache.js";
import {
  ESTIMATED_UPSTREAM_COST_USD, computeUnitEconomics, computeAllUnitEconomics, recordProviderCost, resetRecordedCosts
} from "../src/intelligence/costEstimator.js";
import { TavilyWebSearchProvider, NotConfiguredWebSearchProvider, toIntelligenceSources } from "../src/intelligence/webSearch/provider.js";
import { AnthropicSynthesizer, NotConfiguredSynthesizer } from "../src/intelligence/synthesis/synthesizer.js";
import { runCorporateIdentityCheck } from "../src/intelligence/risk/checks/identityCheck.js";
import { runWebsiteCheck, runDomainCheck, runSanctionsCheck } from "../src/intelligence/risk/checks/liveChecks.js";
import { runResearchCompany } from "../src/intelligence/companyResearch/provider.js";
import { runFindCompanies } from "../src/intelligence/companyDiscovery/provider.js";
import { runAnalyzeCompanyRisk } from "../src/intelligence/risk/provider.js";
import { researchCompany, findCompanies, analyzeCompanyRisk } from "../src/services/companyIntelligence.js";
import { classifyDataSource } from "../src/analytics/dataSource.js";
import { capabilities } from "../src/domain/capabilities.js";
import { z } from "zod";

/**
 * Rafid Agent Intelligence (Phase 1: research_company, find_companies, analyze_company_risk).
 * Every network-touching class here (TavilyWebSearchProvider, AnthropicSynthesizer) is tested
 * with an injected `fetchImpl` — this codebase's own established pattern (see
 * tests/ncsi.test.ts/tests/partner-feed-runner.test.ts's `fakeFetch`/`countingFetch` helpers) —
 * never the real network. Env-var-gated behavior (RISK_LIVE_CHECKS_ENABLED etc.) is tested by
 * temporarily setting/deleting process.env in a try/finally, matching tests/market-data.test.ts's
 * own OMAN_RECENT_SALES_DAYS pattern, so no test here leaks a env var into another test's run.
 */

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------------------------------------
// Input schema validation
// ---------------------------------------------------------------------------------------------

test("researchCompanyInput: requires a non-empty company name, defaults depth to standard, rejects unknown fields", () => {
  const parsed = researchCompanyInput.parse({ company: "Acme" });
  assert.equal(parsed.depth, "standard");
  assert.throws(() => researchCompanyInput.parse({}));
  assert.throws(() => researchCompanyInput.parse({ company: "" }));
  assert.throws(() => researchCompanyInput.parse({ company: "Acme", extra: true }));
  assert.throws(() => researchCompanyInput.parse({ company: "Acme", depth: "extreme" }));
});

test("findCompaniesInput: requires at least one search criterion, enforces employeeMin <= employeeMax, defaults limit to 20, caps at 100", () => {
  assert.throws(() => findCompaniesInput.parse({}), /at least one/i);
  const parsed = findCompaniesInput.parse({ industry: "fintech" });
  assert.equal(parsed.limit, 20);
  assert.throws(() => findCompaniesInput.parse({ industry: "fintech", employeeMin: 500, employeeMax: 10 }));
  assert.throws(() => findCompaniesInput.parse({ industry: "fintech", limit: 101 }));
  assert.equal(findCompaniesInput.parse({ industry: "fintech", limit: 100 }).limit, 100);
});

test("analyzeCompanyRiskInput: requires company or website, accepts a checks subset, rejects an unknown check", () => {
  assert.throws(() => analyzeCompanyRiskInput.parse({}));
  assert.doesNotThrow(() => analyzeCompanyRiskInput.parse({ company: "Acme" }));
  assert.doesNotThrow(() => analyzeCompanyRiskInput.parse({ website: "https://acme.example.com" }));
  assert.doesNotThrow(() => analyzeCompanyRiskInput.parse({ company: "Acme", checks: ["sanctions", "domain"] }));
  assert.throws(() => analyzeCompanyRiskInput.parse({ company: "Acme", checks: ["not_a_real_check"] }));
});

// ---------------------------------------------------------------------------------------------
// TtlCache / cacheKey
// ---------------------------------------------------------------------------------------------

test("TtlCache: returns a value before expiry, null after, and normalizes cacheKey parts", () => {
  let now = 1000;
  const cache = new TtlCache<string>(100, () => now);
  cache.set("k", "v");
  assert.equal(cache.get("k"), "v");
  now = 1099;
  assert.equal(cache.get("k"), "v");
  now = 1101;
  assert.equal(cache.get("k"), undefined);
  assert.equal(cache.size, 0);

  assert.equal(cacheKey("Acme", "HTTPS://Acme.com", null, undefined), cacheKey(" acme ", "https://acme.com ", "", ""));
});

// ---------------------------------------------------------------------------------------------
// costEstimator: no import of billing/catalog.ts (circular-import regression guard) + pure math
// ---------------------------------------------------------------------------------------------

test("costEstimator: computeUnitEconomics computes gross margin from an injected revenue figure, never importing billing/catalog.ts", () => {
  resetRecordedCosts();
  const econ = computeUnitEconomics("research_company", 0.15);
  const expected = ESTIMATED_UPSTREAM_COST_USD.research_company!;
  assert.equal(econ.revenuePerCallUSD, 0.15);
  assert.equal(econ.estimatedProviderCostPerCallUSD, expected.providerCostUSD);
  assert.equal(econ.estimatedLlmCostPerCallUSD, expected.llmCostUSD);
  assert.equal(econ.estimatedGrossMarginPerCallUSD, Math.round((0.15 - expected.providerCostUSD - expected.llmCostUSD) * 10000) / 10000);
  assert.equal(econ.recordedCallsThisProcess, 0);

  recordProviderCost({ provider: "Tavily", estimatedCostUSD: 0.005, requestId: null, capability: "research_company" });
  const econ2 = computeUnitEconomics("research_company", 0.15);
  assert.equal(econ2.recordedCallsThisProcess, 1);
  assert.equal(econ2.recordedActualCostUSDThisProcess, 0.005);
  resetRecordedCosts();
});

test("costEstimator: computeAllUnitEconomics covers every priced capability including ones with no cost estimate entry (zero, not fabricated)", () => {
  const prices = { analyze_property: 0.01, research_company: 0.15 };
  const all = computeAllUnitEconomics(prices);
  assert.equal(all.length, 2);
  const property = all.find(e => e.capability === "analyze_property")!;
  assert.equal(property.estimatedProviderCostPerCallUSD, 0);
  assert.equal(property.assumptions, null);
});

test("domain/capabilities.ts loads without a circular-import crash (research_company/find_companies/analyze_company_risk are registered)", () => {
  const names = capabilities.map(c => c.name);
  assert.ok(names.includes("research_company"));
  assert.ok(names.includes("find_companies"));
  assert.ok(names.includes("analyze_company_risk"));
});

// ---------------------------------------------------------------------------------------------
// TavilyWebSearchProvider (web search seam) — mock fetch only
// ---------------------------------------------------------------------------------------------

test("TavilyWebSearchProvider: parses results, records estimated cost, and dedupes nothing itself (caller's job)", async () => {
  resetRecordedCosts();
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse(200, {
    results: [{ title: "Acme raises Series B", url: "https://news.example.com/acme", content: "Acme Corp raised $10M", published_date: "2026-01-01" }]
  }));
  const provider = new TavilyWebSearchProvider({ apiKey: "test-key", fetchImpl, requestId: "req-1", capability: "research_company" });
  const results = await provider.search("Acme funding", { maxResults: 5 });
  assert.equal(results.length, 1);
  assert.equal(results[0].publisher, "news.example.com");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("api.tavily.com"));
  resetRecordedCosts();
});

test("TavilyWebSearchProvider: a non-ok response or network failure degrades to an empty result, never throws", async () => {
  const failing = new TavilyWebSearchProvider({ apiKey: "k", fetchImpl: fakeFetch(() => new Response("nope", { status: 500 })).fetchImpl, requestId: null, capability: "research_company" });
  assert.deepEqual(await failing.search("q", { maxResults: 5 }), []);

  const erroring = new TavilyWebSearchProvider({
    apiKey: "k",
    fetchImpl: (async () => { throw new Error("network down"); }) as typeof fetch,
    requestId: null, capability: "research_company"
  });
  assert.deepEqual(await erroring.search("q", { maxResults: 5 }), []);
});

test("NotConfiguredWebSearchProvider always returns empty results; toIntelligenceSources maps web results to the shared source shape", async () => {
  assert.deepEqual(await new NotConfiguredWebSearchProvider().search(), []);
  const sources = toIntelligenceSources([{ title: "T", url: "https://x.example.com", snippet: "s", publishedAt: null, publisher: "x.example.com" }], "2026-09-23T00:00:00.000Z");
  assert.equal(sources[0].sourceType, "web_search");
  assert.equal(sources[0].observedAt, "2026-09-23T00:00:00.000Z");
});

// ---------------------------------------------------------------------------------------------
// AnthropicSynthesizer (LLM abstraction) — mock fetch only, always schema-validated
// ---------------------------------------------------------------------------------------------

const testSchema = z.object({ overview: z.string().nullable() });

test("AnthropicSynthesizer: validates model JSON against the output schema before returning it", async () => {
  resetRecordedCosts();
  const { fetchImpl } = fakeFetch(() => jsonResponse(200, { content: [{ type: "text", text: '```json\n{"overview":"A software company."}\n```' }] }));
  const synthesizer = new AnthropicSynthesizer({ apiKey: "k", model: "claude-x", fetchImpl });
  const result = await synthesizer.synthesize({ instruction: "extract", evidence: [], capability: "research_company", requestId: null }, testSchema);
  assert.deepEqual(result, { overview: "A software company." });
  resetRecordedCosts();
});

test("AnthropicSynthesizer: retries once on invalid JSON, then returns null rather than trusting unvalidated output", async () => {
  let attempt = 0;
  const { fetchImpl } = fakeFetch(() => {
    attempt++;
    return jsonResponse(200, { content: [{ type: "text", text: "not json at all" }] });
  });
  const synthesizer = new AnthropicSynthesizer({ apiKey: "k", model: "claude-x", fetchImpl });
  const result = await synthesizer.synthesize({ instruction: "extract", evidence: [], capability: "research_company", requestId: null }, testSchema);
  assert.equal(result, null);
  assert.equal(attempt, 2);
});

test("AnthropicSynthesizer: a schema-violating JSON response is rejected, never returned unvalidated", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(200, { content: [{ type: "text", text: '{"overview": 12345}' }] }));
  const synthesizer = new AnthropicSynthesizer({ apiKey: "k", model: "claude-x", fetchImpl });
  const result = await synthesizer.synthesize({ instruction: "extract", evidence: [], capability: "research_company", requestId: null }, testSchema);
  assert.equal(result, null);
});

test("AnthropicSynthesizer: a non-ok API response returns null without throwing; NotConfiguredSynthesizer always returns null", async () => {
  const synthesizer = new AnthropicSynthesizer({ apiKey: "k", model: "claude-x", fetchImpl: fakeFetch(() => new Response("err", { status: 500 })).fetchImpl });
  assert.equal(await synthesizer.synthesize({ instruction: "x", evidence: [], capability: "research_company", requestId: null }, testSchema), null);
  assert.equal(await new NotConfiguredSynthesizer().synthesize(), null);
});

// ---------------------------------------------------------------------------------------------
// analyze_company_risk: corporate_identity check reuses search_oman_company's own service,
// honestly tiers demo-dataset matches, and never fabricates a match for an unknown company.
// ---------------------------------------------------------------------------------------------

test("runCorporateIdentityCheck: a known demo-dataset company is a performed, automated_indicator-tiered match (never confirmed_evidence for demo data)", async () => {
  const outcome = await runCorporateIdentityCheck("Al Noor Trading");
  assert.equal(outcome.status, "performed");
  assert.equal(outcome.evidence[0]?.tier, "automated_indicator");
  assert.match(outcome.summary ?? "", /demo dataset/i);
});

test("runCorporateIdentityCheck: an unknown company correctly reports no match rather than a false negative claim", async () => {
  const outcome = await runCorporateIdentityCheck("Totally Unknown Company Ltd Zzz999");
  assert.equal(outcome.status, "performed");
  assert.equal(outcome.evidence[0]?.tier, "missing_information");
  assert.equal(outcome.sources.length, 0);
});

test("runCorporateIdentityCheck: no company name is not_applicable, not a failed check", async () => {
  const outcome = await runCorporateIdentityCheck(null);
  assert.equal(outcome.status, "not_applicable");
});

// ---------------------------------------------------------------------------------------------
// Risk live checks (domain/website/sanctions): honest not_configured default; RISK_LIVE_CHECKS_ENABLED
// gate; website check reuses domain/oman SSRF protection unchanged.
// ---------------------------------------------------------------------------------------------

test("runWebsiteCheck/runDomainCheck/runSanctionsCheck: report not_configured by default (RISK_LIVE_CHECKS_ENABLED unset) and never touch the network", async () => {
  delete process.env.RISK_LIVE_CHECKS_ENABLED;
  assert.equal((await runWebsiteCheck("https://acme.example.com")).status, "not_configured");
  assert.equal((await runDomainCheck("https://acme.example.com")).status, "not_configured");
  assert.equal((await runSanctionsCheck("Acme Corporation")).status, "not_configured");
});

test("runWebsiteCheck: with live checks enabled, an SSRF-unsafe URL (private/loopback address) is rejected before any request, reusing domain/oman/feedSecurity.ts unchanged", async () => {
  process.env.RISK_LIVE_CHECKS_ENABLED = "true";
  try {
    const outcome = await runWebsiteCheck("http://127.0.0.1:8080/internal");
    assert.equal(outcome.status, "unavailable");
    assert.equal(outcome.evidence[0]?.tier, "automated_indicator");
    assert.match(outcome.findings.join(" "), /rejected/i);
  } finally {
    delete process.env.RISK_LIVE_CHECKS_ENABLED;
  }
});

test("runWebsiteCheck: with live checks enabled, an unparseable/malformed URL is handled as unavailable rather than throwing", async () => {
  process.env.RISK_LIVE_CHECKS_ENABLED = "true";
  try {
    const outcome = await runWebsiteCheck("not a url");
    assert.equal(outcome.status, "unavailable");
  } finally {
    delete process.env.RISK_LIVE_CHECKS_ENABLED;
  }
});

test("runWebsiteCheck/runDomainCheck/runSanctionsCheck: no website/company given reports not_applicable", async () => {
  assert.equal((await runWebsiteCheck(null)).status, "not_applicable");
  assert.equal((await runDomainCheck(null)).status, "not_applicable");
  assert.equal((await runSanctionsCheck(null)).status, "not_applicable");
});

// ---------------------------------------------------------------------------------------------
// Orchestration: honest "not configured" defaults for all three Phase 1 capabilities (the exact
// path the generic per-capability test loops in tests/http.test.ts/mcp.test.ts/x402.test.ts
// exercise via c.execute(c.example)) — schema-valid, no fabrication, confidence reflects reality.
// ---------------------------------------------------------------------------------------------

test("research_company: with no web search provider configured, returns an honest empty/null result validated by its own output schema", async () => {
  delete process.env.WEB_SEARCH_PROVIDER;
  delete process.env.INTELLIGENCE_LLM_PROVIDER;
  const result = await runResearchCompany({ company: "Acme Corporation" });
  researchCompanyOutput.parse(result); // throws on schema violation
  assert.equal(result.dataMode, "not_configured");
  assert.equal(result.confidence, 0);
  assert.deepEqual(result.sources, []);
  assert.equal(result.overview, null);
});

test("find_companies: with no web search provider configured, returns no companies (never fabricated) and reports appliedLimit 0", async () => {
  delete process.env.WEB_SEARCH_PROVIDER;
  const result = await runFindCompanies({ industry: "fintech", limit: 15 });
  findCompaniesOutput.parse(result);
  assert.equal(result.dataMode, "not_configured");
  assert.deepEqual(result.companies, []);
  assert.equal(result.resultCount, 0);
  assert.equal(result.requestedLimit, 15);
  assert.equal(result.appliedLimit, 0);
});

test("find_companies: the internal result cap (20) is reported honestly via requestedLimit vs appliedLimit even when a live provider is configured", async () => {
  process.env.WEB_SEARCH_PROVIDER = "tavily";
  process.env.TAVILY_API_KEY = "test-key";
  try {
    const result = await runFindCompanies({ industry: "fintech", limit: 100 });
    findCompaniesOutput.parse(result);
    assert.equal(result.requestedLimit, 100);
    assert.ok(result.appliedLimit <= 20);
  } finally {
    delete process.env.WEB_SEARCH_PROVIDER;
    delete process.env.TAVILY_API_KEY;
  }
});

test("analyze_company_risk: with nothing configured beyond the always-on corporate identity check, the output validates and never returns a safe/unsafe verdict field", async () => {
  delete process.env.RISK_LIVE_CHECKS_ENABLED;
  delete process.env.WEB_SEARCH_PROVIDER;
  const result = await runAnalyzeCompanyRisk({ company: "Acme Corporation", website: "https://acme.example.com" });
  analyzeCompanyRiskOutput.parse(result);
  assert.ok(!("verdict" in result));
  assert.ok(!("safe" in result));
  assert.equal(result.checks.corporateIdentity.status, "performed");
  assert.equal(result.checks.domain.status, "not_configured");
});

test("analyze_company_risk: calling execute() twice in the same process returns identical results (no cache-induced drift) — the exact invariant the generic per-capability test loops rely on", async () => {
  delete process.env.RISK_LIVE_CHECKS_ENABLED;
  delete process.env.WEB_SEARCH_PROVIDER;
  const capability = capabilities.find(c => c.name === "analyze_company_risk")!;
  const first = await capability.execute(capability.example);
  const second = await capability.execute(capability.example);
  assert.deepEqual(first, second);
});

test("services/companyIntelligence.ts thin wrappers delegate to the same orchestration functions", async () => {
  delete process.env.WEB_SEARCH_PROVIDER;
  const direct = await runResearchCompany({ company: "Acme Corporation" });
  const wrapped = await researchCompany({ company: "Acme Corporation" });
  assert.deepEqual(direct, wrapped);
  assert.deepEqual(await findCompanies({ industry: "fintech" }), await runFindCompanies({ industry: "fintech" }));
  assert.deepEqual(await analyzeCompanyRisk({ company: "Acme Corporation" }), await runAnalyzeCompanyRisk({ company: "Acme Corporation" }));
});

// ---------------------------------------------------------------------------------------------
// analytics/dataSource.ts: new classification branches for the 3 intelligence capabilities
// ---------------------------------------------------------------------------------------------

test("classifyDataSource: reads research_company/find_companies/analyze_company_risk's own dataMode field honestly", () => {
  assert.equal(classifyDataSource("research_company", { dataMode: "live" }), "live_provider");
  assert.equal(classifyDataSource("research_company", { dataMode: "not_configured" }), "not_configured");
  assert.equal(classifyDataSource("find_companies", { dataMode: "live" }), "live_provider");
  assert.equal(classifyDataSource("analyze_company_risk", { dataMode: "not_configured" }), "not_configured");
  assert.equal(classifyDataSource("research_company", {}), "unknown");
});
