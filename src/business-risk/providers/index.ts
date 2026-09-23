import { getOmanCompanyDataProvider } from "../../services/omanBusiness.js";
import { buildWebSearchProvider, isWebSearchConfigured } from "../../intelligence/webSearch/build.js";
import type { WebSearchProvider } from "../../intelligence/webSearch/provider.js";
import { CompaniesHouseProvider, GleifRegistryProvider, OmanRegistryProvider, companiesHouseProfileFacts } from "../../company-reputation/providers/registryProviders.js";
import { buildSanctionsReputationProviders } from "../../company-reputation/providers/sanctionsProvider.js";
import { NewsProvider as ReputationNewsProvider, ReviewsProvider, runSearch, toSearchEvidence } from "../../company-reputation/providers/webSearchProviders.js";
import { DomainRdapProvider, WebsiteProvider } from "../../company-reputation/providers/webPresenceProviders.js";
import { fetchWithSignal, isAbortError, outage, type Applicability, type ProviderContext, type ReputationProvider, type ReputationQuery } from "../../company-reputation/providers/types.js";
import { getCompaniesHouseApiKey, getReputationLiveChecksEnabled } from "../../company-reputation/config.js";
import { evidenceId } from "../../company-reputation/deduplication.js";
import { registrableDomain } from "../../company-reputation/normalization.js";
import type { NormalizedEvidence, ProviderCategory, ProviderFetchResult } from "../../company-reputation/types.js";
import { ESTIMATED_COST_PER_SEARCH_USD, LIMITS, getGoogleSafeBrowsingApiKey } from "../config.js";
import type { BusinessRiskProvider, BusinessRiskQuery, ProviderRole } from "../types.js";

/**
 * business_risk_score provider set — adapters that give every evidence source one of the six
 * provider roles (corporate / financial / sanctions / news / regulatory / digital) WITHOUT coupling
 * the scoring engine to any provider: every provider emits the shared NormalizedEvidence model and
 * the engine only ever reads that.
 *
 * Reused as-is from company_reputation_check (same provider ids ⇒ the same evidence-cache rows are
 * shared between the two capabilities, so evidence is fetched once and reused):
 *   corporate: GLEIF (global LEI index), UK Companies House, Rafid's Oman registry
 *   sanctions: UN Consolidated, US Consolidated Screening List (OFAC SDN + BIS/DDTC export-control
 *              and debarment lists), EU FSF (optional), OpenSanctions (optional, paid)
 *   news:      news/adverse-media web search, review-platform/forum web search
 *   digital:   company website (SSRF-safe fetch), RDAP domain registration
 * New here:
 *   financial:  UK Companies House statutory-filing status (accounts / confirmation statement overdue,
 *               insolvency history, status detail) for the RESOLVED company number
 *   regulatory: web search restricted to regulator / enforcement-agency domains (tier-1 evidence)
 *   digital:    Google Safe Browsing threat lookup (malware / phishing / unwanted software), optional
 */

/** Delegating wrapper that tags a reused ReputationProvider with its role. */
class RoleProvider implements ReputationProvider {
  constructor(private readonly inner: ReputationProvider, readonly role: ProviderRole) {}
  get id() { return this.inner.id; }
  get name() { return this.inner.name; }
  get category(): ProviderCategory { return this.inner.category; }
  get retryable() { return this.inner.retryable; }
  applicability(q: ReputationQuery): Applicability { return this.inner.applicability(q); }
  cacheKey(q: ReputationQuery): string { return this.inner.cacheKey(q); }
  fetch(q: ReputationQuery, ctx: ProviderContext): Promise<ProviderFetchResult> { return this.inner.fetch(q, ctx); }
}

export function withRole<R extends ProviderRole>(provider: ReputationProvider, role: R): BusinessRiskProvider {
  return new RoleProvider(provider, role) as unknown as BusinessRiskProvider;
}

type SearchFactory = () => WebSearchProvider;
const searchFactory: SearchFactory = () => buildWebSearchProvider({ requestId: null, capability: "business_risk_score" });

