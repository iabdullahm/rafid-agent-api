import { TtlCache, cacheKey } from "../../intelligence/cache.js";
import { matchKey, normalizeCity } from "../normalization.js";
import { BODY_TYPES, CONDITIONS, DRIVETRAINS, FUEL_TYPES, TRANSMISSIONS } from "../types.js";
import type { NewVehiclePriceReference, ProviderRun, VehicleComparable, VehicleMarketProvider, VehicleMarketQuery } from "../types.js";

/**
 * vehicle_value_estimate — market-data router.
 *
 * Selects every configured provider that supports the market (subject country or its regional
 * fallback countries), runs them CONCURRENTLY, each under its own timeout (one slow or failing
 * provider never blocks or fails the request — it is reported as `timeout`/`error` and the
 * valuation proceeds on the rest), sanitizes and de-duplicates their results, and returns them in
 * a deterministic order so the valuation downstream is a pure function of the evidence.
 *
 * Provider search results (never final valuations) are cached per provider + market + make/model
 * + model-year window + evidence cut-off day.
 */

export interface RouterOptions {
  timeoutMs: number;
  cache: TtlCache<VehicleComparable[]> | null;
  now: () => number;
}

export interface GatherResult {
  comparables: VehicleComparable[];
  runs: ProviderRun[];
  duplicatesRemoved: number;
  invalidRemoved: number;
  newVehiclePrice: (NewVehiclePriceReference & { providerId: string }) | null;
}

const TIMEOUT = Symbol("timeout");

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T | typeof TIMEOUT> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMEOUT>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(TIMEOUT); }, timeoutMs); });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function selectProviders(providers: readonly VehicleMarketProvider[], market: { country: string; regionalCountries: readonly string[] }): VehicleMarketProvider[] {
  return providers.filter(p => {
    try { return p.supports(market); } catch { return false; }
  });
}

const inEnum = <T extends readonly string[]>(values: T, v: unknown): T[number] | undefined =>
  typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T[number]) : undefined;

/** Keep only well-formed vehicle/market evidence, copying known fields into a fresh object — so
 *  nothing a provider attaches (seller name, phone, e-mail, VIN, raw payload) can pass through. */
export function sanitizeComparable(raw: VehicleComparable): VehicleComparable | null {
  if (!raw || typeof raw !== "object") return null;
  const price = Number(raw.askingPrice);
  const year = Number(raw.year);
  if (!Number.isFinite(price) || price <= 0 || !Number.isInteger(year) || year < 1900 || year > 2100) return null;
  if (typeof raw.make !== "string" || typeof raw.model !== "string" || !matchKey(raw.make) || !matchKey(raw.model)) return null;
  if (typeof raw.currency !== "string" || !/^[A-Z]{3}$/.test(raw.currency)) return null;
  if (typeof raw.country !== "string" || !/^[A-Z]{2}$/.test(raw.country)) return null;
  if (typeof raw.sourceName !== "string" || !raw.sourceName.trim()) return null;
  const mileage = raw.mileageKm === undefined || raw.mileageKm === null ? undefined : Number(raw.mileageKm);
  const observedMs = raw.observedAt ? Date.parse(raw.observedAt) : NaN;
  let sourceUrl: string | undefined;
  if (typeof raw.sourceUrl === "string") {
    try {
      const u = new URL(raw.sourceUrl);
      if (u.protocol === "https:" || u.protocol === "http:") sourceUrl = `${u.origin}${u.pathname}`; // query/fragment dropped (tracking, session ids)
    } catch { sourceUrl = undefined; }
  }
  const out: VehicleComparable = {
    make: raw.make.trim(), model: raw.model.trim(), year, askingPrice: price, currency: raw.currency, country: raw.country,
    sourceName: raw.sourceName.trim().slice(0, 120)
  };
  if (typeof raw.trim === "string" && matchKey(raw.trim)) out.trim = raw.trim.trim();
  if (mileage !== undefined && Number.isFinite(mileage) && mileage >= 0 && mileage <= 2_000_000) out.mileageKm = Math.round(mileage);
  const condition = inEnum(CONDITIONS, raw.condition); if (condition) out.condition = condition;
  const fuel = inEnum(FUEL_TYPES, raw.fuelType); if (fuel) out.fuelType = fuel;
  const transmission = inEnum(TRANSMISSIONS, raw.transmission); if (transmission) out.transmission = transmission;
  const body = inEnum(BODY_TYPES, raw.bodyType); if (body) out.bodyType = body;
  const drivetrain = inEnum(DRIVETRAINS, raw.drivetrain); if (drivetrain) out.drivetrain = drivetrain;
  const city = typeof raw.city === "string" ? normalizeCity(raw.city) : null; if (city) out.city = city.display;
  if (typeof raw.sourceRecordId === "string" && raw.sourceRecordId.trim()) out.sourceRecordId = raw.sourceRecordId.trim().slice(0, 200);
  if (sourceUrl) out.sourceUrl = sourceUrl;
  if (Number.isFinite(observedMs)) out.observedAt = new Date(observedMs).toISOString();
  out.priceType = raw.priceType === "sale" ? "sale" : "listing";
  if (typeof raw.vinHash === "string" && /^[0-9a-f]{64}$/.test(raw.vinHash)) out.vinHash = raw.vinHash;
  return out;
}

