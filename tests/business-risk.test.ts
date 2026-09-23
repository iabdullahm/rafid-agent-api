import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import http from "node:http";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { buildOpenapi } from "../src/api/openapi.js";
import { capabilities } from "../src/domain/capabilities.js";
import { prices } from "../src/billing/catalog.js";
import { BillingService } from "../src/billing/service.js";
import { MemoryUsageRepository } from "../src/billing/usage.js";
import { MAX_DISCOVERY_DECLARATION_CHARS, buildX402Info, discoveryDeclaration } from "../src/billing/x402.js";
import { classifyDataSource } from "../src/analytics/dataSource.js";
import { ApiError, publicError } from "../src/utils/errors.js";
import { businessRiskScoreInput } from "../src/schemas/businessRiskInputs.js";
import { businessRiskScoreOutput, type BusinessRiskScoreOutput } from "../src/schemas/businessRiskOutputs.js";
import { buildBusinessRiskQuery, identityKeyOf, runBusinessRiskScore, type BusinessRiskDependencies } from "../src/business-risk/service.js";
import {
  BRS_SYNTHETIC_EXAMPLE_INPUT, BRS_SYNTHETIC_NOW, brsSyntheticDependencies, brsSyntheticProviders, filingEvidence, rdapEvidence, ukRegistryRecord, websiteEvidence
} from "../src/business-risk/examples/syntheticScenario.js";
import { BRS_SYNTHETIC_EXAMPLE_NOTICE } from "../src/domain/examples/businessRiskSyntheticNotice.js";
import { BUSINESS_RISK_SCORE_EXAMPLE_OUTPUT } from "../src/domain/examples/businessRiskScoreExample.js";
import { FixtureProvider, newsItem, registryRecord, sanctionsEntry } from "../src/company-reputation/examples/syntheticScenario.js";
import { MemoryReputationEvidenceCache } from "../src/company-reputation/evidenceCache.js";
import { CompaniesHouseFilingsProvider, RegulatoryActionsProvider, SafeBrowsingProvider, withRole } from "../src/business-risk/providers/index.js";
import { DEFAULT_CATEGORY_WEIGHTS, RISK_LEVEL_BANDS, SEVERITY_POINTS, SIGNAL_RULES, getCategoryWeights, riskLevelFor } from "../src/business-risk/config.js";
import { clamp, computeScore, scoreCategory } from "../src/business-risk/scoring.js";
import { computeConfidence } from "../src/business-risk/confidence.js";
import { recommend } from "../src/business-risk/recommendation.js";
import { makeSignal, addressConsistent } from "../src/business-risk/signals.js";
import { MemoryAssessmentStore } from "../src/business-risk/assessmentStore.js";
import type { ProviderContext, ReputationProvider, ReputationQuery } from "../src/company-reputation/providers/types.js";
import type { NormalizedEvidence, ProviderCategory, ProviderFetchResult } from "../src/company-reputation/types.js";
import type { BusinessRiskProvider, CoverageLevel, ProviderRole, RiskCategory } from "../src/business-risk/types.js";
import type { WebSearchProvider } from "../src/intelligence/webSearch/provider.js";

/**
 * business_risk_score. Every provider is a deterministic in-memory fixture, or a real provider
 * class exercised with an injected fetch / search — the suite never touches the network.
 */

const key = "test-only-not-a-real-credential-12345";
const wallet = "0x1234567890123456789012345678901234567890";
const ENDPOINT = "/api/v1/risk/business-risk-score";

type Fixture = ConstructorParameters<typeof FixtureProvider>[3];

/** Counts outbound fetches so tests can prove what was (not) called. */
class Counting implements ReputationProvider {
  calls = 0;
  constructor(readonly inner: ReputationProvider) {}
  get id() { return this.inner.id; }
  get name() { return this.inner.name; }
  get category() { return this.inner.category; }
  get retryable() { return this.inner.retryable; }
  applicability(q: ReputationQuery) { return this.inner.applicability(q); }
  cacheKey(q: ReputationQuery) { return this.inner.cacheKey(q); }
  async fetch(q: ReputationQuery, ctx: ProviderContext): Promise<ProviderFetchResult> { this.calls++; return this.inner.fetch(q, ctx); }
}

const ROLE_OF: Record<string, ProviderRole> = Object.fromEntries(brsSyntheticProviders().map(p => [p.id, p.role]));
const CATEGORY_OF: Record<string, ProviderCategory> = Object.fromEntries(brsSyntheticProviders().map(p => [p.id, p.category]));

/** The synthetic scenario with some providers replaced (by id). Returns deps + call counters. */
function scenario(replace: Record<string, Fixture | ReputationProvider> = {}, overrides: Partial<BusinessRiskDependencies> = {}) {
  const counters: Record<string, Counting> = {};
  const providers: BusinessRiskProvider[] = brsSyntheticProviders().map(p => {
    const r = replace[p.id];
    const inner: ReputationProvider = r === undefined ? p : typeof r === "object" && "fetch" in r ? r : new FixtureProvider(p.id, p.name, p.category, r as Fixture);
    const counting = new Counting(inner);
    counters[p.id] = counting;
    return withRole(counting, p.role);
  });
  return { deps: brsSyntheticDependencies({ providers, ...overrides }), counters };
}

const run = (input: unknown, deps: BusinessRiskDependencies) => runBusinessRiskScore(input, deps);
const flagCodes = (r: BusinessRiskScoreOutput) => r.riskFlags.map(f => f.code);
const positiveCodes = (r: BusinessRiskScoreOutput) => r.positiveSignals.map(f => f.code);
async function rejection(p: Promise<unknown>): Promise<ApiError> {
  try { await p; } catch (e) { if (e instanceof ApiError) return e; throw e; }
  throw new Error("expected an ApiError");
}

async function withServer<T>(config: ReturnType<typeof loadConfig>, fn: (base: string) => Promise<T>, options: Parameters<typeof createApp>[1] = {}): Promise<T> {
  const app = createApp(config, { logger: () => {}, ...options });
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally { server.closeAllConnections(); server.close(); }
}

// ---------------------------------------------------------------------------------------------
// 1–5: assessment, input validation and normalization
// ---------------------------------------------------------------------------------------------

test("1. valid business assessment: full pipeline over mocked providers returns a schema-valid, evidence-backed result", async () => {
  const r = await run(BRS_SYNTHETIC_EXAMPLE_INPUT, brsSyntheticDependencies());
  assert.ok(businessRiskScoreOutput.safeParse(r).success);
  assert.equal(r.status, "assessed");
  assert.equal(r.business.legalName, "EXAMPLE TRADING LIMITED");
  assert.equal(r.business.registrationNumber, "09876543");
  assert.equal(r.business.registrationStatus, "active");
  assert.equal(r.business.resolutionStatus, "resolved");
  assert.ok(r.business.entityMatchConfidence >= 0.85);
  assert.ok(r.riskScore !== null && r.riskScore >= 0 && r.riskScore <= 100);
  assert.equal(r.riskLevel, riskLevelFor(r.riskScore!));
  assert.ok(r.confidence > 0.7);
  assert.ok(flagCodes(r).includes("ACCOUNTS_OVERDUE"));
  assert.ok(positiveCodes(r).includes("ACTIVE_REGISTRATION") && positiveCodes(r).includes("NO_SANCTIONS_MATCH"));
  assert.equal(r.recommendation.action, "enhanced_due_diligence");
  assert.equal(r.evaluatedAt, BRS_SYNTHETIC_NOW.toISOString());
  for (const c of ["corporateRisk", "financialRisk", "complianceRisk", "reputationRisk", "operationalRisk", "digitalRisk"] as const) assert.equal(typeof r.components[c], "number");
});

test("2. invalid input: companyName required, strict unknown fields, validated country/website/LEI/aliases — rejected before any provider runs", async () => {
  const bad: unknown[] = [
    {}, { companyName: "" }, { companyName: "Ltd" }, { companyName: "Acme", unexpected: true }, { companyName: "Acme", country: "Narnia" },
    { companyName: "Acme", website: "not a url" }, { companyName: "Acme", website: "https://10.0.0.1" }, { companyName: "Acme", lei: "12345678901234567890" },
    { companyName: "Acme", knownAliases: ["A1", "B2", "C3", "D4", "E5", "F6"] }, { companyName: "Acme", includeNews: "yes" }, { companyName: "Acme", registrationNumber: "<script>" }
  ];
  for (const input of bad) assert.equal(businessRiskScoreInput.safeParse(input).success, false, JSON.stringify(input));
  assert.ok(businessRiskScoreInput.safeParse({ companyName: "Acme Trading" }).success, "only companyName is required");
  const { deps, counters } = scenario();
  await assert.rejects(run({ companyName: "Acme", country: "Narnia" }, deps), (e: unknown) => publicError(e).status === 400 && publicError(e).error.code === "INVALID_INPUT");
  assert.equal(Object.values(counters).reduce((s, c) => s + c.calls, 0), 0);
});

