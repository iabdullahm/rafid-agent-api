import type { VehicleMarketRepository } from "../store/repository.js";
import type { NewVehiclePriceReference, VehicleComparable, VehicleMarketProvider, VehicleMarketQuery } from "../types.js";

/**
 * vehicle_value_estimate — concrete market-data providers.
 *
 * Only providers backed by REAL evidence belong in a production registry. Country- or
 * marketplace-specific live providers (e.g. an Oman listings API, a UAE dealer feed, a US
 * wholesale-auction feed) implement the same VehicleMarketProvider interface and are added to the
 * registry in config.ts — the valuation core does not change. None ships today: see README
 * "vehicle_value_estimate → market data".
 */

/** Countries a provider declares coverage for: explicit ISO codes, or "*" for any. */
export type CountryCoverage = readonly string[] | "*";

function covers(coverage: CountryCoverage, market: { country: string; regionalCountries: readonly string[] }): boolean {
  if (coverage === "*") return true;
  return coverage.includes(market.country) || market.regionalCountries.some(c => coverage.includes(c));
}

/** Reads imported vehicle_market_records (licensed feeds, partner exports, auction results) through
 *  the repository abstraction. Coverage is declared by the operator (VEHICLE_MARKET_COUNTRIES) so a
 *  free preview can say whether evidence exists for a market without querying the database. */
export class DatabaseVehicleMarketProvider implements VehicleMarketProvider {
  readonly id = "vehicle_market_records";
  /** Operator-imported official price lists outrank dealer-reported MSRPs. */
  readonly newPriceRank = 10;
  constructor(private readonly repository: VehicleMarketRepository, private readonly coverage: CountryCoverage, private readonly limit = 500) {}
  supports(market: { country: string; regionalCountries: readonly string[] }): boolean { return covers(this.coverage, market); }
  searchComparables(query: VehicleMarketQuery): Promise<VehicleComparable[]> { return this.repository.findComparables(query, this.limit); }
  async getNewVehiclePrice(query: { makeKey: string; modelKey: string; year: number; trimKey: string | null; country: string }): Promise<NewVehiclePriceReference | null> {
    if (!covers(this.coverage, { country: query.country, regionalCountries: [] })) return null;
    const r = await this.repository.findNewPrice(query);
    return r ? { price: r.price, currency: r.currency, sourceName: `${r.sourceName}${r.effectiveDate ? ` (effective ${r.effectiveDate})` : ""}` } : null;
  }
}

/**
 * A fixed, in-memory evidence set. Used for deterministic tests and for the documented synthetic
 * example — never registered by default in production. `id`, coverage and an optional delay /
 * failure mode are configurable so tests can exercise the router (timeouts, partial failures,
 * duplicates across providers).
 */
export class StaticVehicleMarketProvider implements VehicleMarketProvider {
  constructor(
    readonly id: string,
    private readonly records: readonly VehicleComparable[],
    private readonly options: { coverage?: CountryCoverage; delayMs?: number; fail?: boolean; newPrices?: Readonly<Record<string, NewVehiclePriceReference>> } = {}
  ) {}

  supports(market: { country: string; regionalCountries: readonly string[] }): boolean { return covers(this.options.coverage ?? "*", market); }

  async searchComparables(query: VehicleMarketQuery, signal: AbortSignal): Promise<VehicleComparable[]> {
    if (this.options.delayMs) await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, this.options.delayMs);
      signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
    });
    if (this.options.fail) throw new Error(`${this.id} unavailable`);
    const key = (s: string) => s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const after = Date.parse(query.observedAfter);
    return this.records.filter(r => key(r.make) === query.makeKey && key(r.model) === query.modelKey && r.year >= query.yearMin && r.year <= query.yearMax
      && query.countries.includes(r.country) && (!r.observedAt || Date.parse(r.observedAt) >= after));
  }

  async getNewVehiclePrice(query: { makeKey: string; modelKey: string; year: number; trimKey: string | null; country: string }): Promise<NewVehiclePriceReference | null> {
    return this.options.newPrices?.[`${query.makeKey}|${query.modelKey}|${query.year}|${query.trimKey ?? ""}|${query.country}`] ?? null;
  }
}