const obsMs = (c: VehicleComparable) => (c.observedAt ? Date.parse(c.observedAt) : 0);

/** Deterministic total order used for de-duplication tie-breaks and final output order. */
function stableKey(c: VehicleComparable): string {
  return [c.sourceName.toLowerCase(), c.sourceRecordId ?? "", c.country, c.year, c.askingPrice, c.mileageKm ?? "", c.observedAt ?? "", matchKey(c.trim ?? ""), matchKey(c.city ?? "")].join("|");
}

/**
 * Two-stage de-duplication:
 *  1. provider-level identity — the same sourceName + sourceRecordId (e.g. a listing returned by
 *     two providers that mirror one marketplace, or twice by one provider) keeps the most recently
 *     observed copy;
 *  2. cross-source fingerprint — the same vehicle (make/model/year/trim/mileage/price/currency/
 *     location) re-posted on several sites counts once.
 */
export function deduplicate(comparables: readonly VehicleComparable[]): { kept: VehicleComparable[]; removed: number } {
  const ordered = [...comparables].sort((a, b) => obsMs(b) - obsMs(a) || stableKey(a).localeCompare(stableKey(b)));
  const seenIds = new Set<string>();
  const seenPrints = new Set<string>();
  const kept: VehicleComparable[] = [];
  for (const c of ordered) {
    const id = c.sourceRecordId ? `${c.sourceName.toLowerCase()}::${c.sourceRecordId}` : null;
    const print = [matchKey(c.make), matchKey(c.model), c.year, matchKey(c.trim ?? ""), c.mileageKm ?? "?", c.askingPrice, c.currency, c.country, matchKey(c.city ?? "")].join("|");
    if ((id && seenIds.has(id)) || (c.mileageKm !== undefined && seenPrints.has(print))) continue;
    if (id) seenIds.add(id);
    if (c.mileageKm !== undefined) seenPrints.add(print);
    kept.push(c);
  }
  kept.sort((a, b) => stableKey(a).localeCompare(stableKey(b)));
  return { kept, removed: comparables.length - kept.length };
}

export function searchCacheKey(providerId: string, query: VehicleMarketQuery): string {
  return cacheKey("vve", providerId, query.countries.join(","), query.makeKey, query.modelKey, `${query.yearMin}-${query.yearMax}`, query.observedAfter.slice(0, 10));
}

export async function gatherComparables(
  providers: readonly VehicleMarketProvider[],
  query: VehicleMarketQuery,
  newPriceQuery: { makeKey: string; modelKey: string; year: number; trimKey: string | null; country: string },
  options: RouterOptions
): Promise<GatherResult> {
  const runs = await Promise.all(providers.map(async provider => {
    const started = options.now();
    const key = searchCacheKey(provider.id, query);
    const cached = options.cache?.get(key);
    if (cached) return { run: { providerId: provider.id, status: cached.length ? "ok" : "empty", comparablesReturned: cached.length, fromCache: true, durationMs: 0 } as ProviderRun, rows: cached };
    try {
      const result = await withTimeout(signal => provider.searchComparables(query, signal), options.timeoutMs);
      const durationMs = Math.max(0, options.now() - started);
      if (result === TIMEOUT) return { run: { providerId: provider.id, status: "timeout", comparablesReturned: 0, fromCache: false, durationMs } as ProviderRun, rows: [] };
      const rows = Array.isArray(result) ? result : [];
      options.cache?.set(key, rows);
      return { run: { providerId: provider.id, status: rows.length ? "ok" : "empty", comparablesReturned: rows.length, fromCache: false, durationMs } as ProviderRun, rows };
    } catch {
      return { run: { providerId: provider.id, status: "error", comparablesReturned: 0, fromCache: false, durationMs: Math.max(0, options.now() - started) } as ProviderRun, rows: [] };
    }
  }));

  const raw = runs.flatMap(r => r.rows);
  const sanitized = raw.map(sanitizeComparable).filter((c): c is VehicleComparable => c !== null);
  const { kept, removed } = deduplicate(sanitized);

  let newVehiclePrice: GatherResult["newVehiclePrice"] = null;
  for (const provider of [...providers].sort((a, b) => (a.newPriceRank ?? 100) - (b.newPriceRank ?? 100) || a.id.localeCompare(b.id))) {
    if (!provider.getNewVehiclePrice) continue;
    try {
      const ref = await withTimeout(signal => provider.getNewVehiclePrice!(newPriceQuery, signal), options.timeoutMs);
      if (ref && ref !== TIMEOUT && Number.isFinite(ref.price) && ref.price > 0 && /^[A-Z]{3}$/.test(ref.currency)) { newVehiclePrice = { ...ref, providerId: provider.id }; break; }
    } catch { /* a missing reference is reported as null, never guessed */ }
  }

  return { comparables: kept, runs: runs.map(r => r.run).sort((a, b) => a.providerId.localeCompare(b.providerId)), duplicatesRemoved: removed, invalidRemoved: raw.length - sanitized.length, newVehiclePrice };
}