test("3. name normalization: whitespace collapsed, legal-form-insensitive core key, aliases de-duplicated against the name", () => {
  const q = buildBusinessRiskQuery(businessRiskScoreInput.parse({ companyName: "  Example   Trading  Ltd ", knownAliases: ["EXAMPLE TRADING LIMITED", "Example Wholesale", "example wholesale ltd"] }));
  assert.equal(q.companyName, "Example Trading Ltd");
  assert.equal(q.nameKey, "EXAMPLE TRADING");
  assert.deepEqual(q.knownAliases, ["Example Wholesale"], "an alias with the same core as the name or another alias is dropped");
});

test("4. domain normalization: websites/hostnames normalize to an https origin and registrable domain", () => {
  const cases: [string, string, string][] = [
    ["HTTPS://WWW.Example.com/about?x=1", "https://www.example.com", "example.com"],
    ["example.co.uk", "https://example.co.uk", "example.co.uk"],
    ["http://shop.example.com/", "https://shop.example.com", "shop.example.com"]
  ];
  for (const [raw, url, domain] of cases) {
    const q = buildBusinessRiskQuery(businessRiskScoreInput.parse({ companyName: "Example", website: raw }));
    assert.equal(q.website, url, raw);
    assert.equal(q.domain, domain, raw);
  }
});

test("5. country normalization: ISO alpha-2/alpha-3/English names/aliases map to ISO 3166 alpha-2", () => {
  for (const [raw, code] of [["GB", "GB"], ["gbr", "GB"], ["United Kingdom", "GB"], ["UK", "GB"], ["Sultanate of Oman", "OM"], ["om", "OM"], ["United States", "US"]] as const) {
    const q = buildBusinessRiskQuery(businessRiskScoreInput.parse({ companyName: "Example", country: raw }));
    assert.equal(q.country?.code, code, raw);
  }
});

// ---------------------------------------------------------------------------------------------
// 6–7: entity resolution
// ---------------------------------------------------------------------------------------------

test("6. entity ambiguity: similar same-country registry candidates → AMBIGUOUS_ENTITY 409 with candidates; no stage-2 (paid) provider is called", async () => {
  const { deps, counters } = scenario({
    registry_uk_companies_house: (_q, now) => [
      ukRegistryRecord(now),
      registryRecord("registry_uk_companies_house", now, { recordId: "11223344", legalName: "EXAMPLE TRADING LTD", registrationNumber: "11223344", lei: null, country: "GB", city: "Leeds", status: "active", incorporationDate: "2020-01-01", registryName: "UK Companies House" })
    ]
  });
  const err = await rejection(run({ companyName: "Example Trading Ltd", country: "GB" }, deps));
  assert.equal(err.status, 409);
  assert.equal(err.code, "AMBIGUOUS_ENTITY");
  const details = err.details as { status: string; candidates: { registrationNumber: string }[]; suggestedIdentifiers: string[] };
  assert.equal(details.status, "ambiguous_entity");
  assert.deepEqual(details.candidates.map(c => c.registrationNumber).sort(), ["09876543", "11223344"]);
  assert.ok(details.suggestedIdentifiers.includes("registrationNumber"));
  for (const id of ["news_web_search", "reviews_web_search", "regulatory_web_search", "sanctions_un_consolidated", "financial_uk_companies_house_filings"]) assert.equal(counters[id]!.calls, 0, `${id} must not run for an ambiguous entity`);
  // The same request disambiguated by registration number resolves.
  const resolved = await run({ companyName: "Example Trading Ltd", country: "GB", registrationNumber: "11223344" }, scenario({ registry_uk_companies_house: (_q, now) => [registryRecord("registry_uk_companies_house", now, { recordId: "11223344", legalName: "EXAMPLE TRADING LTD", registrationNumber: "11223344", lei: null, country: "GB", city: "Leeds", status: "active", incorporationDate: "2020-01-01", registryName: "UK Companies House" })] }).deps);
  assert.equal(resolved.business.registrationNumber, "11223344");
  assert.equal(resolved.business.resolutionStatus, "resolved");
  // The structured error renders with its candidates on every channel (shared publicError).
  const rendered = publicError(err);
  assert.equal(rendered.status, 409);
  assert.deepEqual((rendered.error as { details: unknown }).details, err.details);
});

test("7. entity not found: jurisdiction registry has no such company and no other presence → ENTITY_NOT_FOUND 404; with a working website it is scored as an unverified identity instead", async () => {
  const empty = { registry_uk_companies_house: () => [] as NormalizedEvidence[] };
  const err = await rejection(run({ companyName: "Ghost Holdings Ltd", country: "GB" }, scenario(empty).deps));
  assert.equal(err.status, 404);
  assert.equal(err.code, "ENTITY_NOT_FOUND");
  assert.deepEqual((err.details as { registriesChecked: string[] }).registriesChecked, ["GLEIF Global LEI Index", "UK Companies House"]);

  const withSite = await run({ companyName: "Example Trading Ltd", country: "GB", website: "https://example.com" }, scenario(empty).deps);
  assert.equal(withSite.status, "assessed");
  assert.ok(flagCodes(withSite).includes("IDENTITY_NOT_FOUND_IN_REGISTRY"));
  assert.equal(withSite.business.identityVerifiedAgainstRegistry, false);
  assert.equal(withSite.recommendation.action, "manual_review");
  assert.ok(withSite.confidence <= 0.55, "unverified identity caps confidence");

  const regNo = await run({ companyName: "Example Trading Ltd", country: "GB", website: "https://example.com", registrationNumber: "99999999" }, scenario(empty).deps);
  assert.ok(flagCodes(regNo).includes("REGISTRATION_NUMBER_NOT_FOUND"));
  const flag = regNo.riskFlags.find(f => f.code === "REGISTRATION_NUMBER_NOT_FOUND")!;
  const ev = regNo.evidence.find(e => e.id === flag.evidenceIds[0])!;
  assert.equal(ev.recordType, "lookup_result");
  assert.match(ev.claim, /no company for registration number 99999999/);

  // Without a jurisdiction registry (only the global LEI index), absence is NOT evidence: unverified, no flag.
  const noJurisdiction = await run({ companyName: "Example Trading Ltd", country: "GB", website: "https://example.com" }, scenario({ ...empty, registry_uk_companies_house: "not_configured" }).deps);
  assert.ok(!flagCodes(noJurisdiction).includes("IDENTITY_NOT_FOUND_IN_REGISTRY"));
  assert.equal(noJurisdiction.business.resolutionStatus, "unverified");
});

// ---------------------------------------------------------------------------------------------
// 8–10: sanctions
// ---------------------------------------------------------------------------------------------

const listed = (name: string, extra: { countries?: string[]; aliases?: string[]; listName?: string; identifiers?: string[] } = {}): Fixture => (q, now) => [
  sanctionsEntry("sanctions_un_consolidated", now, { name, listName: extra.listName ?? "UN Security Council Consolidated List", reference: "QDe.999", countries: extra.countries ?? [], aliases: extra.aliases, identifiers: extra.identifiers, queriedNames: [q.companyName, ...(q.aliases ?? [])] })
];

test("8. sanctions exact match: exact normalized name corroborated by country → high-confidence, critical flag, score floor, avoid_automated_transaction", async () => {
  const r = await run(BRS_SYNTHETIC_EXAMPLE_INPUT, scenario({ sanctions_un_consolidated: listed("EXAMPLE TRADING LIMITED", { countries: ["United Kingdom"] }) }).deps);
  assert.equal(r.sanctionsScreening.status, "high_confidence_match");
  const m = r.sanctionsScreening.matches[0]!;
  assert.equal(m.matchStrength, "high");
  assert.equal(m.matchType, "exact_normalized_name");
  assert.deepEqual(m.corroboratingIdentifiers, ["country"]);
  assert.equal(m.listType, "sanctions");
  const flag = r.riskFlags.find(f => f.code === "SANCTIONS_HIGH_CONFIDENCE_MATCH")!;
  assert.equal(flag.severity, "critical");
  assert.ok(r.riskScore! >= 85);
  assert.equal(r.riskLevel, "critical");
  assert.equal(r.recommendation.action, "avoid_automated_transaction");
  assert.ok(r.scoreBreakdown.floorsApplied.some(f => f.code === "SANCTIONS_HIGH_CONFIDENCE_MATCH"));
});

