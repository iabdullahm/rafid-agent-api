import { parseCsv } from "../../domain/oman/importPipeline.js";
import { safeFeedFetch, type SafeFeedFetchOptions } from "../../domain/oman/safeFeedFetch.js";
import { validateVehicleMarketRows } from "../store/records.js";
import { recordToComparable } from "../store/repository.js";
import type { VehicleComparable, VehicleMarketProvider, VehicleMarketQuery } from "../types.js";

/**
 * Partner / licensed HTTPS listings feed — the path for markets with no public listings API (e.g.
 * an Oman or UAE dealer group, a classifieds partner or an auction house that agrees to share its
 * inventory). The partner publishes a JSON array (or `{ "records": [...] }`) or a CSV in the
 * vehicle_market_records row format (see README); Rafid fetches it over HTTPS through the same
 * SSRF-protected, size- and time-bounded fetcher the Production Feed Runner uses
 * (domain/oman/safeFeedFetch.ts — private/loopback addresses and unvalidated redirects refused),
 * validates every row, drops personal-data columns, and serves matching rows as comparables. The
 * whole feed is cached per provider for `cacheTtlMs`. No scraping: only feeds a partner publishes
 * for Rafid.
 */

export interface HttpFeedConfig {
  id: string;
  url: string;
  /** ISO alpha-2 markets the feed covers. */
  countries: readonly string[];
  format?: "json" | "csv";
  /** Name of an environment variable holding the Authorization header value (never the secret itself). */
  authHeaderEnv?: string;
}

export interface HttpFeedOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  cacheTtlMs?: number;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** Tests only. */
  fetchOptions?: Partial<SafeFeedFetchOptions>;
}

export class HttpFeedVehicleProvider implements VehicleMarketProvider {
  readonly id: string;
  private cached: { at: number; rows: VehicleComparable[] } | null = null;

  constructor(private readonly config: HttpFeedConfig, private readonly options: HttpFeedOptions = {}) {
    this.id = `feed:${config.id}`;
  }

  supports(market: { country: string; regionalCountries: readonly string[] }): boolean {
    return this.config.countries.includes(market.country) || market.regionalCountries.some(c => this.config.countries.includes(c));
  }

  private async load(): Promise<VehicleComparable[]> {
    const now = (this.options.now ?? Date.now)();
    const ttl = this.options.cacheTtlMs ?? 60 * 60 * 1000;
    if (this.cached && now - this.cached.at < ttl) return this.cached.rows;
    const env = this.options.env ?? process.env;
    const auth = this.config.authHeaderEnv ? env[this.config.authHeaderEnv] : undefined;
    const result = await safeFeedFetch(this.config.url, {
      timeoutMs: this.options.timeoutMs ?? 8000, maxResponseBytes: this.options.maxResponseBytes ?? 10 * 1024 * 1024,
      fetchImpl: this.options.fetchImpl, headers: { Accept: "application/json, text/csv", ...(auth ? { Authorization: auth } : {}) },
      ...this.options.fetchOptions
    });
    if (result.status < 200 || result.status >= 300) throw new Error(`feed ${this.config.id} HTTP ${result.status}`);
    const format = this.config.format ?? (/csv/i.test(result.contentType ?? "") || /\.csv(\?|$)/i.test(this.config.url) ? "csv" : "json");
    let rows: Record<string, unknown>[];
    if (format === "csv") rows = parseCsv(result.body);
    else {
      const parsed = JSON.parse(result.body) as unknown;
      rows = (Array.isArray(parsed) ? parsed : (parsed as { records?: unknown[] })?.records ?? []) as Record<string, unknown>[];
    }
    const validated = validateVehicleMarketRows(rows, { sourceType: "partner_feed" });
    const comparables = validated.records.map(recordToComparable);
    this.cached = { at: now, rows: comparables };
    return comparables;
  }

  async searchComparables(query: VehicleMarketQuery): Promise<VehicleComparable[]> {
    const key = (s: string) => s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const after = Date.parse(query.observedAfter);
    return (await this.load()).filter(r => key(r.make) === query.makeKey && key(r.model) === query.modelKey && r.year >= query.yearMin && r.year <= query.yearMax
      && query.countries.includes(r.country) && (!r.observedAt || Date.parse(r.observedAt) >= after));
  }
}

/** Parses VEHICLE_MARKET_FEEDS_JSON; invalid entries are rejected at startup, never half-used. */
export function parseFeedConfigs(raw: string | undefined): HttpFeedConfig[] {
  if (!raw || !raw.trim()) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("VEHICLE_MARKET_FEEDS_JSON must be a JSON array");
  return parsed.map((entry, i) => {
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || !/^[a-z0-9][a-z0-9_-]{1,40}$/.test(e.id)) throw new Error(`VEHICLE_MARKET_FEEDS_JSON[${i}].id must be a short lowercase slug`);
    if (typeof e.url !== "string" || !e.url.startsWith("https://")) throw new Error(`VEHICLE_MARKET_FEEDS_JSON[${i}].url must be an https URL`);
    const countries = Array.isArray(e.countries) ? e.countries.map(c => String(c).toUpperCase()).filter(c => /^[A-Z]{2}$/.test(c)) : [];
    if (!countries.length) throw new Error(`VEHICLE_MARKET_FEEDS_JSON[${i}].countries must list ISO alpha-2 codes`);
    if (e.format !== undefined && e.format !== "json" && e.format !== "csv") throw new Error(`VEHICLE_MARKET_FEEDS_JSON[${i}].format must be json or csv`);
    if (e.authHeaderEnv !== undefined && (typeof e.authHeaderEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(e.authHeaderEnv))) throw new Error(`VEHICLE_MARKET_FEEDS_JSON[${i}].authHeaderEnv must be an environment variable name`);
    return { id: e.id, url: e.url, countries, format: e.format as HttpFeedConfig["format"], authHeaderEnv: e.authHeaderEnv as string | undefined };
  });
}
