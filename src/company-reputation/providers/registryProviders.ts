import type { CompanyDataProvider } from "../../business-data/sources/provider.js";
import { rankCompanies } from "../../business-data/matching/search.js";
import { getOmanBusinessDataMode } from "../../business-data/config.js";
import { getCompaniesHouseApiKey, getReputationLiveChecksEnabled } from "../config.js";
import { evidenceId } from "../deduplication.js";
import { hostOf, normalizeCountry, normalizeRegistrationNumber } from "../normalization.js";
import { cleanOrNull } from "../sanitize.js";
import type { NormalizedEvidence, ProviderFetchResult } from "../types.js";
import { fetchWithSignal, isAbortError, outage, type Applicability, type ProviderContext, type ReputationProvider, type ReputationQuery } from "./types.js";

/**
 * Company-registry providers. Each produces "registry" evidence with a STANDARD metadata shape
 * (below), so the identity/stability/transparency analyzers are provider-agnostic:
 *   legalName, otherNames[], registrationNumber, lei, country (ISO-2), city,
 *   status (active|inactive|dissolved|liquidation|unknown), rawStatus, incorporationDate,
 *   leiRegistrationStatus, hasInsolvencyHistory, registryName.
 * A registry provider returns CANDIDATES; deciding which candidate (if any) is the requested company
 * is entity resolution (companyResolver.ts), never the provider's job.
 */

const REQUEST_TIMEOUT_MS = 8000;
const MAX_CANDIDATES = 5;

export type RegistryStatus = "active" | "inactive" | "dissolved" | "liquidation" | "unknown";

function registryEvidence(providerId: string, sourceName: string, now: Date, r: {
  recordId: string; legalName: string; otherNames: string[]; registrationNumber: string | null; lei: string | null;
  country: string | null; city: string | null; status: RegistryStatus; rawStatus: string | null; incorporationDate: string | null;
  leiRegistrationStatus: string | null; hasInsolvencyHistory: boolean | null; url: string | null; lastUpdated: string | null; recordKind: "company_registry" | "lei_registry";
  /** Optional additional registry facts (additive; analyzers that don't know a key ignore it). */
  extra?: NormalizedEvidence["metadata"];
}): NormalizedEvidence {
  const legalName = cleanOrNull(r.legalName, 200) ?? r.legalName;
  return {
    id: evidenceId(providerId, r.recordId),
    type: "registry", providerId, sourceName, sourceUrl: r.url, sourceDomain: hostOf(r.url),
    sourceRecordId: r.recordId, sourceTier: 1,
    title: legalName, summary: [r.status !== "unknown" ? `Status: ${r.status}` : null, r.incorporationDate ? `Incorporated/created: ${r.incorporationDate}` : null, r.city ? `City: ${r.city}` : null].filter(Boolean).join(". ") || null,
    publishedAt: r.lastUpdated, observedAt: now.toISOString(), jurisdiction: r.country,
    companyIdentifiers: { legalName, registrationNumber: r.registrationNumber, lei: r.lei, country: r.country, city: r.city },
    quality: 1, relevance: 1,
    metadata: {
      recordKind: r.recordKind, legalName, otherNames: r.otherNames.map(n => cleanOrNull(n, 200)).filter((n): n is string => Boolean(n)).slice(0, 10),
      registrationNumber: r.registrationNumber, lei: r.lei, country: r.country, city: r.city, status: r.status, rawStatus: r.rawStatus,
      incorporationDate: r.incorporationDate, leiRegistrationStatus: r.leiRegistrationStatus, hasInsolvencyHistory: r.hasInsolvencyHistory, registryName: sourceName,
      ...(r.extra ?? {})
    }
  };
}

// ---------------------------------------------------------------------------------------------
// GLEIF — Global Legal Entity Identifier Foundation (public, no key, global coverage of entities
// that hold an LEI). Tier 1: LEI data is validated by accredited Local Operating Units.
// ---------------------------------------------------------------------------------------------