test("9. sanctions alias match: a listed ALIAS equal to the company, and a supplied knownAlias equal to a listed name, are both detected", async () => {
  const byListedAlias = await run(BRS_SYNTHETIC_EXAMPLE_INPUT, scenario({ sanctions_un_consolidated: listed("ZETA GLOBAL HOLDINGS", { aliases: ["Example Trading Ltd"], countries: ["GB"] }) }).deps);
  const m = byListedAlias.sanctionsScreening.matches[0]!;
  assert.equal(m.matchedAlias, "Example Trading Ltd");
  assert.equal(m.matchStrength, "high");

  const withFormerName: Fixture = (_q, now) => { const e = ukRegistryRecord(now); return [{ ...e, metadata: { ...e.metadata, otherNames: ["OLD HARBOUR IMPORTS LIMITED"] } }]; };
  const { deps, counters } = scenario({ sanctions_un_consolidated: listed("NORTHWIND SUPPLIES", { countries: ["GB"] }), registry_uk_companies_house: withFormerName });
  const byKnownAlias = await run({ ...BRS_SYNTHETIC_EXAMPLE_INPUT, knownAliases: ["Northwind Supplies"] }, deps);
  assert.ok(counters.sanctions_un_consolidated!.calls === 1);
  assert.ok(byKnownAlias.sanctionsScreening.namesScreened.includes("Northwind Supplies"));
  assert.ok(byKnownAlias.sanctionsScreening.namesScreened.includes("OLD HARBOUR IMPORTS LIMITED"), "former registry names are screened too");
  assert.ok(!byKnownAlias.sanctionsScreening.namesScreened.includes("EXAMPLE TRADING LIMITED"), "a registry name with the same core as the company is not screened twice");
  assert.equal(byKnownAlias.sanctionsScreening.matches[0]!.listedName, "NORTHWIND SUPPLIES");
});

test("10. sanctions fuzzy false-positive rejection: similar names are not matches; an uncorroborated exact name is only 'possible' → manual_review, never 'sanctioned'", async () => {
  for (const similar of ["EXAMPLE TRADE AND TRANSPORT COMPANY", "EXAMPLE TRADING HOUSE INTERNATIONAL", "SAMPLE TRADING LTD"]) {
    const r = await run(BRS_SYNTHETIC_EXAMPLE_INPUT, scenario({ sanctions_un_consolidated: listed(similar, { countries: ["GB"] }) }).deps);
    assert.equal(r.sanctionsScreening.matches.length, 0, similar);
    assert.ok(positiveCodes(r).includes("NO_SANCTIONS_MATCH"), similar);
  }
  const contradicted = await run(BRS_SYNTHETIC_EXAMPLE_INPUT, scenario({ sanctions_un_consolidated: listed("EXAMPLE TRADING LIMITED", { countries: ["Iran"] }) }).deps);
  assert.equal(contradicted.sanctionsScreening.matches[0]!.matchStrength, "possible");
  const flag = contradicted.riskFlags.find(f => f.code === "SANCTIONS_POSSIBLE_MATCH")!;
  assert.equal(flag.severity, "medium");
  assert.equal(flag.factStatus, "alleged");
  assert.equal(flag.requiresVerification, true);
  assert.ok(!flagCodes(contradicted).includes("SANCTIONS_HIGH_CONFIDENCE_MATCH"));
  assert.equal(contradicted.recommendation.action, "manual_review");
  assert.ok(contradicted.riskScore! < 85, "a name-only candidate never triggers the sanctions floor");
  // Export-control / debarment lists are classified separately.
  const debarred = await run(BRS_SYNTHETIC_EXAMPLE_INPUT, scenario({ sanctions_un_consolidated: listed("EXAMPLE TRADING LIMITED", { countries: ["GB"], listName: "Entity List (EL) - Bureau of Industry and Security" }) }).deps);
  assert.equal(debarred.sanctionsScreening.matches[0]!.listType, "export_control_or_debarment");
  assert.ok(flagCodes(debarred).includes("RESTRICTED_PARTY_HIGH_CONFIDENCE_MATCH"));
});

// ---------------------------------------------------------------------------------------------
// 11–16: media, freshness, provider failures, missing data
// ---------------------------------------------------------------------------------------------

const newsFixture = (...items: Parameters<typeof newsItem>[2][]): Fixture => (_q, now) => items.map(i => newsItem("news_web_search", now, i));

test("11. negative-news evidence: established outcomes vs allegations are distinguished; other-jurisdiction namesakes are excluded", async () => {
  const r = await run(BRS_SYNTHETIC_EXAMPLE_INPUT, scenario({
    news_web_search: newsFixture(
      { url: "https://major-news.example/2026/05/example-trading-convicted", title: "Example Trading Ltd convicted of fraud over fake invoices", summary: "A court convicted London-based Example Trading Ltd of fraud.", publishedAt: "2026-05-02T09:00:00.000Z", tier: 2 },
      { url: "https://blog.example/example-trading-scam-claims", title: "Customers allege Example Trading Ltd is a scam", summary: "Several people allege Example Trading Ltd runs a scam.", publishedAt: "2026-06-01T09:00:00.000Z" },
      { url: "https://harbour-times.example/example-trading-llc-fined", title: "Example Trading LLC fined by Dubai regulator", summary: "Example Trading LLC, a Dubai-based firm, was fined by the UAE regulator.", publishedAt: "2026-02-01T08:00:00.000Z" }
    )
  }).deps);
  const established = r.riskFlags.find(f => f.code === "ADVERSE_MEDIA_ESTABLISHED")!;
  assert.equal(established.factStatus, "reported");
  assert.equal(established.severity, "critical");
  const allegation = r.riskFlags.find(f => f.code === "ADVERSE_MEDIA_ALLEGATION")!;
  assert.equal(allegation.factStatus, "alleged");
  assert.equal(r.evidence.find(e => e.id === allegation.evidenceIds[0])!.evidenceClass, "allegation");
  assert.ok(!JSON.stringify(r.riskFlags).includes("Dubai"), "a same-name company in another jurisdiction is never attributed");
  assert.ok(r.limitations.some(l => /appeared to concern a different entity/.test(l)));
  assert.equal(r.recommendation.action, "avoid_automated_transaction");
});

test("12. stale evidence: old articles are flagged stale and weigh less than fresh ones; stale cache is flagged DATA_STALE", async () => {
  const story = (publishedAt: string) => scenario({ news_web_search: newsFixture({ url: `https://major-news.example/${publishedAt}/lawsuit`, title: "Example Trading Ltd fined by regulator over misleading claims", summary: "Example Trading Ltd was fined by the regulator.", publishedAt, tier: 2 }) }).deps;
  const fresh = await run(BRS_SYNTHETIC_EXAMPLE_INPUT, story("2026-08-01T00:00:00.000Z"));
  const old = await run(BRS_SYNTHETIC_EXAMPLE_INPUT, story("2020-08-01T00:00:00.000Z"));
  const f = fresh.riskFlags.find(x => x.code === "REGULATORY_ENFORCEMENT")!, o = old.riskFlags.find(x => x.code === "REGULATORY_ENFORCEMENT")!;
  assert.ok(o.confidence < f.confidence, "a six-year-old enforcement story weighs less than a fresh one");
  assert.equal(old.evidence.find(e => e.id === o.evidenceIds[0])!.stale, true);
  assert.equal(fresh.evidence.find(e => e.id === f.evidenceIds[0])!.stale, false);
  assert.ok(old.components.complianceRisk! < fresh.components.complianceRisk!);

  // Stale cache: an expired cached entry served because the live source failed.
  const cache = new MemoryReputationEvidenceCache();
  let failing = false;
  const flaky = new FixtureProvider("news_web_search", "News and public web search", "news", (_q, now) => {
    if (failing) throw Object.assign(new Error("down"), { name: "Error" });
    return [newsItem("news_web_search", now, { url: "https://major-news.example/x", title: "Example Trading opens depot", summary: "Example Trading Ltd opened a depot.", publishedAt: "2026-09-01T00:00:00.000Z", tier: 2 })];
  });
  let clock = BRS_SYNTHETIC_NOW;
  const d = scenario({ news_web_search: flaky }, { cache, now: () => clock }).deps;
  await run(BRS_SYNTHETIC_EXAMPLE_INPUT, d);
  failing = true;
  clock = new Date(BRS_SYNTHETIC_NOW.getTime() + 3 * 86_400_000);
  const r = await run(BRS_SYNTHETIC_EXAMPLE_INPUT, d);
  assert.equal(r.providers.find(p => p.provider === "News and public web search")!.status, "stale_cache");
  assert.ok(r.warnings.some(w => w.code === "DATA_STALE"));
  assert.ok(r.confidenceBreakdown.contradictions.some(c => c.startsWith("STALE_EVIDENCE_SETS")));
});

