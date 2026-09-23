import { MemoryReputationEvidenceCache } from "../../company-reputation/evidenceCache.js";
import { evidenceId } from "../../company-reputation/deduplication.js";
import { FixtureProvider, newsItem, registryRecord, sanctionsEntry } from "../../company-reputation/examples/syntheticScenario.js";
import type { NormalizedEvidence, ProviderCategory, ProviderFetchResult } from "../../company-reputation/types.js";
import type { Applicability, ProviderContext, ReputationProvider, ReputationQuery } from "../../company-reputation/providers/types.js";
import { MemoryAssessmentStore } from "../assessmentStore.js";
import { DEFAULT_CATEGORY_WEIGHTS, FATF_CALL_FOR_ACTION } from "../config.js";
import { withRole } from "../providers/index.js";
import type { BusinessRiskDependencies } from "../service.js";
import type { BusinessRiskProvider } from "../types.js";

/**
 * EXPLICITLY SYNTHETIC documentation scenario for business_risk_score.
 *
 * "Example Trading Ltd" is fictional; every publisher uses the reserved `.example` TLD (RFC 2606) or
 * the IANA example.com site; registry numbers are made up. The fixtures are fed through the REAL
 * pipeline (normalization → resolution → detectors → scoring → confidence → recommendation) by
 * scripts/generateBusinessRiskExample.ts to produce the registry's exampleOutput, and a test asserts
 * the published example still equals the pipeline output — the documented example is real pipeline
 * output over synthetic evidence, never hand-typed "intelligence". No network is used.
 *
 * Not imported by any runtime code path.
 */

export const BRS_SYNTHETIC_NOW = new Date("2026-09-23T10:00:00.000Z");
export const BRS_SYNTHETIC_EXAMPLE_INPUT = {
  companyName: "Example Trading Ltd",
  country: "GB",
  website: "https://example.com"
} as const;

export function websiteEvidence(now: Date, over: Partial<NormalizedEvidence["metadata"]> = {}, title = "Example Trading Ltd — Wholesale packaging supplies"): NormalizedEvidence {
  return {
    id: evidenceId("website_homepage", "https://example.com"), type: "website", providerId: "website_homepage", sourceName: "Company website (example.com)",
    sourceUrl: "https://example.com/", sourceDomain: "example.com", sourceRecordId: null, sourceTier: 3, title,
    summary: "Website responded with HTTP 200 over HTTPS.", publishedAt: null, observedAt: now.toISOString(), jurisdiction: null, companyIdentifiers: { domain: "example.com" },
    quality: 0.5, relevance: 1,
    metadata: {
      reachable: true, httpStatus: 200, https: true, finalDomain: "example.com", redirectedToOtherDomain: false, truncated: false,
      textExcerpt: "Example Trading Ltd supplies wholesale packaging to retailers across the UK. About us. Contact us. Example Trading Ltd is registered in England and Wales. Privacy policy. Terms.",
      injectionDetected: false, hasContactLink: true, hasAboutLink: true, hasPrivacyPolicy: true, hasTerms: true, emailDomains: ["example.com"], hasPhone: true,
      parkedIndicators: false, underConstruction: false, mentionsRegistrationDetails: true, contentLength: 180, ...over
    }
  };
}

export function rdapEvidence(now: Date, facts: { found: boolean; registeredAt?: string | null; expiresAt?: string | null; statuses?: string[] } = { found: true, registeredAt: "2018-02-11T00:00:00.000Z", expiresAt: "2027-02-11T00:00:00.000Z", statuses: ["client transfer prohibited"] }): NormalizedEvidence {
  return {
    id: evidenceId("domain_rdap", "example.com"), type: "domain", providerId: "domain_rdap", sourceName: "RDAP domain registration data",
    sourceUrl: "https://rdap.example/domain/example.com", sourceDomain: "rdap.example", sourceRecordId: "example.com", sourceTier: 1,
    title: "Domain registration record for example.com", summary: facts.found ? `Registered: ${facts.registeredAt ?? "not published"}; expires: ${facts.expiresAt ?? "not published"}.` : "No RDAP registration record was found for this domain.",
    publishedAt: null, observedAt: now.toISOString(), jurisdiction: null, companyIdentifiers: { domain: "example.com" }, quality: 1, relevance: 1,
    metadata: { domain: "example.com", found: facts.found, registeredAt: facts.registeredAt ?? null, expiresAt: facts.expiresAt ?? null, statuses: facts.statuses ?? [] }
  };
}

