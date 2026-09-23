import { getCslApiKey, getCslApiUrl, getEuSanctionsListUrl, getOpenSanctionsApiKey, getOpenSanctionsApiUrl, getSanctionsProviderIds, getUnSanctionsListUrl, type SanctionsProviderId } from "./config.js";
import { nameMatchScore } from "./nameMatching.js";

/**
 * Provider-based sanctions list retrieval, shared by oman_supplier_check and
 * company_reputation_check (moved here from src/supplier-check/providers/sanctionsProviders.ts,
 * which re-exports it). A provider only RETRIEVES candidate list entries; deciding whether any of
 * them is a potential match is done centrally and conservatively in ./nameMatching.ts so every
 * list is judged by the same thresholds. Adding a list means one new class implementing
 * SanctionsListProvider.
 *
 * Built-in providers call fixed, operator-configured URLs (never a URL supplied by an API caller),
 * so they use plain fetch with a timeout rather than the SSRF-guarded fetcher.
 */

export interface SanctionsListEntry {
  name: string;
  aliases: string[];
  listName: string;
  /** The list's own reference/program id, when it has one (UN reference number, OFAC program). */
  reference: string | null;
  sourceUrl: string | null;
  /** Countries associated with the listed entity (addresses/nationality), as published — ISO-2
   *  codes or country names depending on the list. Optional: used only to corroborate a match,
   *  never to create one. */
  countries?: string[];
  /** Registration / identification numbers published by the list for the entity, when any. */
  identifiers?: string[];
  /** Schema/subject type when the list distinguishes (e.g. "entity", "individual"). */
  subjectType?: string | null;
}

export interface SanctionsListEvidence {
  listName: string;
  /** Loosely pre-filtered entries returned by the list for this name — NOT matches yet. */
  candidates: SanctionsListEntry[];
}

/** Same literal unions as supplier-check's ProviderResult so results stay assignable to it. */
export type SanctionsProviderStatus = "ok" | "not_configured" | "unavailable" | "not_applicable";
export interface SanctionsSource { type: "sanctions_list"; name: string; url: string | null; checkedAt: string; observedAt: string | null }
export interface SanctionsListResult {
  status: SanctionsProviderStatus;
  evidence: SanctionsListEvidence | null;
  sources: SanctionsSource[];
  reason: string | null;
  /** True when the failure was a timeout (lets callers report PROVIDER_TIMEOUT distinctly). */
  timedOut?: boolean;
}

export interface SanctionsListProvider {
  readonly id: string;
  readonly name: string;
  readonly kind: "sanctions";
  readonly listName: string;
  screenName(companyName: string, now: Date): Promise<SanctionsListResult>;
}

const FETCH_TIMEOUT_MS = 15_000;
/** Loose pre-filter only — the real, conservative decision is in sanctionsMatcher.ts. */
const PREFILTER_SCORE = 0.6;