export class GleifRegistryProvider implements ReputationProvider {
  readonly id = "registry_gleif";
  readonly name = "GLEIF Global LEI Index";
  readonly category = "registry" as const;
  readonly retryable = true;
  private readonly fetchImpl: typeof fetch;
  private readonly enabled: boolean;
  private readonly baseUrl: string;

  constructor(options: { fetchImpl?: typeof fetch; enabled?: boolean; baseUrl?: string } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.enabled = options.enabled ?? getReputationLiveChecksEnabled();
    this.baseUrl = options.baseUrl ?? "https://api.gleif.org/api/v1";
  }

  applicability(): Applicability {
    return this.enabled ? { status: "ready" } : { status: "not_configured", reason: "GLEIF lookups are not enabled for this deployment (RISK_LIVE_CHECKS_ENABLED)." };
  }

  cacheKey(q: ReputationQuery): string {
    return q.lei ? `lei:${q.lei}` : `name:${q.nameKey}|${q.country?.code ?? "*"}`;
  }

  async fetch(q: ReputationQuery, ctx: ProviderContext): Promise<ProviderFetchResult> {
    const url = q.lei
      ? `${this.baseUrl}/lei-records/${encodeURIComponent(q.lei)}`
      : `${this.baseUrl}/lei-records?filter[fulltext]=${encodeURIComponent(q.legalName ?? q.companyName)}${q.country ? `&filter[entity.legalAddress.country]=${q.country.code}` : ""}&page[size]=${MAX_CANDIDATES}`;
    try {
      const response = await fetchWithSignal(this.fetchImpl, url, { headers: { Accept: "application/vnd.api+json" } }, ctx.signal, REQUEST_TIMEOUT_MS);
      if (response.status === 404 && q.lei) return { status: "ok", evidence: [], reason: null, requests: 1, estimatedCostUSD: 0 };
      if (response.status === 429) return outage("rate_limited", "GLEIF rate limited the request.");
      if (!response.ok) return outage("unavailable", `GLEIF returned HTTP ${response.status}.`);
      const body = (await response.json()) as { data?: unknown };
      const records = Array.isArray(body.data) ? body.data : body.data ? [body.data] : [];
      const evidence: NormalizedEvidence[] = [];
      for (const rec of records.slice(0, MAX_CANDIDATES)) {
        const attrs = (rec as { attributes?: Record<string, unknown> })?.attributes;
        if (!attrs) continue;
        const entity = (attrs.entity ?? {}) as Record<string, unknown>;
        const registration = (attrs.registration ?? {}) as Record<string, unknown>;
        const lei = typeof attrs.lei === "string" ? attrs.lei : null;
        const legalName = ((entity.legalName ?? {}) as { name?: unknown }).name;
        if (!lei || typeof legalName !== "string") continue;
        const address = (entity.legalAddress ?? {}) as Record<string, unknown>;
        const otherNames = Array.isArray(entity.otherNames) ? entity.otherNames.map(n => (n as { name?: unknown })?.name).filter((n): n is string => typeof n === "string") : [];
        const entityStatus = typeof entity.status === "string" ? entity.status.toUpperCase() : null;
        evidence.push(registryEvidence(this.id, this.name, ctx.now, {
          recordId: lei, legalName, otherNames,
          registrationNumber: typeof entity.registeredAs === "string" ? entity.registeredAs : null,
          lei,
          country: normalizeCountry(typeof address.country === "string" ? address.country : null)?.code ?? null,
          city: typeof address.city === "string" ? address.city : null,
          status: entityStatus === "ACTIVE" ? "active" : entityStatus === "INACTIVE" ? "inactive" : "unknown",
          rawStatus: entityStatus,
          incorporationDate: typeof entity.creationDate === "string" ? entity.creationDate.slice(0, 10) : null,
          leiRegistrationStatus: typeof registration.status === "string" ? registration.status : null,
          hasInsolvencyHistory: null,
          url: `https://search.gleif.org/#/record/${lei}`,
          lastUpdated: typeof registration.lastUpdateDate === "string" ? registration.lastUpdateDate : null,
          recordKind: "lei_registry",
          extra: { registeredAddress: formatAddress([...(Array.isArray(address.addressLines) ? address.addressLines : []), address.city, address.postalCode]) }
        }));
      }
      return { status: "ok", evidence, reason: null, requests: 1, estimatedCostUSD: 0 };
    } catch (error) {
      return isAbortError(error) ? outage("timeout", "GLEIF did not respond in time.") : outage("unavailable", "GLEIF could not be reached.");
    }
  }
}