test("13. provider timeout: a hung non-identity provider is cut off and reported; when every identity source times out the call fails with PROVIDER_TIMEOUT 504", async () => {
  const hung: ReputationProvider = { id: "news_web_search", name: "News and public web search", category: "news", retryable: false, applicability: () => ({ status: "ready" }), cacheKey: () => "k", fetch: () => new Promise(() => {}) };
  const r = await run(BRS_SYNTHETIC_EXAMPLE_INPUT, scenario({ news_web_search: hung }, { timeoutMs: 50 }).deps);
  assert.equal(r.status, "assessed");
  assert.equal(r.providers.find(p => p.provider === "News and public web search")!.status, "timeout");
  assert.ok(r.warnings.some(w => w.code === "PROVIDER_TIMEOUT"));

  const allTimeout = scenario({ registry_uk_companies_house: "timeout", registry_gleif: "timeout", website_homepage: "timeout", domain_rdap: "timeout" });
  const err = await rejection(run(BRS_SYNTHETIC_EXAMPLE_INPUT, allTimeout.deps));
  assert.equal(err.status, 504);
  assert.equal(err.code, "PROVIDER_TIMEOUT");
  assert.equal(allTimeout.counters.news_web_search!.calls, 0, "no paid search after the identity check failed");
  const unavailable = await rejection(run(BRS_SYNTHETIC_EXAMPLE_INPUT, scenario({ registry_uk_companies_house: "unavailable", registry_gleif: "timeout", website_homepage: "unavailable", domain_rdap: "unavailable" }).deps));
  assert.equal(unavailable.code, "PROVIDER_UNAVAILABLE");
  assert.equal(unavailable.status, 503);
});

test("14. provider partial failure: one sanctions list unavailable → partial screening, lower confidence, other evidence still used", async () => {
  const full = await run(BRS_SYNTHETIC_EXAMPLE_INPUT, brsSyntheticDependencies());
  const partial = await run(BRS_SYNTHETIC_EXAMPLE_INPUT, scenario({ sanctions_us_csl: "unavailable", reviews_web_search: "unavailable" }).deps);
  assert.equal(partial.sanctionsScreening.status, "partial");
  assert.deepEqual(partial.sanctionsScreening.listsUnavailable, ["US Consolidated Screening List (includes OFAC SDN)"]);
  assert.ok(partial.warnings.filter(w => w.code === "PROVIDER_UNAVAILABLE").length === 2);
  assert.ok(partial.confidence <= full.confidence);
  assert.ok(flagCodes(partial).includes("ACCOUNTS_OVERDUE"), "remaining evidence is still scored");
  assert.equal(partial.dataCoverage.compliance, "medium");
});

test("15. missing financial data: LIMITED_FINANCIAL_HISTORY is informational (weight 0), lowers coverage/confidence, never the score", async () => {
  const withFilings = await run(BRS_SYNTHETIC_EXAMPLE_INPUT, scenario({ financial_uk_companies_house_filings: (q, now) => [filingEvidence(now, "09876543", { accountsOverdue: false, confirmationStatementOverdue: false })] }).deps);
  const without = await run(BRS_SYNTHETIC_EXAMPLE_INPUT, scenario({ financial_uk_companies_house_filings: "not_configured" }).deps);
  const flag = without.riskFlags.find(f => f.code === "LIMITED_FINANCIAL_HISTORY")!;
  assert.equal(flag.severity, "info");
  assert.equal(flag.weight, 0);
  assert.equal(flag.scoreImpactPoints, 0);
  assert.equal(without.dataCoverage.financial, "medium");
  assert.equal(withFilings.dataCoverage.financial, "high");
  assert.ok(without.confidence < withFilings.confidence);
  assert.equal(without.components.financialRisk, 20, "no financial signal: the checked baseline, not an inflated guess");
  assert.ok(without.limitations.some(l => /no financial figures are estimated/.test(l)));
});

test("16. insufficient evidence: with nothing configured the result is status insufficient_data (null score, zero confidence), never a guessed score; thin evidence → manual_review", async () => {
  const r = await run(BRS_SYNTHETIC_EXAMPLE_INPUT, scenario(Object.fromEntries(brsSyntheticProviders().map(p => [p.id, "not_configured" as const]))).deps);
  assert.equal(r.status, "insufficient_data");
  assert.equal(r.riskScore, null);
  assert.equal(r.riskLevel, null);
  assert.equal(r.confidence, 0);
  assert.equal(r.evaluatedAt, null);
  assert.equal(r.recommendation.action, "manual_review");
  assert.deepEqual(r.recommendation.reasonCodes, ["INSUFFICIENT_DATA"]);
  assert.ok(Object.values(r.components).every(v => v === null));
  assert.ok(businessRiskScoreOutput.safeParse(r).success);

  // Only one sanctions list checked, identity unverified: a score exists but confidence is low.
  const thin = scenario(Object.fromEntries(brsSyntheticProviders().filter(p => p.id !== "sanctions_us_csl").map(p => [p.id, "not_configured" as const])));
  const t = await run({ companyName: "Example Trading Ltd" }, thin.deps);
  assert.equal(t.status, "assessed");
  assert.ok(t.confidence < 0.4);
  assert.equal(t.recommendation.action, "manual_review");
  assert.ok(t.recommendation.reasonCodes.includes("RULE_LOW_CONFIDENCE"));
  assert.ok(t.warnings.some(w => w.code === "COUNTRY_NOT_PROVIDED"));
});

// ---------------------------------------------------------------------------------------------
// 17–22: scoring engine
// ---------------------------------------------------------------------------------------------

test("17. score clamped between 0 and 100 (categories and overall, including extreme and non-finite inputs)", () => {
  const huge = Array.from({ length: 50 }, () => makeSignal("COMPANY_DISSOLVED", 1, ["ev_x"], "x"));
  assert.equal(scoreCategory(15, huge).score <= 100, true);
  assert.equal(scoreCategory(15, Array.from({ length: 50 }, () => makeSignal("ACTIVE_REGISTRATION", 1, ["ev_x"], "x"))).score >= 0, true);
  const all: Record<RiskCategory, CoverageLevel> = { corporate: "high", financial: "high", compliance: "high", reputation: "high", operational: "high", digital: "high" };
  const s = computeScore(huge, all, DEFAULT_CATEGORY_WEIGHTS);
  assert.ok(s.riskScore <= 100 && s.riskScore >= 0);
  assert.equal(clamp(250), 100);
  assert.equal(clamp(-5), 0);
  assert.equal(clamp(Number.NaN), 0);
  assert.equal(makeSignal("ACCOUNTS_OVERDUE", 7, [], "x").confidence, 1, "confidence is clamped to [0, 1]");
});

test("18. risk-level boundaries: 0–20 low · 21–40 moderate · 41–60 elevated · 61–80 high · 81–100 critical", () => {
  const expected: [number, string][] = [[0, "low"], [20, "low"], [21, "moderate"], [40, "moderate"], [41, "elevated"], [60, "elevated"], [61, "high"], [80, "high"], [81, "critical"], [100, "critical"]];
  for (const [score, level] of expected) assert.equal(riskLevelFor(score), level, String(score));
  assert.deepEqual(RISK_LEVEL_BANDS.map(b => [b.min, b.max]), [[0, 20], [21, 40], [41, 60], [61, 80], [81, 100]]);
});

test("19. category-weight calculation: overall = weighted mean of covered categories (weights renormalized), contributions sum to the raw score; env weights validated", () => {
  const cov = (over: Partial<Record<RiskCategory, CoverageLevel>>): Record<RiskCategory, CoverageLevel> => ({ corporate: "high", financial: "high", compliance: "high", reputation: "high", operational: "high", digital: "high", ...over });
  const signals = [makeSignal("ACCOUNTS_OVERDUE", 0.5, ["ev_1"], "x")];
  const s = computeScore(signals, cov({}), DEFAULT_CATEGORY_WEIGHTS);
  const manual = (Object.keys(DEFAULT_CATEGORY_WEIGHTS) as RiskCategory[]).reduce((sum, c) => sum + DEFAULT_CATEGORY_WEIGHTS[c] * s.categories[c].score!, 0);
  assert.ok(Math.abs(s.rawWeightedScore - manual) < 0.01);
  assert.ok(Math.abs((Object.values(s.categories).reduce((sum, c) => sum + (c.contribution ?? 0), 0)) - s.rawWeightedScore) < 0.05);
  const partial = computeScore(signals, cov({ reputation: "none", digital: "none" }), DEFAULT_CATEGORY_WEIGHTS);
  assert.equal(partial.categories.reputation.score, null);
  assert.equal(partial.categories.digital.contribution, null);
  const covered = 0.2 + 0.2 + 0.25 + 0.1;
  assert.ok(Math.abs(partial.categories.compliance.effectiveWeight - 0.25 / covered) < 0.0001);
  assert.ok(Math.abs(Object.values(partial.categories).reduce((sum, c) => sum + c.effectiveWeight, 0) - 1) < 0.001);
  assert.equal(Object.values(DEFAULT_CATEGORY_WEIGHTS).reduce((a, b) => a + b, 0).toFixed(6), "1.000000");
  assert.deepEqual(getCategoryWeights({ BUSINESS_RISK_CATEGORY_WEIGHTS: '{"compliance":0.5,"digital":0}' }).source, "env");
  assert.equal(getCategoryWeights({ BUSINESS_RISK_CATEGORY_WEIGHTS: '{"compliance":0.5,"digital":0}' }).weights.digital, 0);
  assert.equal(getCategoryWeights({ BUSINESS_RISK_CATEGORY_WEIGHTS: '{"nonsense":1}' }).source, "default_env_invalid");
  assert.equal(getCategoryWeights({ BUSINESS_RISK_CATEGORY_WEIGHTS: "not json" }).weights, DEFAULT_CATEGORY_WEIGHTS);
});