async function timedFetch(fetchImpl: typeof fetch, url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try { return await fetchImpl(url, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------------------------------------
// UN Security Council Consolidated List (public XML, entities only)
// ---------------------------------------------------------------------------------------------

export class UnConsolidatedListProvider implements SanctionsListProvider {
  readonly kind = "sanctions" as const;
  readonly id = "sanctions_un_consolidated";
  readonly name = "UN Security Council Consolidated List";
  readonly listName = "UN Security Council Consolidated List";
  private cache: { entries: SanctionsListEntry[]; loadedAt: number } | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly url: string;
  private readonly listTtlMs: number;

  constructor(options: { fetchImpl?: typeof fetch; url?: string; listTtlMs?: number } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.url = options.url ?? getUnSanctionsListUrl();
    this.listTtlMs = options.listTtlMs ?? 12 * 60 * 60 * 1000;
  }

  private async loadEntries(now: Date): Promise<SanctionsListEntry[] | null> {
    if (this.cache && now.getTime() - this.cache.loadedAt < this.listTtlMs) return this.cache.entries;
    try {
      const response = await timedFetch(this.fetchImpl, this.url, { headers: { Accept: "application/xml,text/xml" } });
      if (!response.ok) return null;
      const entries = parseUnConsolidatedXml(await response.text(), this.url);
      if (entries.length === 0) return null; // an empty parse of the real list means a format change, not "nobody is listed"
      this.cache = { entries, loadedAt: now.getTime() };
      return entries;
    } catch {
      return null;
    }
  }

  async screenName(companyName: string, now: Date): Promise<SanctionsListResult> {
    const entries = await this.loadEntries(now);
    if (!entries) return { status: "unavailable", evidence: null, sources: [], reason: "The UN Consolidated List could not be retrieved." };
    const candidates = entries.filter(e => [e.name, ...e.aliases].some(n => nameMatchScore(companyName, n).score >= PREFILTER_SCORE)).slice(0, 20);
    return {
      status: "ok", evidence: { listName: this.listName, candidates },
      sources: [{ type: "sanctions_list", name: this.listName, url: this.url, checkedAt: now.toISOString(), observedAt: null }], reason: null
    };
  }
}

/** Minimal, dependency-free extraction of <ENTITY> names/aliases from the UN XML. */
export function parseUnConsolidatedXml(xml: string, sourceUrl: string | null = null): SanctionsListEntry[] {
  const entries: SanctionsListEntry[] = [];
  const text = (s: string | undefined) => (s ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&apos;/g, "'").replace(/&quot;/g, "\"").trim();
  for (const block of xml.matchAll(/<ENTITY>([\s\S]*?)<\/ENTITY>/g)) {
    const body = block[1]!;
    const name = text(/<FIRST_NAME>([\s\S]*?)<\/FIRST_NAME>/.exec(body)?.[1]);
    if (!name) continue;
    const aliases = [...body.matchAll(/<ALIAS_NAME>([\s\S]*?)<\/ALIAS_NAME>/g)].map(m => text(m[1])).filter(Boolean);
    const reference = text(/<REFERENCE_NUMBER>([\s\S]*?)<\/REFERENCE_NUMBER>/.exec(body)?.[1]) || null;
    const countries = [...new Set([...body.matchAll(/<COUNTRY>([\s\S]*?)<\/COUNTRY>/g)].map(m => text(m[1])).filter(Boolean))];
    entries.push({ name, aliases, listName: "UN Security Council Consolidated List", reference, sourceUrl, countries, subjectType: "entity" });
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// US Consolidated Screening List (trade.gov; includes OFAC SDN and other US lists)
// ---------------------------------------------------------------------------------------------

export class UsConsolidatedScreeningListProvider implements SanctionsListProvider {
  readonly kind = "sanctions" as const;
  readonly id = "sanctions_us_csl";
  readonly name = "US Consolidated Screening List (includes OFAC SDN)";
  readonly listName = "US Consolidated Screening List (includes OFAC SDN)";
  private readonly fetchImpl: typeof fetch;
  private readonly url: string;
  private readonly apiKey: string | null;

  constructor(options: { fetchImpl?: typeof fetch; url?: string; apiKey?: string | null } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.url = options.url ?? getCslApiUrl();
    this.apiKey = options.apiKey === undefined ? getCslApiKey() : options.apiKey;
  }

  async screenName(companyName: string, now: Date): Promise<SanctionsListResult> {
    const url = `${this.url}?name=${encodeURIComponent(companyName)}&fuzzy_name=true&size=20`;
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (this.apiKey) headers["subscription-key"] = this.apiKey;
      const response = await timedFetch(this.fetchImpl, url, { headers });
      if (!response.ok) return { status: "unavailable", evidence: null, sources: [], reason: `The US Consolidated Screening List returned HTTP ${response.status}.` };
      const body = (await response.json()) as { results?: unknown };
      const results = Array.isArray(body.results) ? body.results : [];
      const candidates: SanctionsListEntry[] = [];
      for (const r of results) {
        if (!r || typeof r !== "object") continue;
        const rec = r as Record<string, unknown>;
        if (typeof rec.name !== "string") continue;
        const aliases = Array.isArray(rec.alt_names) ? rec.alt_names.filter((a): a is string => typeof a === "string") : [];
        const programs = Array.isArray(rec.programs) ? rec.programs.filter((p): p is string => typeof p === "string") : [];
        const listSource = typeof rec.source === "string" ? rec.source : this.listName;
        const addresses = Array.isArray(rec.addresses) ? rec.addresses : [];
        const countries = [...new Set(addresses.map(a => (a && typeof a === "object" ? (a as Record<string, unknown>).country : null)).filter((c): c is string => typeof c === "string" && c.trim().length > 0))];
        const ids = Array.isArray(rec.ids) ? rec.ids : [];
        const identifiers = ids.map(i => (i && typeof i === "object" ? (i as Record<string, unknown>).number : null)).filter((n): n is string => typeof n === "string" && n.trim().length > 0);
        candidates.push({ name: rec.name, aliases, listName: listSource, reference: programs.join(", ") || null, sourceUrl: typeof rec.source_list_url === "string" ? rec.source_list_url : null, countries, identifiers, subjectType: typeof rec.type === "string" ? rec.type.toLowerCase() : null });
      }
      // Never forward the query URL (it may be combined with a key header upstream) — cite the list endpoint only.
      return { status: "ok", evidence: { listName: this.listName, candidates }, sources: [{ type: "sanctions_list", name: this.listName, url: this.url, checkedAt: now.toISOString(), observedAt: null }], reason: null };
    } catch (error) {
      return { status: "unavailable", evidence: null, sources: [], reason: "The US Consolidated Screening List could not be reached.", timedOut: isAbort(error) };
    }
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

// ---------------------------------------------------------------------------------------------
// EU Financial Sanctions Files (FSF) — full XML list. Disabled unless EU_SANCTIONS_LIST_URL is set
// (the EU issues the download URL with a personal token, so there is no safe default).
// ---------------------------------------------------------------------------------------------

export class EuFinancialSanctionsProvider implements SanctionsListProvider {
  readonly kind = "sanctions" as const;
  readonly id = "sanctions_eu_fsf";
  readonly name = "EU Financial Sanctions Files (consolidated list)";
  readonly listName = "EU Financial Sanctions Files (consolidated list)";
  private cache: { entries: SanctionsListEntry[]; loadedAt: number } | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly url: string | null;
  private readonly listTtlMs: number;

  constructor(options: { fetchImpl?: typeof fetch; url?: string | null; listTtlMs?: number } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.url = options.url === undefined ? getEuSanctionsListUrl() : options.url;
    this.listTtlMs = options.listTtlMs ?? 12 * 60 * 60 * 1000;
  }

  async screenName(companyName: string, now: Date): Promise<SanctionsListResult> {
    if (!this.url) return { status: "not_configured", evidence: null, sources: [], reason: "EU sanctions list is not configured (EU_SANCTIONS_LIST_URL)." };
    let entries = this.cache && now.getTime() - this.cache.loadedAt < this.listTtlMs ? this.cache.entries : null;
    if (!entries) {
      try {
        const response = await timedFetch(this.fetchImpl, this.url, { headers: { Accept: "application/xml,text/xml" } });
        if (!response.ok) return { status: "unavailable", evidence: null, sources: [], reason: `The EU sanctions list returned HTTP ${response.status}.` };
        const parsed = parseEuFsfXml(await response.text());
        if (parsed.length === 0) return { status: "unavailable", evidence: null, sources: [], reason: "The EU sanctions list could not be parsed." };
        this.cache = { entries: parsed, loadedAt: now.getTime() };
        entries = parsed;
      } catch (error) {
        return { status: "unavailable", evidence: null, sources: [], reason: "The EU sanctions list could not be retrieved.", timedOut: isAbort(error) };
      }
    }
    const candidates = entries.filter(e => [e.name, ...e.aliases].some(n => nameMatchScore(companyName, n).score >= PREFILTER_SCORE)).slice(0, 20);
    // The configured URL embeds a personal token — never cite it. Cite the public list page instead.
    const publicUrl = "https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions";
    return { status: "ok", evidence: { listName: this.listName, candidates }, sources: [{ type: "sanctions_list", name: this.listName, url: publicUrl, checkedAt: now.toISOString(), observedAt: null }], reason: null };
  }
}

/** Minimal, dependency-free extraction of ENTERPRISE entries from the EU FSF XML (v1.1 format:
 *  <sanctionEntity> blocks with <subjectType code="enterprise"/>, <nameAlias wholeName="..."/>,
 *  <address countryIso2Code="..."/> and <identification number="..."/>). Persons are skipped:
 *  this is company-level screening only. */
export function parseEuFsfXml(xml: string): SanctionsListEntry[] {
  const attr = (tag: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1]?.replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").trim() ?? "";
  const entries: SanctionsListEntry[] = [];
  for (const block of xml.matchAll(/<sanctionEntity\b([^>]*)>([\s\S]*?)<\/sanctionEntity>/g)) {
    const [, openAttrs, body] = block as unknown as [string, string, string];
    const subject = /<subjectType\b[^>]*code="([^"]*)"/.exec(body)?.[1] ?? "";
    if (subject !== "enterprise") continue;
    const names = [...body.matchAll(/<nameAlias\b[^>]*>/g)].map(m => attr(m[0], "wholeName")).filter(Boolean);
    if (names.length === 0) continue;
    const countries = [...new Set([...body.matchAll(/<(?:address|citizenship)\b[^>]*>/g)].map(m => attr(m[0], "countryIso2Code")).filter(c => c && c !== "00"))];
    const identifiers = [...body.matchAll(/<identification\b[^>]*>/g)].map(m => attr(m[0], "number")).filter(Boolean);
    const reference = attr(`<x ${openAttrs}>`, "euReferenceNumber") || attr(`<x ${openAttrs}>`, "logicalId") || null;
    entries.push({ name: names[0]!, aliases: [...new Set(names.slice(1))], listName: "EU Financial Sanctions Files (consolidated list)", reference, sourceUrl: null, countries, identifiers, subjectType: "entity" });
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// OpenSanctions matching API (paid for commercial use). Disabled unless OPENSANCTIONS_API_KEY set.
// Aggregates UN, EU, UK, US and many national lists, and returns structured countries and
// registration identifiers that make corroboration possible.
// ---------------------------------------------------------------------------------------------

export class OpenSanctionsProvider implements SanctionsListProvider {
  readonly kind = "sanctions" as const;
  readonly id = "sanctions_opensanctions";
  readonly name = "OpenSanctions (aggregated sanctions lists)";
  readonly listName = "OpenSanctions (aggregated sanctions lists)";
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: string | null;
  private readonly url: string;

  constructor(options: { fetchImpl?: typeof fetch; apiKey?: string | null; url?: string } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiKey = options.apiKey === undefined ? getOpenSanctionsApiKey() : options.apiKey;
    this.url = options.url ?? getOpenSanctionsApiUrl();
  }

  async screenName(companyName: string, now: Date, hints: { country?: string | null; registrationNumber?: string | null } = {}): Promise<SanctionsListResult> {
    if (!this.apiKey) return { status: "not_configured", evidence: null, sources: [], reason: "OpenSanctions is not configured (OPENSANCTIONS_API_KEY)." };
    const properties: Record<string, string[]> = { name: [companyName] };
    if (hints.country) properties.jurisdiction = [hints.country.toLowerCase()];
    if (hints.registrationNumber) properties.registrationNumber = [hints.registrationNumber];
    try {
      const response = await timedFetch(this.fetchImpl, this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `ApiKey ${this.apiKey}` },
        body: JSON.stringify({ queries: { q: { schema: "Company", properties } } })
      });
      if (!response.ok) return { status: "unavailable", evidence: null, sources: [], reason: `OpenSanctions returned HTTP ${response.status}.` };
      const body = (await response.json()) as { responses?: Record<string, { results?: unknown }> };
      const results = Array.isArray(body.responses?.q?.results) ? body.responses!.q!.results as unknown[] : [];
      const candidates: SanctionsListEntry[] = [];
      for (const r of results.slice(0, 20)) {
        if (!r || typeof r !== "object") continue;
        const rec = r as Record<string, unknown>;
        const props = (rec.properties && typeof rec.properties === "object" ? rec.properties : {}) as Record<string, unknown>;
        const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
        const caption = typeof rec.caption === "string" ? rec.caption : strs(props.name)[0];
        if (!caption) continue;
        const datasets = strs(rec.datasets);
        candidates.push({
          name: caption,
          aliases: [...new Set([...strs(props.name), ...strs(props.alias)].filter(n => n !== caption))].slice(0, 20),
          listName: datasets.length ? `OpenSanctions: ${datasets.slice(0, 3).join(", ")}` : this.listName,
          reference: typeof rec.id === "string" ? rec.id : null,
          sourceUrl: typeof rec.id === "string" ? `https://www.opensanctions.org/entities/${encodeURIComponent(rec.id)}/` : null,
          countries: [...new Set([...strs(props.country), ...strs(props.jurisdiction)])],
          identifiers: [...strs(props.registrationNumber), ...strs(props.leiCode), ...strs(props.taxNumber)],
          subjectType: typeof rec.schema === "string" ? rec.schema.toLowerCase() : null
        });
      }
      return { status: "ok", evidence: { listName: this.listName, candidates }, sources: [{ type: "sanctions_list", name: this.listName, url: "https://www.opensanctions.org/", checkedAt: now.toISOString(), observedAt: null }], reason: null };
    } catch (error) {
      return { status: "unavailable", evidence: null, sources: [], reason: "OpenSanctions could not be reached.", timedOut: isAbort(error) };
    }
  }
}

export function buildSanctionsProviders(ids: readonly SanctionsProviderId[] = getSanctionsProviderIds()): SanctionsListProvider[] {
  return ids.map(id => (id === "un" ? new UnConsolidatedListProvider() : new UsConsolidatedScreeningListProvider()));
}