// ---------------------------------------------------------------------------------------------
// UK Companies House public data API (free key). Only applicable to UK companies.
// ---------------------------------------------------------------------------------------------

const CH_STATUS: Readonly<Record<string, RegistryStatus>> = {
  active: "active", dissolved: "dissolved", liquidation: "liquidation", administration: "liquidation", receivership: "liquidation",
  "voluntary-arrangement": "liquidation", "insolvency-proceedings": "liquidation", "converted-closed": "inactive", closed: "inactive", open: "active", registered: "active", removed: "dissolved"
};

export class CompaniesHouseProvider implements ReputationProvider {
  readonly id = "registry_uk_companies_house";
  readonly name = "UK Companies House";
  readonly category = "registry" as const;
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
    if (!this.apiKey) return { status: "not_configured", reason: "UK Companies House is not configured (COMPANIES_HOUSE_API_KEY)." };
    if (q.country?.code !== "GB") return { status: "not_applicable", reason: "UK Companies House only covers United Kingdom companies." };
    return { status: "ready" };
  }

  cacheKey(q: ReputationQuery): string {
    return q.registrationNumber ? `reg:${q.registrationNumber}` : `name:${q.nameKey}`;
  }

  async fetch(q: ReputationQuery, ctx: ProviderContext): Promise<ProviderFetchResult> {
    const headers = { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}` };
    try {
      if (q.registrationNumber) {
        const number = q.registrationNumber.padStart(8, "0");
        const response = await fetchWithSignal(this.fetchImpl, `${this.baseUrl}/company/${encodeURIComponent(number)}`, { headers }, ctx.signal, REQUEST_TIMEOUT_MS);
        if (response.status === 404) return { status: "ok", evidence: [], reason: null, requests: 1, estimatedCostUSD: 0 };
        if (response.status === 429) return outage("rate_limited", "Companies House rate limited the request.");
        if (!response.ok) return outage("unavailable", `Companies House returned HTTP ${response.status}.`);
        const c = (await response.json()) as Record<string, unknown>;
        const e = this.toEvidence(ctx.now, {
          number: typeof c.company_number === "string" ? c.company_number : number,
          name: typeof c.company_name === "string" ? c.company_name : null,
          status: typeof c.company_status === "string" ? c.company_status : null,
          created: typeof c.date_of_creation === "string" ? c.date_of_creation : null,
          locality: ((c.registered_office_address ?? {}) as { locality?: unknown }).locality,
          insolvency: typeof c.has_insolvency_history === "boolean" ? c.has_insolvency_history : null,
          previousNames: Array.isArray(c.previous_company_names) ? c.previous_company_names.map(p => (p as { name?: unknown })?.name).filter((n): n is string => typeof n === "string") : [],
          extra: companiesHouseProfileFacts(c)
        });
        return { status: "ok", evidence: e ? [e] : [], reason: null, requests: 1, estimatedCostUSD: 0 };
      }
      const response = await fetchWithSignal(this.fetchImpl, `${this.baseUrl}/search/companies?q=${encodeURIComponent(q.legalName ?? q.companyName)}&items_per_page=${MAX_CANDIDATES}`, { headers }, ctx.signal, REQUEST_TIMEOUT_MS);
      if (response.status === 429) return outage("rate_limited", "Companies House rate limited the request.");
      if (!response.ok) return outage("unavailable", `Companies House returned HTTP ${response.status}.`);
      const body = (await response.json()) as { items?: unknown };
      const items = Array.isArray(body.items) ? body.items : [];
      const evidence = items.slice(0, MAX_CANDIDATES).map(item => {
        const i = item as Record<string, unknown>;
        return this.toEvidence(ctx.now, {
          number: typeof i.company_number === "string" ? i.company_number : null,
          name: typeof i.title === "string" ? i.title : null,
          status: typeof i.company_status === "string" ? i.company_status : null,
          created: typeof i.date_of_creation === "string" ? i.date_of_creation : null,
          locality: ((i.address ?? {}) as { locality?: unknown }).locality,
          insolvency: null, previousNames: []
        });
      }).filter((e): e is NormalizedEvidence => e !== null);
      return { status: "ok", evidence, reason: null, requests: 1, estimatedCostUSD: 0 };
    } catch (error) {
      return isAbortError(error) ? outage("timeout", "Companies House did not respond in time.") : outage("unavailable", "Companies House could not be reached.");
    }
  }

  private toEvidence(now: Date, c: { number: string | null; name: string | null; status: string | null; created: string | null; locality: unknown; insolvency: boolean | null; previousNames: string[]; extra?: NormalizedEvidence["metadata"] }): NormalizedEvidence | null {
    if (!c.number || !c.name) return null;
    return registryEvidence(this.id, this.name, now, {
      recordId: c.number, legalName: c.name, otherNames: c.previousNames, registrationNumber: c.number, lei: null, country: "GB",
      city: typeof c.locality === "string" ? c.locality : null,
      status: (c.status && CH_STATUS[c.status]) || "unknown", rawStatus: c.status, incorporationDate: c.created,
      leiRegistrationStatus: null, hasInsolvencyHistory: c.insolvency,
      url: `https://find-and-update.company-information.service.gov.uk/company/${encodeURIComponent(c.number)}`, lastUpdated: null, recordKind: "company_registry",
      extra: c.extra
    });
  }
}