// ---------------------------------------------------------------------------------------------
// Financial: UK Companies House filing status for the resolved company
// ---------------------------------------------------------------------------------------------

const CH_REQUEST_TIMEOUT_MS = 8000;

export class CompaniesHouseFilingsProvider implements ReputationProvider {
  readonly id = "financial_uk_companies_house_filings";
  readonly name = "UK Companies House filing status";
  readonly category = "registry" as const;
  readonly role = "financial" as const;
  readonly retryable = true;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: string | null;
  private readonly baseUrl: string;

  constructor(options: { fetchImpl?: typeof fetch; apiKey?: string | null; baseUrl?: string } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiKey = options.apiKey === undefined ? getCompaniesHouseApiKey() : options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://api.company-information.service.gov.uk";
  }

  applicability(q: ReputationQuery): Applicability {
    const bq = q as Partial<BusinessRiskQuery> & ReputationQuery & { filingDetailPresent?: boolean };
    if (!this.apiKey) return { status: "not_configured", reason: "UK Companies House filing data is not configured (COMPANIES_HOUSE_API_KEY)." };
    if (q.country?.code !== "GB") return { status: "not_applicable", reason: "Companies House filing data only covers United Kingdom companies." };
    if (!q.registrationNumber) return { status: "not_applicable", reason: "No resolved UK company number to look up filings for." };
    if (bq.filingDetailPresent) return { status: "not_applicable", reason: "Filing status was already returned by the registry lookup." };
    return { status: "ready" };
  }

  cacheKey(q: ReputationQuery): string { return `reg:${q.registrationNumber}`; }

