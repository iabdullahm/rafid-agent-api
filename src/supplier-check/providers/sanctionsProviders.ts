import { getCslApiKey, getCslApiUrl, getSanctionsProviderIds, getUnSanctionsListUrl, type SanctionsProviderId } from "../config.js";
import type { ProviderResult, SupplierDataProvider } from "../types.js";
import { nameMatchScore } from "../sanctionsMatcher.js";

/**
 * Provider-based sanctions screening (spec: "Design this in a provider-based way so more data
 * sources can be added later"). A provider only RETRIEVES candidate list entries; deciding
 * whether any of them is a potential match is done centrally and conservatively in
 * ../sanctionsMatcher.ts so every list is judged by the same thresholds. Adding a list (EU, UK
 * HMT, a licensed screening vendor) means one new class implementing SanctionsListProvider.
 *
 * Both built-in providers call fixed, operator-configured government URLs (never a URL supplied
 * by an API caller), so they use plain fetch with a timeout rather than the SSRF-guarded fetcher.
 */

export interface SanctionsListEntry {
  name: string;
  aliases: string[];
  listName: string;
  /** The list's own reference/program id, when it has one (UN reference number, OFAC program). */
  reference: string | null;
  sourceUrl: string | null;
}

export interface SanctionsListEvidence {
  listName: string;
  /** Loosely pre-filtered entries returned by the list for this name — NOT matches yet. */
  candidates: SanctionsListEntry[];
}

export interface SanctionsListProvider extends SupplierDataProvider {
  readonly kind: "sanctions";
  readonly listName: string;
  screenName(companyName: string, now: Date): Promise<ProviderResult<SanctionsListEvidence>>;
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

  async screenName(companyName: string, now: Date): Promise<ProviderResult<SanctionsListEvidence>> {
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
    entries.push({ name, aliases, listName: "UN Security Council Consolidated List", reference, sourceUrl });
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

  async screenName(companyName: string, now: Date): Promise<ProviderResult<SanctionsListEvidence>> {
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
        candidates.push({ name: rec.name, aliases, listName: listSource, reference: programs.join(", ") || null, sourceUrl: typeof rec.source_list_url === "string" ? rec.source_list_url : null });
      }
      // Never forward the query URL (it may be combined with a key header upstream) — cite the list endpoint only.
      return { status: "ok", evidence: { listName: this.listName, candidates }, sources: [{ type: "sanctions_list", name: this.listName, url: this.url, checkedAt: now.toISOString(), observedAt: null }], reason: null };
    } catch {
      return { status: "unavailable", evidence: null, sources: [], reason: "The US Consolidated Screening List could not be reached." };
    }
  }
}

export function buildSanctionsProviders(ids: readonly SanctionsProviderId[] = getSanctionsProviderIds()): SanctionsListProvider[] {
  return ids.map(id => (id === "un" ? new UnConsolidatedListProvider() : new UsConsolidatedScreeningListProvider()));
}
