import { recordProviderCost } from "../../intelligence/costEstimator.js";
import {
  BODY_SYNONYMS, DRIVETRAIN_SYNONYMS, FUEL_SYNONYMS, TRANSMISSION_SYNONYMS, matchKey
} from "../normalization.js";
import { median } from "../stats.js";
import { BODY_TYPES, DRIVETRAINS, FUEL_TYPES, TRANSMISSIONS } from "../types.js";
import type { NewVehiclePriceReference, VehicleComparable, VehicleMarketProvider, VehicleMarketQuery } from "../types.js";
import { hashVin } from "../vin.js";

/**
 * MarketCheck Inventory Search (https://docs.marketcheck.com/docs/api/cars/inventory/inventory-search)
 * — a licensed, paid market-data API with active dealer listings for the United States and Canada:
 * `GET https://api.marketcheck.com/v2/search/car/active?api_key=…&make=…&model=…&year_range=min-max&car_type=used&country=us|ca&rows=50&start=…`
 * returning `{ num_found, listings: [{ id, vin, price, miles, vdp_url, last_seen_at_date, msrp,
 * build: { year, make, model, trim, body_type, fuel_type, transmission, drivetrain },
 * dealer: { city, state, country } }] }`.
 *
 * Enabled only when MARKETCHECK_API_KEY is set. The key is sent as the documented `api_key` query
 * parameter from the server side only and never appears in any response, log or error. Odometer
 * `miles` are converted to km; prices are USD (US) / CAD (Canada). Only vehicle and market fields
 * are mapped — dealer contact details and the VIN are never kept (the VIN becomes a hash used only
 * to exclude the subject vehicle's own listing).
 *
 * New-price reference: the median of the listings' `msrp` for the exact model year (and trim when
 * known) — MarketCheck documents it as the MSRP "as per dealer website", so the source is labelled
 * dealer-reported and at least 3 listings must agree before it is used.
 */

const MILES_TO_KM = 1.609344;
const COUNTRY_CURRENCY: Readonly<Record<string, string>> = { US: "USD", CA: "CAD" };
/** Rafid's own cost estimate per MarketCheck search request (never MarketCheck's actual pricing). */
export const MARKETCHECK_ESTIMATED_COST_PER_REQUEST_USD = 0.002;

interface McListing {
  id?: unknown; vin?: unknown; price?: unknown; miles?: unknown; vdp_url?: unknown; msrp?: unknown;
  last_seen_at_date?: unknown; last_seen_at?: unknown; first_seen_at_date?: unknown; inventory_type?: unknown;
  build?: { year?: unknown; make?: unknown; model?: unknown; trim?: unknown; body_type?: unknown; fuel_type?: unknown; transmission?: unknown; drivetrain?: unknown };
  dealer?: { city?: unknown; country?: unknown };
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
function category<T extends readonly string[]>(raw: unknown, synonyms: Readonly<Record<string, string>>, allowed: T): T[number] | undefined {
  const s = str(raw);
  if (!s) return undefined;
  const direct = synonyms[matchKey(s)];
  if (direct && (allowed as readonly string[]).includes(direct)) return direct as T[number];
  // MarketCheck values are often compound ("Gasoline Fuel", "Automatic 10-Speed", "4WD") — try each word.
  for (const word of s.split(/[^A-Za-z0-9]+/)) {
    const hit = synonyms[matchKey(word)];
    if (hit && (allowed as readonly string[]).includes(hit)) return hit as T[number];
  }
  return undefined;
}

export function mapMarketCheckListing(l: McListing, country: string): (VehicleComparable & { msrp?: number }) | null {
  const b = l.build ?? {};
  const price = Number(l.price);
  const year = Number(b.year);
  const make = str(b.make); const model = str(b.model);
  if (!make || !model || !Number.isFinite(price) || price <= 0 || !Number.isInteger(year)) return null;
  const miles = Number(l.miles);
  const observed = str(l.last_seen_at_date) ?? (Number.isFinite(Number(l.last_seen_at)) ? new Date(Number(l.last_seen_at) * 1000).toISOString() : undefined) ?? str(l.first_seen_at_date);
  const out: VehicleComparable & { msrp?: number } = {
    make, model, year, askingPrice: price, currency: COUNTRY_CURRENCY[country]!, country, sourceName: "marketcheck", priceType: "listing"
  };
  const trim = str(b.trim); if (trim) out.trim = trim;
  if (Number.isFinite(miles) && miles >= 0) out.mileageKm = Math.round(miles * MILES_TO_KM);
  const body = category(b.body_type, BODY_SYNONYMS, BODY_TYPES); if (body) out.bodyType = body;
  const fuel = category(b.fuel_type, FUEL_SYNONYMS, FUEL_TYPES); if (fuel) out.fuelType = fuel;
  const transmission = category(b.transmission, TRANSMISSION_SYNONYMS, TRANSMISSIONS); if (transmission) out.transmission = transmission;
  const drivetrain = category(b.drivetrain, DRIVETRAIN_SYNONYMS, DRIVETRAINS); if (drivetrain) out.drivetrain = drivetrain;
  const city = str(l.dealer?.city); if (city) out.city = city;
  const id = str(l.id) ?? (typeof l.id === "number" ? String(l.id) : undefined); if (id) out.sourceRecordId = id;
  const url = str(l.vdp_url); if (url) out.sourceUrl = url;
  if (observed) out.observedAt = observed;
  const vin = str(l.vin); if (vin) out.vinHash = hashVin(vin);
  const msrp = Number(l.msrp); if (Number.isFinite(msrp) && msrp > 0) out.msrp = msrp;
  return out;
}

export interface MarketCheckOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Result pages (50 rows each) per market per search. Default 2 (≤ 100 listings). */
  pages?: number;
  countries?: readonly ("US" | "CA")[];
}