export function filingEvidence(now: Date, number: string, facts: NormalizedEvidence["metadata"]): NormalizedEvidence {
  return {
    id: evidenceId("financial_uk_companies_house_filings", number), type: "registry", providerId: "financial_uk_companies_house_filings", sourceName: "UK Companies House filing status",
    sourceUrl: `https://registry.example/company/${number}/filing-history`, sourceDomain: "registry.example", sourceRecordId: number, sourceTier: 1,
    title: `Filing status of EXAMPLE TRADING LIMITED`, summary: `Accounts overdue: ${facts.accountsOverdue ? "yes" : "no"}. Confirmation statement overdue: ${facts.confirmationStatementOverdue ? "yes" : "no"}`,
    publishedAt: typeof facts.lastAccountsMadeUpTo === "string" ? facts.lastAccountsMadeUpTo : null, observedAt: now.toISOString(), jurisdiction: "GB",
    companyIdentifiers: { legalName: "EXAMPLE TRADING LIMITED", registrationNumber: number, country: "GB" }, quality: 1, relevance: 1,
    metadata: { recordKind: "company_filing_status", legalName: "EXAMPLE TRADING LIMITED", registrationNumber: number, country: "GB", registryName: "UK Companies House", filingDetail: true, ...facts }
  };
}

export const ukRegistryRecord = (now: Date, over: Partial<Parameters<typeof registryRecord>[2]> = {}) => {
  const e = registryRecord("registry_uk_companies_house", now, {
    recordId: "09876543", legalName: "EXAMPLE TRADING LIMITED", registrationNumber: "09876543", lei: null, country: "GB", city: "London",
    status: "active", incorporationDate: "2015-11-03", registryName: "UK Companies House", ...over
  });
  return { ...e, metadata: { ...e.metadata, registeredAddress: "1 Example Street, London, EC1A 1AA" } };
};

/** A fixture that, like the real website/RDAP/threat providers, only applies when a website was supplied. */
export class WebFixtureProvider implements ReputationProvider {
  private readonly inner: FixtureProvider;
  readonly retryable = false;
  constructor(readonly id: string, readonly name: string, readonly category: ProviderCategory, fixture: ConstructorParameters<typeof FixtureProvider>[3]) {
    this.inner = new FixtureProvider(id, name, category, fixture);
  }
  applicability(q: ReputationQuery): Applicability {
    return q.website || q.domain ? this.inner.applicability() : { status: "not_applicable", reason: "No website or domain was supplied." };
  }
  cacheKey(q: ReputationQuery): string { return `${this.inner.cacheKey(q)}|${q.domain ?? ""}`; }
  fetch(q: ReputationQuery, ctx: ProviderContext): Promise<ProviderFetchResult> { return this.inner.fetch(q, ctx); }
}