function formatAddress(parts: readonly unknown[]): string | null {
  const text = parts.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map(p => p.trim()).join(", ");
  return cleanOrNull(text, 300);
}

/**
 * Structured statutory-filing facts from a Companies House company PROFILE (GET /company/{number}).
 * Company-level facts only (no officer/person data). Keys are additive registry metadata; a key is
 * present only when the profile states the fact, so "unknown" is never confused with "false".
 * Shared by CompaniesHouseProvider and business_risk_score's filings (financial) provider.
 */
export function companiesHouseProfileFacts(c: Record<string, unknown>): NormalizedEvidence["metadata"] {
  const facts: NormalizedEvidence["metadata"] = { filingDetail: true };
  const accounts = (c.accounts ?? {}) as Record<string, unknown>;
  const confirmation = (c.confirmation_statement ?? {}) as Record<string, unknown>;
  const lastAccounts = (accounts.last_accounts ?? {}) as Record<string, unknown>;
  if (typeof accounts.overdue === "boolean") facts.accountsOverdue = accounts.overdue;
  if (typeof accounts.next_due === "string") facts.accountsNextDue = accounts.next_due;
  if (typeof lastAccounts.made_up_to === "string") facts.lastAccountsMadeUpTo = lastAccounts.made_up_to;
  if (typeof lastAccounts.type === "string") facts.lastAccountsType = lastAccounts.type;
  if (typeof confirmation.overdue === "boolean") facts.confirmationStatementOverdue = confirmation.overdue;
  if (typeof c.company_status_detail === "string") facts.statusDetail = c.company_status_detail;
  if (typeof c.type === "string") facts.companyType = c.type;
  if (typeof c.has_charges === "boolean") facts.hasCharges = c.has_charges;
  if (typeof c.registered_office_is_in_dispute === "boolean") facts.registeredOfficeInDispute = c.registered_office_is_in_dispute;
  if (typeof c.undeliverable_registered_office_address === "boolean") facts.undeliverableRegisteredOffice = c.undeliverable_registered_office_address;
  if (typeof c.date_of_cessation === "string") facts.cessationDate = c.date_of_cessation;
  if (Array.isArray(c.sic_codes)) facts.sicCodes = c.sic_codes.filter((x): x is string => typeof x === "string").slice(0, 5);
  if (Array.isArray(c.previous_company_names)) facts.previousNameCount = c.previous_company_names.length;
  const office = (c.registered_office_address ?? {}) as Record<string, unknown>;
  const address = formatAddress([office.address_line_1, office.address_line_2, office.locality, office.region, office.postal_code]);
  if (address) facts.registeredAddress = address;
  return facts;
}

