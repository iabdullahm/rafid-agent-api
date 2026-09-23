import { MemoryReputationEvidenceCache } from "../evidenceCache.js";
import { evidenceId } from "../deduplication.js";
import type { ReputationDependencies } from "../service.js";
import type { Applicability, ProviderContext, ReputationProvider, ReputationQuery } from "../providers/types.js";
import type { NormalizedEvidence, ProviderCategory, ProviderFetchResult } from "../types.js";

/**
 * EXPLICITLY SYNTHETIC documentation scenario for company_reputation_check.
 *
 * "Example Technologies Ltd" is a fictional company; every publisher uses the reserved `.example`
 * TLD (RFC 2606) or the fictional example.com site; the LEI is a made-up, checksum-valid value;
 * no real company, person or publisher is described. These fixtures are fed through the REAL
 * pipeline (normalization → resolution → analyzers → scoring → confidence) by
 * scripts/generateCompanyReputationExample.ts to produce the registry's exampleOutput, and a test
 * asserts the published example still equals the pipeline's output — so the documented example is
 * real pipeline output over synthetic evidence, never hand-typed "intelligence".
 *
 * Not imported by any runtime code path.
 */

export const SYNTHETIC_NOW = new Date("2026-09-23T08:00:00.000Z");
export const SYNTHETIC_EXAMPLE_INPUT = {
  companyName: "Example Technologies Ltd",
  country: "United Kingdom",
  website: "https://example.com",
  registrationNumber: "01234567"
} as const;
export const SYNTHETIC_LEI = "984500EXAMPLE0TECH47";

type Fixture = (q: ReputationQuery, now: Date) => NormalizedEvidence[];

export class FixtureProvider implements ReputationProvider {
  readonly retryable = false;
  constructor(readonly id: string, readonly name: string, readonly category: ProviderCategory, private readonly fixture: Fixture | "not_configured" | "unavailable" | "timeout") {}
  applicability(): Applicability {
    return this.fixture === "not_configured" ? { status: "not_configured", reason: `${this.name} is not configured (synthetic).` } : { status: "ready" };
  }
  cacheKey(q: ReputationQuery): string { return `${q.nameKey}|${q.country?.code ?? "*"}`; }
  async fetch(q: ReputationQuery, ctx: ProviderContext): Promise<ProviderFetchResult> {
    if (this.fixture === "unavailable" || this.fixture === "timeout") return { status: this.fixture, evidence: [], reason: `${this.name} ${this.fixture} (synthetic).`, requests: 1, estimatedCostUSD: 0 };
    if (this.fixture === "not_configured") return { status: "not_configured", evidence: [], reason: null, requests: 0, estimatedCostUSD: 0 };
    return { status: "ok", evidence: this.fixture(q, ctx.now), reason: null, requests: 1, estimatedCostUSD: 0 };
  }
}

const base = (providerId: string, key: string, now: Date, e: Partial<NormalizedEvidence> & Pick<NormalizedEvidence, "type" | "sourceName" | "sourceTier">): NormalizedEvidence => ({
  id: evidenceId(providerId, key), providerId, sourceUrl: null, sourceDomain: null, sourceRecordId: null, title: null, summary: null,
  publishedAt: null, observedAt: now.toISOString(), jurisdiction: null, companyIdentifiers: {}, quality: e.sourceTier === 1 ? 1 : e.sourceTier === 2 ? 0.8 : e.sourceTier === 3 ? 0.5 : 0.2,
  relevance: 1, metadata: {}, ...e
});

export function registryRecord(providerId: string, now: Date, r: { recordId: string; legalName: string; registrationNumber: string | null; lei: string | null; country: string; city: string | null; status: string; incorporationDate: string | null; registryName: string; leiRegistrationStatus?: string | null; recordKind?: string }): NormalizedEvidence {
  return base(providerId, r.recordId, now, {
    type: "registry", sourceName: r.registryName, sourceTier: 1, sourceRecordId: r.recordId, title: r.legalName,
    sourceUrl: `https://registry.example/record/${encodeURIComponent(r.recordId)}`, sourceDomain: "registry.example", jurisdiction: r.country,
    summary: `Status: ${r.status}`, companyIdentifiers: { legalName: r.legalName, registrationNumber: r.registrationNumber, lei: r.lei, country: r.country, city: r.city },
    metadata: { recordKind: r.recordKind ?? "company_registry", legalName: r.legalName, otherNames: [], registrationNumber: r.registrationNumber, lei: r.lei, country: r.country, city: r.city, status: r.status, rawStatus: r.status, incorporationDate: r.incorporationDate, leiRegistrationStatus: r.leiRegistrationStatus ?? null, hasInsolvencyHistory: false, registryName: r.registryName }
  });
}