test("20. confidence calculation: documented weighted components, separate from risk, capped when identity is unverified", () => {
  const all: Record<RiskCategory, CoverageLevel> = { corporate: "high", financial: "high", compliance: "high", reputation: "high", operational: "high", digital: "high" };
  const record = { recordType: "source_record" as const, reliability: "authoritative" as const, freshness: 1 } as any;
  const high = computeConfidence({ entityMatchConfidence: 1, identityVerified: true, jurisdictionRegistryMatched: true, anyRegistryMatched: true, coverage: all, weights: DEFAULT_CATEGORY_WEIGHTS, sourceRecords: [record], signals: [], staleProviderRuns: 0 });
  assert.equal(high.confidence, 1);
  const none: Record<RiskCategory, CoverageLevel> = { corporate: "none", financial: "none", compliance: "medium", reputation: "none", operational: "none", digital: "none" };
  const low = computeConfidence({ entityMatchConfidence: 0.2, identityVerified: false, jurisdictionRegistryMatched: false, anyRegistryMatched: false, coverage: none, weights: DEFAULT_CATEGORY_WEIGHTS, sourceRecords: [], signals: [], staleProviderRuns: 0 });
  // 0.30×0.2 + 0.25×(0.25×0.66) + 0 + 0 + 0 + 0.10×1 = 0.20125
  assert.equal(low.confidence, 0.2);
  const capped = computeConfidence({ entityMatchConfidence: 0.45, identityVerified: false, jurisdictionRegistryMatched: false, anyRegistryMatched: false, coverage: all, weights: DEFAULT_CATEGORY_WEIGHTS, sourceRecords: [record], signals: [], staleProviderRuns: 0 });
  assert.equal(capped.confidence, 0.55);
  assert.deepEqual(capped.capsApplied, ["identity_not_verified:0.55"]);
  const contradicted = computeConfidence({ entityMatchConfidence: 1, identityVerified: true, jurisdictionRegistryMatched: true, anyRegistryMatched: true, coverage: all, weights: DEFAULT_CATEGORY_WEIGHTS, sourceRecords: [record], signals: [makeSignal("ADDRESS_MISMATCH", 1, ["e"], "x"), makeSignal("REDIRECTS_TO_OTHER_DOMAIN", 1, ["e"], "x")], staleProviderRuns: 0 });
  assert.equal(contradicted.components.consistency, 0.5);
  assert.equal(contradicted.confidence, 0.95);
});

test("21. deterministic scoring: same evidence + config → identical result, independent of provider order and of wall-clock time", async () => {
  const a = await run(BRS_SYNTHETIC_EXAMPLE_INPUT, brsSyntheticDependencies());
  const b = await run(BRS_SYNTHETIC_EXAMPLE_INPUT, brsSyntheticDependencies({ providers: [...brsSyntheticProviders()].reverse() }));
  assert.deepEqual(a, b);
  const c = await run({ ...BRS_SYNTHETIC_EXAMPLE_INPUT }, brsSyntheticDependencies());
  assert.deepEqual(a, c);
  assert.equal(a.assessmentId, c.assessmentId);
});

test("22. evidence-to-risk-flag traceability: every flag/positive signal cites evidence present in the response; every cited id resolves", async () => {
  const inputs: [unknown, BusinessRiskDependencies][] = [
    [BRS_SYNTHETIC_EXAMPLE_INPUT, brsSyntheticDependencies()],
    [BRS_SYNTHETIC_EXAMPLE_INPUT, scenario({ sanctions_un_consolidated: listed("EXAMPLE TRADING LIMITED", { countries: ["GB"] }) }).deps],
    [{ companyName: "Example Trading Ltd", country: "GB", website: "https://example.com", registrationNumber: "99999999" }, scenario({ registry_uk_companies_house: () => [] }).deps]
  ];
  for (const [input, deps] of inputs) {
    const r = await run(input, deps);
    const ids = new Set(r.evidence.map(e => e.id));
    for (const s of [...r.riskFlags, ...r.positiveSignals]) {
      if (s.weight === 0 && "severity" in s && s.severity === "info") continue;
      assert.ok(s.evidenceIds.length > 0, `${s.code} must cite evidence`);
      for (const id of s.evidenceIds) assert.ok(ids.has(id), `${s.code} cites ${id} which is missing from evidence[]`);
    }
    for (const m of r.sanctionsScreening.matches) assert.ok(ids.has(m.evidenceId));
    assert.equal(new Set(r.evidence.map(e => e.id)).size, r.evidence.length, "evidence ids are unique");
  }
});

// ---------------------------------------------------------------------------------------------
// 23–25: dedup, caching, failure isolation
// ---------------------------------------------------------------------------------------------

test("23. duplicate evidence removal: the same article from two providers/URL variants is one item; syndicated copies are one event", async () => {
  const title = "Packaging supplier sues Example Trading Ltd over unpaid invoices";
  const r = await run(BRS_SYNTHETIC_EXAMPLE_INPUT, scenario({
    news_web_search: newsFixture(
      { url: "https://trade-news.example/2026/04/lawsuit", title, summary: "A supplier sued Example Trading Ltd in London.", publishedAt: "2026-04-14T09:00:00.000Z" },
      { url: "https://www.trade-news.example/2026/04/lawsuit/?utm_source=feed", title, summary: "A supplier sued Example Trading Ltd in London.", publishedAt: "2026-04-14T09:00:00.000Z" },
      { url: "https://aggregator.example/story/1", title: `${title} | Aggregator Example`, summary: "A supplier sued Example Trading Ltd.", publishedAt: "2026-04-14T12:00:00.000Z" }
    ),
    regulatory_web_search: (_q, now) => [newsItem("regulatory_web_search", now, { url: "https://trade-news.example/2026/04/lawsuit", title, summary: "A supplier sued Example Trading Ltd in London.", publishedAt: "2026-04-14T09:00:00.000Z" })]
  }).deps);
  const lawsuits = r.riskFlags.filter(f => f.code === "ADVERSE_MEDIA_ALLEGATION");
  assert.equal(lawsuits.length, 1, "one underlying story → one flag");
  assert.equal(r.evidence.filter(e => e.sourceUrl?.includes("trade-news.example")).length, 1, "URL variants collapse into one evidence item");
  assert.ok(r.limitations.some(l => /duplicate or syndicated item\(s\) were merged/.test(l)));
});

test("24. cached result behavior: a repeat call is served from the evidence cache (no outbound fetch), keeps original retrieval times and yields the same assessment; identities never share cache rows", async () => {
  const cache = new MemoryReputationEvidenceCache();
  const assessments = new MemoryAssessmentStore();
  let clock = BRS_SYNTHETIC_NOW;
  const { deps, counters } = scenario({}, { cache, assessments, now: () => clock });
  const first = await run(BRS_SYNTHETIC_EXAMPLE_INPUT, deps);
  const callsAfterFirst = Object.values(counters).reduce((s, c) => s + c.calls, 0);
  clock = new Date(BRS_SYNTHETIC_NOW.getTime() + 60 * 60 * 1000);
  const second = await run(BRS_SYNTHETIC_EXAMPLE_INPUT, deps);
  assert.equal(Object.values(counters).reduce((s, c) => s + c.calls, 0), callsAfterFirst, "no provider was fetched again");
  assert.ok(second.providers.filter(p => p.status === "ok").every(p => p.fromCache));
  assert.equal(second.evaluatedAt, first.evaluatedAt, "the cached evidence keeps its ORIGINAL retrieval time");
  assert.equal(second.riskScore, first.riskScore);
  assert.equal(second.assessmentId, first.assessmentId);
  assert.equal(assessments.size, 1, "the same evidence snapshot is persisted once (dedup)");
  const stored = await assessments.latest(identityKeyOf(buildBusinessRiskQuery(businessRiskScoreInput.parse(BRS_SYNTHETIC_EXAMPLE_INPUT))));
  assert.equal(stored?.riskScore, first.riskScore);
  assert.deepEqual(stored?.flagCodes, flagCodes(first));

  // Same name, different country: a different identity key and different provider cache keys.
  const gb = buildBusinessRiskQuery(businessRiskScoreInput.parse({ companyName: "Example Trading Ltd", country: "GB" }));
  const om = buildBusinessRiskQuery(businessRiskScoreInput.parse({ companyName: "Example Trading Ltd", country: "OM" }));
  assert.notEqual(identityKeyOf(gb), identityKeyOf(om));
  const provider = brsSyntheticProviders().find(p => p.id === "news_web_search")!;
  assert.notEqual(provider.cacheKey(gb), provider.cacheKey(om));
});