export function brsSyntheticProviders(): BusinessRiskProvider[] {
  return [
    withRole(new FixtureProvider("registry_gleif", "GLEIF Global LEI Index", "registry", () => []), "corporate"),
    withRole(new FixtureProvider("registry_uk_companies_house", "UK Companies House", "registry", (_q, now) => [ukRegistryRecord(now)]), "corporate"),
    withRole(new FixtureProvider("registry_oman_rafid", "Rafid Oman company registry", "registry", "not_configured"), "corporate"),
    withRole(new WebFixtureProvider("website_homepage", "Company website", "website", (_q, now) => [websiteEvidence(now)]), "digital"),
    withRole(new WebFixtureProvider("domain_rdap", "Domain registration (RDAP)", "domain", (_q, now) => [rdapEvidence(now)]), "digital"),
    withRole(new FixtureProvider("financial_uk_companies_house_filings", "UK Companies House filing status", "registry", (q, now) => [
      filingEvidence(now, q.registrationNumber ?? "09876543", { accountsOverdue: true, confirmationStatementOverdue: false, lastAccountsMadeUpTo: "2025-11-30", accountsNextDue: "2026-08-31", statusDetail: null, hasInsolvencyHistory: false })
    ]), "financial"),
    withRole(new FixtureProvider("sanctions_un_consolidated", "UN Security Council Consolidated List", "sanctions", (q, now) => [
      // A loosely similar listed name returned by the list's pre-filter — must NOT become a match.
      sanctionsEntry("sanctions_un_consolidated", now, { name: "EXAMPLE TRADE AND TRANSPORT COMPANY", listName: "UN Security Council Consolidated List", reference: "XXe.001", countries: ["Atlantis"], queriedNames: [q.companyName] })
    ]), "sanctions"),
    withRole(new FixtureProvider("sanctions_us_csl", "US Consolidated Screening List (includes OFAC SDN)", "sanctions", () => []), "sanctions"),
    withRole(new FixtureProvider("sanctions_eu_fsf", "EU Financial Sanctions Files (consolidated list)", "sanctions", "not_configured"), "sanctions"),
    withRole(new FixtureProvider("news_web_search", "News and public web search", "news", (_q, now) => [
      newsItem("news_web_search", now, { url: "https://trade-news.example/2026/04/example-trading-supplier-lawsuit", title: "Packaging supplier sues Example Trading Ltd over unpaid invoices", summary: "A packaging manufacturer has filed a lawsuit against London-based Example Trading Ltd alleging unpaid invoices of £85,000. Example Trading disputes the claim.", publishedAt: "2026-04-14T09:00:00.000Z" }),
      newsItem("news_web_search", now, { url: "https://city-paper.example/business/example-trading-new-warehouse", title: "Example Trading opens new warehouse in Dartford", summary: "Wholesale packaging distributor Example Trading Ltd has opened a 40,000 sq ft warehouse in Dartford.", publishedAt: "2025-10-02T08:00:00.000Z" }),
      // Same-name company in ANOTHER jurisdiction — must be excluded, never attributed.
      newsItem("news_web_search", now, { url: "https://harbour-times.example/2026/02/example-trading-llc-fined", title: "Example Trading LLC fined by Dubai regulator", summary: "Example Trading LLC, a Dubai-based firm, was fined by the UAE regulator.", publishedAt: "2026-02-01T08:00:00.000Z" })
    ]), "news"),
    withRole(new FixtureProvider("reviews_web_search", "Review platforms and forums (web search)", "reviews", (_q, now) => [
      newsItem("reviews_web_search", now, { url: "https://reviews.example/review/example.com", title: "Example Trading Reviews | Reviews Example", summary: "Example Trading Ltd is rated 4.1 out of 5 based on 146 reviews. Customers mention fast delivery.", publishedAt: "2026-09-01T00:00:00.000Z", tier: 3, type: "review" })
    ]), "news"),
    withRole(new FixtureProvider("regulatory_web_search", "Regulator and enforcement publications (web search)", "news", () => []), "regulatory"),
    withRole(new WebFixtureProvider("threat_google_safe_browsing", "Google Safe Browsing", "website", "not_configured"), "digital")
  ];
}

export function brsSyntheticDependencies(overrides: Partial<BusinessRiskDependencies> = {}): BusinessRiskDependencies {
  return {
    providers: brsSyntheticProviders(),
    cache: new MemoryReputationEvidenceCache(),
    ttls: { registry: 7 * 86_400_000, sanctions: 12 * 3_600_000, news: 86_400_000, reviews: 3 * 86_400_000, website: 3 * 86_400_000, domain: 7 * 86_400_000 },
    maxStaleMs: 14 * 86_400_000, timeoutMs: 5000, maxAttempts: 2, disabled: new Set(), now: () => BRS_SYNTHETIC_NOW,
    weights: { weights: DEFAULT_CATEGORY_WEIGHTS, source: "default" },
    highRiskJurisdictions: { codes: new Set(FATF_CALL_FOR_ACTION.codes), source: `FATF call-for-action list as of ${FATF_CALL_FOR_ACTION.asOf}` },
    assessments: new MemoryAssessmentStore(),
    ...overrides
  };
}