export class MarketCheckVehicleProvider implements VehicleMarketProvider {
  readonly id = "marketcheck";
  readonly newPriceRank = 50;
  private readonly countries: readonly string[];
  /** Last search's MSRP observations, keyed by query — lets getNewVehiclePrice reuse the search
   *  instead of paying for a second request. */
  private readonly msrpByQuery = new Map<string, { year: number; trimKey: string; msrp: number }[]>();

  constructor(private readonly options: MarketCheckOptions) {
    this.countries = options.countries ?? ["US", "CA"];
  }

  supports(market: { country: string; regionalCountries: readonly string[] }): boolean {
    return this.countries.includes(market.country) || market.regionalCountries.some(c => this.countries.includes(c));
  }

  private async fetchPage(country: string, query: VehicleMarketQuery, start: number, signal: AbortSignal): Promise<McListing[]> {
    const params = new URLSearchParams({
      api_key: this.options.apiKey, make: query.make.toLowerCase(), model: query.model.toLowerCase(),
      year_range: `${query.yearMin}-${query.yearMax}`, car_type: "used", country: country.toLowerCase(), rows: "50", start: String(start)
    });
    const response = await (this.options.fetchImpl ?? fetch)(`${this.options.baseUrl ?? "https://api.marketcheck.com"}/v2/search/car/active?${params}`, { signal, headers: { Accept: "application/json" } });
    recordProviderCost({ capability: "vehicle_value_estimate", provider: "marketcheck", estimatedCostUSD: MARKETCHECK_ESTIMATED_COST_PER_REQUEST_USD, requestId: null });
    // Never echo the upstream body or URL (the URL carries the key) into an error.
    if (!response.ok) throw new Error(`marketcheck HTTP ${response.status}`);
    const body = await response.json() as { listings?: unknown };
    return Array.isArray(body.listings) ? body.listings as McListing[] : [];
  }

  async searchComparables(query: VehicleMarketQuery, signal: AbortSignal): Promise<VehicleComparable[]> {
    const pages = Math.max(1, Math.min(this.options.pages ?? 2, 10));
    const out: VehicleComparable[] = [];
    const msrps: { year: number; trimKey: string; msrp: number }[] = [];
    for (const country of query.countries.filter(c => this.countries.includes(c))) {
      for (let page = 0; page < pages; page++) {
        const listings = await this.fetchPage(country, query, page * 50, signal);
        for (const l of listings) {
          const mapped = mapMarketCheckListing(l, country);
          if (!mapped) continue;
          const { msrp, ...comparable } = mapped;
          if (msrp) msrps.push({ year: comparable.year, trimKey: matchKey(comparable.trim ?? ""), msrp });
          out.push(comparable);
        }
        if (listings.length < 50) break;
      }
    }
    this.msrpByQuery.set(`${query.makeKey}|${query.modelKey}|${query.countries[0]}`, msrps);
    return out;
  }

  async getNewVehiclePrice(query: { makeKey: string; modelKey: string; year: number; trimKey: string | null; country: string }): Promise<NewVehiclePriceReference | null> {
    if (!this.countries.includes(query.country)) return null;
    const observations = (this.msrpByQuery.get(`${query.makeKey}|${query.modelKey}|${query.country}`) ?? [])
      .filter(o => o.year === query.year && (!query.trimKey || o.trimKey === query.trimKey));
    if (observations.length < 3) return null;
    return { price: median(observations.map(o => o.msrp))!, currency: COUNTRY_CURRENCY[query.country]!, sourceName: `MarketCheck dealer-reported MSRP (median of ${observations.length} listings)` };
  }
}