test("25. provider failure isolation: a provider that throws is contained; every other provider's evidence is still used", async () => {
  const exploding: ReputationProvider = { id: "reviews_web_search", name: "Review platforms and forums (web search)", category: "reviews", retryable: false, applicability: () => ({ status: "ready" }), cacheKey: () => "k", fetch: async () => { throw new Error("boom: secret-token-123"); } };
  const r = await run(BRS_SYNTHETIC_EXAMPLE_INPUT, scenario({ reviews_web_search: exploding }).deps);
  assert.equal(r.status, "assessed");
  assert.equal(r.providers.find(p => p.provider === "Review platforms and forums (web search)")!.status, "unavailable");
  assert.ok(flagCodes(r).includes("ACCOUNTS_OVERDUE") && flagCodes(r).includes("ADVERSE_MEDIA_ALLEGATION"));
  assert.ok(!JSON.stringify(r).includes("secret-token-123"), "internal error text never leaks");
});

// ---------------------------------------------------------------------------------------------
// Real provider adapters (injected fetch / search — no network)
// ---------------------------------------------------------------------------------------------

test("financial, regulatory and threat providers: filing facts parsed, searches restricted to regulator domains, Safe Browsing listings detected; keys never leak", async () => {
  const q = { ...buildBusinessRiskQuery(businessRiskScoreInput.parse({ companyName: "Example Trading Ltd", country: "GB", website: "https://example.com" })), registrationNumber: "9876543" };
  const ctx = { now: BRS_SYNTHETIC_NOW, signal: new AbortController().signal };
  let chUrl = "";
  const ch = new CompaniesHouseFilingsProvider({ apiKey: "ch-secret-key", fetchImpl: (async (url: string) => { chUrl = url; return new Response(JSON.stringify({
    company_name: "EXAMPLE TRADING LIMITED", company_status: "active", has_insolvency_history: false, date_of_creation: "2015-11-03",
    accounts: { overdue: true, next_due: "2026-08-31", last_accounts: { made_up_to: "2025-11-30", type: "micro-entity" } }, confirmation_statement: { overdue: false },
    registered_office_address: { address_line_1: "1 Example Street", locality: "London", postal_code: "EC1A 1AA" }, officers: [{ name: "PRIVATE PERSON" }]
  }), { status: 200 }); }) as typeof fetch });
  assert.equal(ch.applicability(q).status, "ready");
  assert.equal(ch.applicability({ ...q, filingDetailPresent: true } as ReputationQuery).status, "not_applicable");
  const res = await ch.fetch(q, ctx);
  assert.ok(chUrl.endsWith("/company/09876543"), "company numbers are zero-padded");
  const m = res.evidence[0]!.metadata;
  assert.equal(m.accountsOverdue, true);
  assert.equal(m.confirmationStatementOverdue, false);
  assert.equal(m.registeredAddress, "1 Example Street, London, EC1A 1AA");
  assert.ok(!JSON.stringify(res).includes("ch-secret-key") && !JSON.stringify(res).includes("PRIVATE PERSON"), "no credentials and no officer personal data");

  let searchOptions: any = null;
  const search: WebSearchProvider = { name: "fake", search: async () => [], searchWithStatus: async (_text: string, options: unknown) => { searchOptions = options; return { status: "ok", results: [{ title: "SEC charges Example Trading Ltd", url: "https://www.sec.gov/news/press-release/2026-1", snippet: "The SEC charged Example Trading Ltd.", publishedAt: "2026-01-10", publisher: "SEC" }] }; } } as unknown as WebSearchProvider;
  const reg = new RegulatoryActionsProvider(() => search, () => true);
  const regRes = await reg.fetch(q, ctx);
  assert.ok(searchOptions.domains.includes("sec.gov") && searchOptions.domains.includes("fca.org.uk"));
  assert.equal(regRes.evidence[0]!.type, "regulatory");
  assert.equal(regRes.evidence[0]!.sourceTier, 1);

  const sb = new SafeBrowsingProvider({ apiKey: "sb-secret-key", enabled: true, fetchImpl: (async () => new Response(JSON.stringify({ matches: [{ threatType: "SOCIAL_ENGINEERING" }] }), { status: 200 })) as unknown as typeof fetch });
  const sbRes = await sb.fetch(q, ctx);
  assert.equal(sbRes.evidence[0]!.metadata.listed, true);
  assert.ok(!JSON.stringify(sbRes).includes("sb-secret-key"));
  assert.equal(new SafeBrowsingProvider({ apiKey: null, enabled: true }).applicability(q).status, "not_configured");

  const listedSite = await run(BRS_SYNTHETIC_EXAMPLE_INPUT, scenario({ threat_google_safe_browsing: withRole(sb, "digital") }).deps);
  assert.ok(flagCodes(listedSite).includes("MALWARE_OR_PHISHING_LISTED"));
  assert.ok(listedSite.riskScore! >= 81);
});

test("operational and digital detectors: parked site, new domain, free webmail and address mismatch are flagged; a missing website is never a risk", async () => {
  const r = await run({ ...BRS_SYNTHETIC_EXAMPLE_INPUT, address: "99 Unrelated Road, Manchester, M1 1AA" }, scenario({
    website_homepage: (_q, now) => [websiteEvidence(now, { parkedIndicators: true, emailDomains: ["gmail.com"] })],
    domain_rdap: (_q, now) => [rdapEvidence(now, { found: true, registeredAt: "2026-08-20T00:00:00.000Z", expiresAt: "2027-08-20T00:00:00.000Z", statuses: [] })]
  }).deps);
  for (const code of ["WEBSITE_PARKED", "DOMAIN_NEWLY_REGISTERED", "FREE_EMAIL_ON_WEBSITE", "ADDRESS_MISMATCH"]) assert.ok(flagCodes(r).includes(code), code);
  assert.ok(addressConsistent("1 Example St, London EC1A 1AA", "1 Example Street, London, EC1A 1AA"));
  const noSite = await run({ companyName: "Example Trading Ltd", country: "GB" }, brsSyntheticDependencies());
  assert.equal(noSite.dataCoverage.digital, "none");
  assert.equal(noSite.components.digitalRisk, null);
  assert.ok(!flagCodes(noSite).some(c => /WEBSITE|DOMAIN/.test(c)));
  assert.ok(noSite.limitations.some(l => /No website was supplied/.test(l)));
  const skipped = await run({ ...BRS_SYNTHETIC_EXAMPLE_INPUT, includeNews: false, includeDigitalSignals: false }, brsSyntheticDependencies());
  assert.equal(skipped.dataCoverage.reputation, "none");
  assert.equal(skipped.dataCoverage.digital, "none");
  assert.ok(skipped.providers.filter(p => p.role === "news").every(p => p.status === "not_applicable"));
});

test("recommendation rules: most restrictive action wins with explicit reason codes", () => {
  const sig = (code: keyof typeof SIGNAL_RULES, confidence = 1) => makeSignal(code, confidence, ["e"], "x");
  assert.equal(recommend({ riskScore: 10, confidence: 0.9, entityMatchConfidence: 0.95, signals: [] }).action, "proceed");
  assert.equal(recommend({ riskScore: 10, confidence: 0.65, entityMatchConfidence: 0.95, signals: [] }).action, "proceed_with_monitoring");
  assert.equal(recommend({ riskScore: 30, confidence: 0.9, entityMatchConfidence: 0.95, signals: [] }).action, "proceed_with_monitoring");
  assert.equal(recommend({ riskScore: 30, confidence: 0.9, entityMatchConfidence: 0.95, signals: [sig("RECENTLY_INCORPORATED")] }).action, "enhanced_due_diligence");
  assert.equal(recommend({ riskScore: 50, confidence: 0.9, entityMatchConfidence: 0.95, signals: [] }).action, "enhanced_due_diligence");
  assert.equal(recommend({ riskScore: 30, confidence: 0.9, entityMatchConfidence: 0.95, signals: [sig("SANCTIONS_POSSIBLE_MATCH", 0.5)] }).action, "manual_review");
  assert.equal(recommend({ riskScore: 30, confidence: 0.9, entityMatchConfidence: 0.2, signals: [] }).action, "manual_review");
  const avoid = recommend({ riskScore: 85, confidence: 0.9, entityMatchConfidence: 0.95, signals: [sig("SANCTIONS_HIGH_CONFIDENCE_MATCH")] });
  assert.equal(avoid.action, "avoid_automated_transaction");
  assert.ok(avoid.reasonCodes.includes("SANCTIONS_HIGH_CONFIDENCE_MATCH") && avoid.reasonCodes.includes("RULE_RISK_SCORE_HIGH"));
  assert.equal(SEVERITY_POINTS.info, 0);
});

// ---------------------------------------------------------------------------------------------
// 26–35: platform integration
// ---------------------------------------------------------------------------------------------