  async fetch(q: ReputationQuery, ctx: ProviderContext): Promise<ProviderFetchResult> {
    const number = q.registrationNumber!.padStart(8, "0");
    const headers = { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}` };
    try {
      const response = await fetchWithSignal(this.fetchImpl, `${this.baseUrl}/company/${encodeURIComponent(number)}`, { headers }, ctx.signal, CH_REQUEST_TIMEOUT_MS);
      if (response.status === 404) return { status: "ok", evidence: [], reason: null, requests: 1, estimatedCostUSD: 0 };
      if (response.status === 429) return outage("rate_limited", "Companies House rate limited the request.");
      if (!response.ok) return outage("unavailable", `Companies House returned HTTP ${response.status}.`);
      const c = (await response.json()) as Record<string, unknown>;
      const facts = companiesHouseProfileFacts(c);
      const name = typeof c.company_name === "string" ? c.company_name : null;
      const status = typeof c.company_status === "string" ? c.company_status : null;
      const evidence: NormalizedEvidence = {
        id: evidenceId(this.id, number), type: "registry", providerId: this.id, sourceName: this.name,
        sourceUrl: `https://find-and-update.company-information.service.gov.uk/company/${encodeURIComponent(number)}/filing-history`,
        sourceDomain: "find-and-update.company-information.service.gov.uk", sourceRecordId: number, sourceTier: 1,
        title: name ? `Filing status of ${name}` : `Filing status of company ${number}`,
        summary: [
          typeof facts.accountsOverdue === "boolean" ? `Accounts overdue: ${facts.accountsOverdue ? "yes" : "no"}` : null,
          typeof facts.confirmationStatementOverdue === "boolean" ? `Confirmation statement overdue: ${facts.confirmationStatementOverdue ? "yes" : "no"}` : null,
          typeof c.has_insolvency_history === "boolean" ? `Insolvency history: ${c.has_insolvency_history ? "yes" : "no"}` : null
        ].filter(Boolean).join(". ") || null,
        publishedAt: typeof facts.lastAccountsMadeUpTo === "string" ? facts.lastAccountsMadeUpTo : null,
        observedAt: ctx.now.toISOString(), jurisdiction: "GB",
        companyIdentifiers: { legalName: name, registrationNumber: number, country: "GB" },
        quality: 1, relevance: 1,
        metadata: {
          recordKind: "company_filing_status", legalName: name, registrationNumber: number, country: "GB", rawStatus: status,
          hasInsolvencyHistory: typeof c.has_insolvency_history === "boolean" ? c.has_insolvency_history : null,
          incorporationDate: typeof c.date_of_creation === "string" ? c.date_of_creation : null, registryName: "UK Companies House", ...facts
        }
      };
      return { status: "ok", evidence: [evidence], reason: null, requests: 1, estimatedCostUSD: 0 };
    } catch (error) {
      return isAbortError(error) ? outage("timeout", "Companies House did not respond in time.") : outage("unavailable", "Companies House could not be reached.");
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Regulatory: enforcement / regulator publications (web search restricted to official domains)
// ---------------------------------------------------------------------------------------------

/** Official regulator, enforcement and court domains (all classified tier 1 by sourceQuality.ts,
 *  so results become "regulatory" evidence). Curated; extended by configuration, never by input. */
export const REGULATOR_DOMAINS: readonly string[] = [
  "sec.gov", "justice.gov", "ftc.gov", "cftc.gov", "consumerfinance.gov", "treasury.gov", "finra.org",
  "fca.org.uk", "gov.uk", "judiciary.uk", "europa.eu", "bafin.de", "amf-france.org", "asic.gov.au", "mas.gov.sg",
  "cma.gov.om", "cbo.gov.om", "dfsa.ae", "sca.gov.ae", "cma.org.sa", "worldbank.org", "courtlistener.com"
];
const ENFORCEMENT_TERMS = "enforcement OR penalty OR fined OR sanctioned OR debarred OR \"cease and desist\" OR settlement OR charged OR prohibited OR warning";

export class RegulatoryActionsProvider implements ReputationProvider {
  readonly id = "regulatory_web_search";
  readonly name = "Regulator and enforcement publications (web search)";
  readonly category = "news" as const;
  readonly role = "regulatory" as const;
  readonly retryable = false; // paid per search — never retried automatically

  constructor(private readonly factory: SearchFactory = searchFactory, private readonly configured: () => boolean = isWebSearchConfigured) {}

  applicability(): Applicability {
    return this.configured() ? { status: "ready" } : { status: "not_configured", reason: "No web search provider is configured for regulator/enforcement searches (WEB_SEARCH_PROVIDER)." };
  }

  cacheKey(q: ReputationQuery): string { return `${q.nameKey}|${q.country?.code ?? "*"}|${q.registrationNumber ?? ""}`; }

  async fetch(q: ReputationQuery, ctx: ProviderContext): Promise<ProviderFetchResult> {
    const text = `"${q.legalName ?? q.companyName}" (${ENFORCEMENT_TERMS})`;
    const outcome = await runSearch(this.factory(), text, { maxResults: LIMITS.regulatoryResults, domains: REGULATOR_DOMAINS });
    if (outcome.status !== "ok") return outage(outcome.status, `The regulator search did not answer (${outcome.status}).`);
    const evidence = outcome.results.map(r => toSearchEvidence(this.id, r, ctx.now, "news", "regulatory")).filter((e): e is NormalizedEvidence => e !== null);
    return { status: "ok", evidence, reason: null, requests: 1, estimatedCostUSD: ESTIMATED_COST_PER_SEARCH_USD };
  }
}

// ---------------------------------------------------------------------------------------------
// Digital: Google Safe Browsing (v4 Lookup API) — optional, needs GOOGLE_SAFE_BROWSING_API_KEY
// ---------------------------------------------------------------------------------------------

export class SafeBrowsingProvider implements ReputationProvider {
  readonly id = "threat_google_safe_browsing";
  readonly name = "Google Safe Browsing";
  readonly category = "website" as const;
  readonly role = "digital" as const;
  readonly retryable = true;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: string | null;
  private readonly liveEnabled: boolean;

  constructor(options: { fetchImpl?: typeof fetch; apiKey?: string | null; enabled?: boolean } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiKey = options.apiKey === undefined ? getGoogleSafeBrowsingApiKey() : options.apiKey;
    this.liveEnabled = options.enabled ?? getReputationLiveChecksEnabled();
  }

  applicability(q: ReputationQuery): Applicability {
    if (!q.website && !q.domain) return { status: "not_applicable", reason: "No website or domain was supplied." };
    if (!this.apiKey) return { status: "not_configured", reason: "Malware/phishing threat lookups are not configured (GOOGLE_SAFE_BROWSING_API_KEY)." };
    if (!this.liveEnabled) return { status: "not_configured", reason: "Live checks are not enabled for this deployment (RISK_LIVE_CHECKS_ENABLED)." };
    return { status: "ready" };
  }

  cacheKey(q: ReputationQuery): string { return registrableDomain(q.domain ?? new URL(q.website!).hostname); }

  async fetch(q: ReputationQuery, ctx: ProviderContext): Promise<ProviderFetchResult> {
    const domain = registrableDomain(q.domain ?? new URL(q.website!).hostname);
    const urls = [...new Set([q.website ?? `https://${domain}`, `https://${domain}/`, `http://${domain}/`])];
    try {
      const response = await fetchWithSignal(this.fetchImpl, `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(this.apiKey!)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client: { clientId: "rafid-agent-api", clientVersion: "1.0" },
          threatInfo: { threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"], platformTypes: ["ANY_PLATFORM"], threatEntryTypes: ["URL"], threatEntries: urls.map(url => ({ url })) }
        })
      }, ctx.signal, 8000);
      if (response.status === 429) return outage("rate_limited", "Google Safe Browsing rate limited the request.");
      if (!response.ok) return outage("unavailable", `Google Safe Browsing returned HTTP ${response.status}.`);
      const body = (await response.json()) as { matches?: unknown };
      const matches = Array.isArray(body.matches) ? body.matches : [];
      const threatTypes = [...new Set(matches.map(m => (m as { threatType?: unknown })?.threatType).filter((t): t is string => typeof t === "string"))].sort();
      // The API key is never part of the evidence; the public transparency-report URL is.
      const evidence: NormalizedEvidence = {
        id: evidenceId(this.id, domain), type: "website", providerId: this.id, sourceName: this.name,
        sourceUrl: `https://transparencyreport.google.com/safe-browsing/search?url=${encodeURIComponent(domain)}`, sourceDomain: "transparencyreport.google.com",
        sourceRecordId: domain, sourceTier: 1,
        title: `Safe Browsing status for ${domain}`,
        summary: threatTypes.length ? `Listed for: ${threatTypes.join(", ")}.` : "Not listed for malware, social engineering or unwanted software at retrieval time.",
        publishedAt: null, observedAt: ctx.now.toISOString(), jurisdiction: null, companyIdentifiers: { domain },
        quality: 1, relevance: 1, metadata: { recordKind: "threat_intelligence", domain, listed: threatTypes.length > 0, threatTypes }
      };
      return { status: "ok", evidence: [evidence], reason: null, requests: 1, estimatedCostUSD: 0 };
    } catch (error) {
      return isAbortError(error) ? outage("timeout", "Google Safe Browsing did not respond in time.") : outage("unavailable", "Google Safe Browsing could not be reached.");
    }
  }
}

/** The default, env-configured provider set. Every networked source is OFF unless configured, so
 *  the generic test loops never touch the network. */
export function buildDefaultBusinessRiskProviders(): BusinessRiskProvider[] {
  return [
    withRole(new GleifRegistryProvider(), "corporate"),
    withRole(new CompaniesHouseProvider(), "corporate"),
    withRole(new OmanRegistryProvider(() => getOmanCompanyDataProvider()), "corporate"),
    withRole(new WebsiteProvider(), "digital"),
    withRole(new DomainRdapProvider(), "digital"),
    withRole(new CompaniesHouseFilingsProvider(), "financial"),
    ...buildSanctionsReputationProviders().map(p => withRole(p, "sanctions")),
    withRole(new ReputationNewsProvider(searchFactory), "news"),
    withRole(new ReviewsProvider(searchFactory), "news"),
    withRole(new RegulatoryActionsProvider(searchFactory), "regulatory"),
    withRole(new SafeBrowsingProvider(), "digital")
  ];
}