// ---------------------------------------------------------------------------------------------
// Rafid's Oman company registry (same canonical registry search_oman_company uses). One regional
// registry provider among several — applicable only to Oman companies, and only when the
// deployment serves real registry data (demo records are never used as evidence).
// ---------------------------------------------------------------------------------------------

export class OmanRegistryProvider implements ReputationProvider {
  readonly id = "registry_oman_rafid";
  readonly name = "Rafid Oman company registry";
  readonly category = "registry" as const;
  readonly retryable = false;

  constructor(private readonly companies: () => CompanyDataProvider, private readonly realDataEnabled: () => boolean = () => getOmanBusinessDataMode() !== "manual") {}

  applicability(q: ReputationQuery): Applicability {
    if (q.country?.code !== "OM") return { status: "not_applicable", reason: "The Oman company registry only covers Oman companies." };
    if (!this.realDataEnabled()) return { status: "not_configured", reason: "Real Oman registry data is not enabled for this deployment (OMAN_BUSINESS_DATA_MODE=manual serves demo data only)." };
    return { status: "ready" };
  }

  cacheKey(q: ReputationQuery): string {
    return `name:${q.nameKey}|reg:${q.registrationNumber ?? ""}`;
  }

  async fetch(q: ReputationQuery, ctx: ProviderContext): Promise<ProviderFetchResult> {
    try {
      const provider = this.companies();
      const queries = [q.registrationNumber, q.legalName, q.companyName].filter((v): v is string => Boolean(v));
      const best = new Map<string, { score: number; record: Awaited<ReturnType<CompanyDataProvider["search"]>>[number] }>();
      for (const query of queries) {
        const rows = await provider.search({ query, candidateLimit: 200 });
        for (const m of rankCompanies(rows.filter(r => r.sourceType !== "demo" && !r.companyId.startsWith("demo-")), { query, limit: MAX_CANDIDATES })) {
          const prev = best.get(m.record.companyId);
          if (!prev || m.confidence > prev.score) best.set(m.record.companyId, { score: m.confidence, record: m.record });
        }
      }
      const evidence = [...best.values()].sort((a, b) => b.score - a.score || a.record.companyId.localeCompare(b.record.companyId)).slice(0, MAX_CANDIDATES).map(({ record }) =>
        registryEvidence(this.id, `${this.name} (${record.sourceName})`, ctx.now, {
          recordId: record.companyId, legalName: record.companyName, otherNames: [record.nameAr, record.nameEn].filter((n): n is string => Boolean(n)),
          registrationNumber: normalizeRegistrationNumber(record.registrationNumber), lei: null, country: "OM", city: record.wilayat ?? record.governorate ?? null,
          status: record.status === "active" ? "active" : record.status === "inactive" || record.status === "suspended" ? "inactive" : "unknown",
          rawStatus: record.status, incorporationDate: record.registrationDate, leiRegistrationStatus: null, hasInsolvencyHistory: null,
          url: record.sourceUrl, lastUpdated: record.observedAt, recordKind: "company_registry"
        }));
      return { status: "ok", evidence, reason: null, requests: queries.length, estimatedCostUSD: 0 };
    } catch {
      return outage("unavailable", "The Oman company registry could not be queried.");
    }
  }
}