test("26. REST exposure: POST /api/v1/risk/business-risk-score returns the envelope; invalid input → 400; structured errors carry details", async () => {
  const cap = capabilities.find(c => c.name === "business_risk_score")!;
  await withServer(loadConfig({ RAFID_API_KEYS: key }), async base => {
    const post = (body: unknown, apiKey = key) => fetch(base + ENDPOINT, { method: "POST", headers: { "X-API-Key": apiKey, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const ok = await post(cap.example);
    assert.equal(ok.status, 200);
    const body = await ok.json() as any;
    assert.equal(body.success, true);
    assert.equal(body.meta.tool, "business_risk_score");
    assert.equal(body.meta.price, 0.5);
    assert.ok(businessRiskScoreOutput.safeParse(body.data).success);
    assert.equal(body.data.status, "insufficient_data", "network-free default deployment: honest insufficient_data, not a guessed score");
    const bad = await post({ companyName: "Acme", country: "Narnia" });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as any).error.code, "INVALID_INPUT");
    assert.equal((await post(cap.example, "wrong")).status, 401);

    const original = cap.execute;
    (cap as any).execute = (input: unknown) => runBusinessRiskScore(input, scenario({
      registry_uk_companies_house: (_q, now) => [ukRegistryRecord(now), registryRecord("registry_uk_companies_house", now, { recordId: "11223344", legalName: "EXAMPLE TRADING LTD", registrationNumber: "11223344", lei: null, country: "GB", city: "Leeds", status: "active", incorporationDate: "2020-01-01", registryName: "UK Companies House" })]
    }).deps);
    try {
      const ambiguous = await post({ companyName: "Example Trading Ltd", country: "GB" });
      assert.equal(ambiguous.status, 409);
      const e = await ambiguous.json() as any;
      assert.equal(e.success, false);
      assert.equal(e.error.code, "AMBIGUOUS_ENTITY");
      assert.equal(e.error.details.candidates.length, 2);
      assert.ok(e.meta.requestId);
    } finally { (cap as any).execute = original; }
  });
});

test("27. MCP registration: business_risk_score is an MCP tool with the registry description, strict input schema and structured output", async () => {
  await withServer(loadConfig({ RAFID_API_KEYS: key }), async base => {
    const rpc = async (id: number, method: string, params: unknown) => (await (await fetch(base + "/mcp", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
    })).json()) as any;
    const listed = await rpc(1, "tools/list", {});
    const tool = listed.result.tools.find((t: any) => t.name === "business_risk_score");
    assert.ok(tool);
    assert.match(tool.description, /Assess the risk of doing business with a company/);
    assert.match(tool.description, /Before onboarding|before onboarding/i);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.required, ["companyName"]);
    assert.ok(tool.outputSchema.properties.riskScore && tool.outputSchema.properties.recommendation);
    assert.equal(tool.annotations.idempotentHint, true);
    const called = await rpc(2, "tools/call", { name: "business_risk_score", arguments: { companyName: "Example Trading Ltd", country: "GB" } });
    assert.ok(!called.result.isError);
    assert.ok(businessRiskScoreOutput.safeParse(called.result.structuredContent).success);
    const invalid = await rpc(3, "tools/call", { name: "business_risk_score", arguments: { country: "GB" } });
    assert.ok(invalid.result?.isError || invalid.error);
  });
});

test("28. capability registry: name, path, $0.50, category, schemas, idempotent, agent guidance", () => {
  const c = capabilities.find(x => x.name === "business_risk_score")!;
  assert.ok(c);
  assert.equal(c.path, "/risk/business-risk-score");
  assert.equal(c.price, 0.5);
  assert.equal(c.currency, "USD");
  assert.equal(c.category, "risk_intelligence");
  assert.equal(c.input, businessRiskScoreInput);
  assert.equal(c.output, businessRiskScoreOutput);
  assert.equal(c.idempotent, true);
  assert.equal(c.sideEffects, false);
  assert.ok(c.useCases.includes("Before paying a new business"));
  assert.ok(c.agentGuidance!.sampleQueries.some(s => /pay their invoice/.test(s.query)));
  assert.equal(capabilities.filter(x => x.name === "business_risk_score").length, 1);
  assert.equal(capabilities.filter(x => x.path === c.path).length, 1);
});

test("29. discovery endpoints: /api/v1/capabilities, /agent.json, /.well-known/agent.json, /.well-known/ai-plugin.json, /llms.txt, /api/v1/tools, /api/v1/pricing all describe it", async () => {
  await withServer(loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet }), async base => {
    for (const path of ["/agent.json", "/.well-known/agent.json", "/llms.txt", "/api/v1/capabilities", "/api/v1/pricing", "/api/v1/tools", "/openapi.json", "/api/v1/x402"]) {
      const text = await (await fetch(base + path)).text();
      assert.ok(text.includes("business_risk_score") || text.includes("business-risk-score"), path);
    }
    const plugin = await (await fetch(base + "/.well-known/ai-plugin.json")).json() as any;
    assert.ok(plugin.api.url.endsWith("/openapi.json"));
    const llms = await (await fetch(base + "/llms.txt")).text();
    assert.match(llms, /business_risk_score[\s\S]*\$0\.50/);
    const caps = await (await fetch(base + "/api/v1/capabilities")).json() as any;
    const entry = caps.data.find((x: any) => x.name === "business_risk_score");
    assert.equal(entry.price, 0.5);
    assert.equal(entry.category, "risk_intelligence");
    assert.ok(entry.sampleQueries.length >= 5);
    const agent = await (await fetch(base + "/agent.json")).json() as any;
    const tool = (agent.tools ?? agent.data?.tools).find((t: any) => t.name === "business_risk_score");
    assert.equal(tool.x402Endpoint, "/api/v1/x402/risk/business-risk-score");
    assert.ok(tool.inputSchema.examples.length > 0);
  });
});

test("30. OpenAPI: REST/x402 operations, Risk Intelligence tag, strict request schema, static example output, structured 404/409/503/504 errors; never executes the service", () => {
  const cap = capabilities.find(c => c.name === "business_risk_score")!;
  const original = cap.execute;
  let called = false;
  (cap as any).execute = () => { called = true; return original(cap.example); };
  try {
    const doc = buildOpenapi(loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet })) as { paths: Record<string, any>; tags: any[] };
    const op = doc.paths[ENDPOINT].post;
    assert.equal(op.operationId, "business_risk_score");
    assert.deepEqual(op.tags, ["Risk Intelligence"]);
    assert.equal(op.requestBody.content["application/json"].schema.additionalProperties, false);
    assert.deepEqual(op.requestBody.content["application/json"].examples.default.value, cap.example);
    assert.deepEqual(op.responses["200"].content["application/json"].examples.default.value.data, BUSINESS_RISK_SCORE_EXAMPLE_OUTPUT);
    for (const [status, code] of [["404", "ENTITY_NOT_FOUND"], ["409", "AMBIGUOUS_ENTITY"], ["503", "PROVIDER_UNAVAILABLE"], ["504", "PROVIDER_TIMEOUT"]]) {
      assert.equal(op.responses[status].content["application/json"].examples.default.value.error.code, code, status);
    }
    assert.equal(doc.paths["/api/v1/x402" + cap.path].post.operationId, "business_risk_score_x402");
    assert.equal(doc.paths["/api/v1/x402" + cap.path].post.responses["409"].content["application/json"].examples.default.value.error.code, "AMBIGUOUS_ENTITY");
    assert.ok(doc.paths["/v1" + cap.path].post.deprecated);
    assert.ok(doc.tags.find((t: any) => t.name === "Risk Intelligence").description.includes("business_risk_score"));
    assert.equal(called, false, "OpenAPI generation never runs the live service");
  } finally { (cap as any).execute = original; }
});

test("31. pricing metadata: $0.50 in the central catalog, BillingService, x402 requirement and GET /api/v1/x402; unit-economics estimate present", async () => {
  assert.equal(prices.business_risk_score, 0.5);
  const billing = new BillingService(new MemoryUsageRepository());
  assert.equal(billing.getToolPrice("business_risk_score"), 0.5);
  assert.equal(billing.buildX402PaymentRequirement("business_risk_score", "eip155:8453", wallet).price, "$0.50");
  const info = buildX402Info(loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet }), billing);
  const tool = info.tools.find(t => t.name === "business_risk_score")!;
  assert.equal(tool.price, 0.5);
  assert.equal(tool.endpoint, "/api/v1/x402/risk/business-risk-score");
  const { ESTIMATED_UPSTREAM_COST_USD } = await import("../src/intelligence/costEstimator.js");
  assert.ok(ESTIMATED_UPSTREAM_COST_USD.business_risk_score!.providerCostUSD < 0.5);
});