export function newsItem(providerId: string, now: Date, n: { url: string; title: string; summary: string; publishedAt: string; tier?: 1 | 2 | 3 | 4; type?: NormalizedEvidence["type"] }): NormalizedEvidence {
  const host = new URL(n.url).hostname;
  return base(providerId, n.url, now, { type: n.type ?? "news", sourceName: host, sourceTier: n.tier ?? 3, sourceUrl: n.url, sourceDomain: host, title: n.title, summary: n.summary, publishedAt: n.publishedAt });
}

export function sanctionsEntry(providerId: string, now: Date, s: { name: string; listName: string; reference: string; countries: string[]; identifiers?: string[]; queriedNames: string[]; aliases?: string[] }): NormalizedEvidence {
  return base(providerId, `${s.listName}|${s.reference}|${s.name}`, now, {
    type: "sanctions", sourceName: s.listName, sourceTier: 1, title: s.name, sourceRecordId: s.reference,
    metadata: { listName: s.listName, reference: s.reference, aliases: s.aliases ?? [], countries: s.countries, identifiers: s.identifiers ?? [], subjectType: "entity", queriedNames: s.queriedNames }
  });
}

const syndicatedTitle = "Example Technologies fined £40,000 by data regulator over unsolicited marketing emails";

export function syntheticProviders(): ReputationProvider[] {
  return [
    new FixtureProvider("registry_uk_companies_house", "UK Companies House", "registry", (_q, now) => [
      registryRecord("registry_uk_companies_house", now, { recordId: "01234567", legalName: "EXAMPLE TECHNOLOGIES LIMITED", registrationNumber: "01234567", lei: null, country: "GB", city: "Manchester", status: "active", incorporationDate: "2012-03-14", registryName: "UK Companies House" })
    ]),
    new FixtureProvider("registry_gleif", "GLEIF Global LEI Index", "registry", (_q, now) => [
      registryRecord("registry_gleif", now, { recordId: SYNTHETIC_LEI, legalName: "EXAMPLE TECHNOLOGIES LIMITED", registrationNumber: "01234567", lei: SYNTHETIC_LEI, country: "GB", city: "Manchester", status: "active", incorporationDate: "2012-03-14", registryName: "GLEIF Global LEI Index", leiRegistrationStatus: "ISSUED", recordKind: "lei_registry" })
    ]),
    new FixtureProvider("sanctions_un_consolidated", "UN Security Council Consolidated List", "sanctions", (q, now) => [
      // A loosely similar listed name returned by the list's pre-filter — must NOT become a match.
      sanctionsEntry("sanctions_un_consolidated", now, { name: "EXAMPLE TECHNICAL TRADING COMPANY", listName: "UN Security Council Consolidated List", reference: "XXe.000", countries: ["Atlantis"], queriedNames: [q.companyName] })
    ]),
    new FixtureProvider("sanctions_us_csl", "US Consolidated Screening List (includes OFAC SDN)", "sanctions", () => []),
    new FixtureProvider("sanctions_eu_fsf", "EU Financial Sanctions Files (consolidated list)", "sanctions", "not_configured"),
    new FixtureProvider("news_web_search", "News and public web search", "news", (_q, now) => [
      newsItem("news_web_search", now, { url: "https://business-wire.example/2026/03/example-technologies-fined", title: `${syndicatedTitle} - Business Wire Example`, summary: "The data protection regulator fined Example Technologies Ltd £40,000 after finding it sent unsolicited marketing emails. The company said it has updated its consent process.", publishedAt: "2026-03-10T09:00:00.000Z" }),
      newsItem("news_web_search", now, { url: "https://regional-news.example/tech/example-technologies-fined-data-regulator", title: `${syndicatedTitle} | Regional News Example`, summary: "Example Technologies Ltd was fined £40,000 by the data regulator over unsolicited marketing emails.", publishedAt: "2026-03-10T11:30:00.000Z" }),
      newsItem("news_web_search", now, { url: "https://aggregator.example/story/88231?utm_source=feed", title: syndicatedTitle, summary: "Example Technologies Ltd fined £40,000 by data regulator.", publishedAt: "2026-03-11T07:00:00.000Z" }),
      newsItem("news_web_search", now, { url: "https://tech-weekly.example/opinion/example-technologies-customers", title: "Former staff member alleges Example Technologies misled customers about uptime", summary: "In a blog interview, a former employee alleged that Example Technologies Ltd made misleading claims about service uptime. The company disputes the claims.", publishedAt: "2025-11-02T10:00:00.000Z" }),
      newsItem("news_web_search", now, { url: "https://daily-ledger.example/2026/05/example-technologies-manchester-office", title: "Example Technologies opens second Manchester office", summary: "Manchester-based Example Technologies Ltd opened a second office and plans to hire 40 engineers.", publishedAt: "2026-05-20T08:00:00.000Z" }),
      // Same-name company in ANOTHER jurisdiction — must be excluded, never attributed.
      newsItem("news_web_search", now, { url: "https://north-news.example/2026/06/example-technologies-inc-sued", title: "Example Technologies Inc. sued in Canadian patent dispute", summary: "Toronto-based Example Technologies Inc. faces a lawsuit filed in Canada alleging patent infringement.", publishedAt: "2026-06-01T12:00:00.000Z" })
    ]),
    new FixtureProvider("reviews_web_search", "Review platforms and forums (web search)", "reviews", (_q, now) => [
      newsItem("reviews_web_search", now, { url: "https://reviews.example/review/example.com", title: "Example Technologies Reviews | Reviews Example", summary: "Example Technologies Ltd is rated 4.2 out of 5 based on 312 reviews. Customers mention reliable service and responsive support.", publishedAt: "2026-09-01T00:00:00.000Z", tier: 3, type: "review" }),
      newsItem("reviews_web_search", now, { url: "https://forum.example/t/example-technologies-refund", title: "Anyone used Example Technologies? Still waiting on a refund", summary: "Posted by an anonymous user: I cancelled my Example Technologies Ltd subscription and never received my refund after three weeks.", publishedAt: "2026-08-14T00:00:00.000Z", tier: 4, type: "forum" })
    ]),
    new FixtureProvider("website_homepage", "Company website", "website", (_q, now) => [{
      id: evidenceId("website_homepage", "https://example.com"), type: "website", providerId: "website_homepage", sourceName: "Company website (example.com)",
      sourceUrl: "https://example.com/", sourceDomain: "example.com", sourceRecordId: null, sourceTier: 3, title: "Example Technologies Ltd — Cloud software for logistics",
      summary: "Website responded with HTTP 200 over HTTPS.", publishedAt: null, observedAt: now.toISOString(), jurisdiction: null, companyIdentifiers: { domain: "example.com" },
      quality: 0.5, relevance: 1,
      metadata: {
        reachable: true, httpStatus: 200, https: true, finalDomain: "example.com", redirectedToOtherDomain: false, truncated: false,
        textExcerpt: "Example Technologies Ltd builds cloud software for logistics teams. About us. Contact us. Example Technologies Ltd is registered in England and Wales, company number 01234567. Registered office: Manchester. Privacy policy. Terms and conditions. Our platform helps logistics teams plan routes, track shipments and manage warehouse inventory across multiple sites with real-time dashboards and integrations.",
        injectionDetected: false, hasContactLink: true, hasAboutLink: true, hasPrivacyPolicy: true, hasTerms: true, emailDomains: ["example.com"], hasPhone: true,
        parkedIndicators: false, underConstruction: false, mentionsRegistrationDetails: true, contentLength: 420
      }
    }]),
    new FixtureProvider("domain_rdap", "Domain registration (RDAP)", "domain", (_q, now) => [{
      id: evidenceId("domain_rdap", "example.com"), type: "domain", providerId: "domain_rdap", sourceName: "RDAP domain registration data",
      sourceUrl: "https://rdap.example/domain/example.com", sourceDomain: "rdap.example", sourceRecordId: "example.com", sourceTier: 1,
      title: "Domain registration record for example.com", summary: "Registered: 2011-05-02T00:00:00.000Z; expires: 2027-05-02T00:00:00.000Z.",
      publishedAt: "2025-05-03T00:00:00.000Z", observedAt: now.toISOString(), jurisdiction: null, companyIdentifiers: { domain: "example.com" }, quality: 1, relevance: 1,
      metadata: { domain: "example.com", found: true, registeredAt: "2011-05-02T00:00:00.000Z", expiresAt: "2027-05-02T00:00:00.000Z", statuses: ["client transfer prohibited"] }
    }])
  ];
}

export function syntheticDependencies(overrides: Partial<ReputationDependencies> = {}): ReputationDependencies {
  return {
    providers: syntheticProviders(),
    cache: new MemoryReputationEvidenceCache(),
    ttls: { registry: 7 * 86_400_000, sanctions: 12 * 3_600_000, news: 86_400_000, reviews: 3 * 86_400_000, website: 3 * 86_400_000, domain: 7 * 86_400_000 },
    maxStaleMs: 14 * 86_400_000, timeoutMs: 5000, maxAttempts: 2, disabled: new Set(), now: () => SYNTHETIC_NOW,
    ...overrides
  };
}