test("32. x402 enforcement: an unpaid request gets 402 with a $0.50 (500000 USDC atomic) requirement and a readable header; the service never executes", async () => {
  const facilitator = http.createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: ["bazaar"], signers: {} })); });
  facilitator.listen(0, "127.0.0.1");
  await once(facilitator, "listening");
  const cap = capabilities.find(c => c.name === "business_risk_score")!;
  const original = cap.execute;
  let executed = false;
  (cap as any).execute = async (input: unknown) => { executed = true; return original(input); };
  try {
    const config = { ...loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet }), x402FacilitatorUrl: `http://127.0.0.1:${(facilitator.address() as any).port}` };
    await withServer(config, async base => {
      const res = await fetch(base + "/api/v1/x402" + cap.path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cap.example) });
      assert.equal(res.status, 402);
      const header = res.headers.get("payment-required")!;
      assert.ok(header.length < 16_000, "the challenge fits Node's 16 KB response-header limit, so x402 clients can read it");
      const required = JSON.parse(Buffer.from(header, "base64").toString());
      assert.equal(required.accepts[0].amount, "500000");
      assert.equal(required.accepts[0].payTo, wallet);
      assert.ok(String(required.resource.url).endsWith("/api/v1/x402/risk/business-risk-score"));
      // An API key does not bypass the payment gate.
      const withKey = await fetch(base + "/api/v1/x402" + cap.path, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": key }, body: JSON.stringify(cap.example) });
      assert.equal(withKey.status, 402);
    });
    assert.equal(executed, false, "the paid service never runs without payment");
  } finally { (cap as any).execute = original; facilitator.close(); }
  const declaration = JSON.stringify(discoveryDeclaration(cap));
  assert.ok(declaration.length <= MAX_DISCOVERY_DECLARATION_CHARS);
});

test("33. L402 exposure: 402 challenge priced from $0.50; a paid token pays for one call; a failed call does not consume it", async () => {
  const { createHash, randomBytes } = await import("node:crypto");
  const { deserializeMacaroon, decodeL402Identifier } = await import("../src/billing/l402/macaroon.js");
  const { MemoryL402RedemptionStore } = await import("../src/billing/l402/redemptions.js");
  const { usdToSats } = await import("../src/billing/l402/rates.js");
  const preimages = new Map<string, Buffer>();
  const lightning = { name: "fake", async createInvoice(args: { amountSats: number }) { const p = randomBytes(32); const h = createHash("sha256").update(p).digest(); preimages.set(h.toString("hex"), p); return { paymentRequest: `lnbc${args.amountSats}n1fake`, paymentHash: h }; } };
  const pay = (mac: string) => preimages.get(decodeL402Identifier(deserializeMacaroon(mac)!.identifier)!.paymentHash.toString("hex"))!.toString("hex");
  const env = { RAFID_API_KEYS: key, L402_ENABLED: "true", LND_REST_URL: "https://lnd.example.test:8080", LND_INVOICE_MACAROON: "0201036c6e640258030a10".padEnd(60, "a"), L402_ROOT_KEY: "5c".repeat(32) };
  await withServer(loadConfig(env), async base => {
    const path = base + "/api/v1/l402" + ENDPOINT.replace("/api/v1", "");
    const post = (body: unknown, auth?: string) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body) });
    const unpaid = await post({ companyName: "Example Trading Ltd", country: "GB" });
    assert.equal(unpaid.status, 402);
    const challenge = /macaroon="([^"]+)"/.exec(unpaid.headers.get("www-authenticate") ?? "")![1]!;
    assert.equal(((await unpaid.json()) as any).l402.amountSats, usdToSats(0.5, 100_000));
    const auth = `L402 ${challenge}:${pay(challenge)}`;
    assert.equal((await post({ companyName: "Acme", country: "Narnia" }, auth)).status, 400);
    const paid = await post({ companyName: "Example Trading Ltd", country: "GB" }, auth);
    assert.equal(paid.status, 200, "the token survived the failed validation and pays for the valid call");
    assert.equal(((await paid.json()) as any).meta.tool, "business_risk_score");
    assert.equal((await post({ companyName: "Example Trading Ltd", country: "GB" }, auth)).status, 402, "one token buys one successful call");
  }, { l402Backend: lightning as any, l402Rates: { getRate: async () => ({ btcUsd: 100_000, source: "coinbase", fetchedAt: new Date().toISOString() }) } as any, l402Redemptions: new MemoryL402RedemptionStore() });
});

test("34. MPP exposure: charge route 402s at the registry price ($0.50 = 500000 raw units), rejects invalid input before payment, and a real mppx credential pays for one call (settled once)", async t => {
  const { randomBytes } = await import("node:crypto");
  const { Mppx: MppxClient, evm: evmClient } = await import("mppx/client");
  const { Assets } = await import("mppx/evm");
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  const { MppxProvider, MemoryMppKv, toMppxStore } = await import("../src/billing/mpp/index.js");
  const config = loadConfig({
    RAFID_API_KEYS: key, LOG_LEVEL: "silent", RATE_LIMIT_ENABLED: "false", MPP_ENABLED: "true", MPP_SECRET_KEY: randomBytes(32).toString("base64"), MPP_NETWORK: "tempo-testnet",
    MPP_MODES: "charge", MPP_CHARGE_METHODS: "evm", MPP_EVM_NETWORK: "eip155:84532", MPP_EVM_RECIPIENT: "0x29d4d3Ced89d7adcb0Ae47Ef6892CE24BD2b125f"
  });
  let settles = 0;
  const facilitator = {
    async verify(payload: any) { return { isValid: true, payer: payload?.payload?.authorization?.from }; },
    async settle(_payload: unknown, requirements: { network: string }) { settles++; return { success: true, transaction: "0x" + randomBytes(32).toString("hex"), network: requirements.network }; }
  };
  const kv = new MemoryMppKv();
  const provider = new MppxProvider(config.mpp, { chargeStore: toMppxStore(kv, "c:"), sessionStore: toMppxStore(kv, "s:"), evmFacilitator: facilitator as any });
  await withServer(config, async base => {
    const path = base + "/api/v1/mpp/charge/business_risk_score";
    const post = (body: unknown, headers: Record<string, string> = {}) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    const bad = await post({ companyName: "Acme", country: "Narnia" });
    assert.equal(bad.status, 400);
    assert.equal(bad.headers.get("www-authenticate"), null);
    const unpaid = await post({ companyName: "Example Trading Ltd", country: "GB" });
    assert.equal(unpaid.status, 402);
    const challenge = await unpaid.clone().json() as any;
    assert.equal(challenge.tool, "business_risk_score");
    assert.equal(challenge.amount, 0.5);
    for (const c of challenge.challenges) assert.equal(c.request.amount, "500000");
    const client = MppxClient.create({ polyfill: false, methods: [evmClient.charge({ account: privateKeyToAccount(generatePrivateKey()), currencies: [Assets.baseSepolia.USDC] })] as never });
    const credential = await client.createCredential(unpaid as never) as string;
    const paid = await post({ companyName: "Example Trading Ltd", country: "GB" }, { Authorization: credential });
    assert.equal(paid.status, 200);
    const body = await paid.json() as any;
    assert.equal(body.payment.amount, 0.5);
    assert.ok(businessRiskScoreOutput.safeParse(body.data).success);
    assert.equal(settles, 1);
  }, { mppProvider: provider });
});

test("35. example input/output schema validation: the static example validates and IS the real pipeline output over the synthetic scenario", async () => {
  const cap = capabilities.find(c => c.name === "business_risk_score")!;
  assert.deepEqual(cap.example, BRS_SYNTHETIC_EXAMPLE_INPUT);
  assert.ok(businessRiskScoreInput.safeParse(cap.example).success);
  assert.ok(businessRiskScoreOutput.safeParse(cap.exampleOutput).success);
  const regenerated = await runBusinessRiskScore(BRS_SYNTHETIC_EXAMPLE_INPUT, brsSyntheticDependencies());
  assert.deepEqual(cap.exampleOutput, { ...regenerated, limitations: [BRS_SYNTHETIC_EXAMPLE_NOTICE, ...regenerated.limitations] }, "run scripts/generateBusinessRiskExample.ts after changing the pipeline");
  const ex = cap.exampleOutput as BusinessRiskScoreOutput;
  assert.equal(ex.riskLevel, "moderate");
  assert.equal(ex.recommendation.action, "enhanced_due_diligence");
});

test("analytics data-source classification and no-secret output", async () => {
  assert.equal(classifyDataSource("business_risk_score", { providers: [{ status: "not_configured" }] }), "not_configured");
  assert.equal(classifyDataSource("business_risk_score", { providers: [{ status: "ok" }] }), "live_provider");
  const r = await run(BRS_SYNTHETIC_EXAMPLE_INPUT, brsSyntheticDependencies());
  const text = JSON.stringify(r);
  for (const secret of ["API_KEY", "apiKey", "Authorization", "Bearer "]) assert.ok(!text.includes(secret), secret);
  assert.ok(!("metadata" in (r.evidence[0] as object)), "raw provider metadata is never exposed");
});
