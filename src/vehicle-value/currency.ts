import type { ExchangeRateProvider } from "./types.js";

/**
 * vehicle_value_estimate — currency handling.
 *
 * Rates are never hard-coded and never guessed. A conversion happens only through a configured,
 * dated rate source; otherwise evidence priced in another currency is excluded and flagged
 * CURRENCY_CONVERSION_UNAVAILABLE. Every conversion a valuation uses is reported in its
 * `currencyConversion` block (pair, rate, source, rate date).
 *
 * Sources (VEHICLE_FX_SOURCES, tried in order per currency pair):
 *  - `ecb` — European Central Bank euro reference rates
 *    (https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml): free, keyless, ~30 currencies
 *    (USD, GBP, CAD, AUD, CHF, SEK, DKK, PLN, JPY, …) — NOT the GCC currencies. The ECB publishes
 *    them "for information purposes only", which fits comparable normalization (not a transaction).
 *  - `exchangerate_api` — ExchangeRate-API (https://www.exchangerate-api.com): covers OMR, AED, SAR,
 *    QAR, BHD, KWD and ~160 more, updated daily. With EXCHANGERATE_API_KEY the keyed endpoint
 *    (`v6.exchangerate-api.com/v6/{key}/latest/USD`) is used, otherwise the open-access endpoint
 *    (`open.er-api.com/v6/latest/USD`, rate-limited, attribution requested). Its terms forbid
 *    redistributing its rates; Rafid only applies them to comparables.
 */

export interface RateTable {
  source: string;
  /** Base currency the rates are quoted against (1 base = rate units of currency). */
  base: string;
  rates: Readonly<Record<string, number>>;
  /** The date the rates apply to (YYYY-MM-DD). */
  rateDate: string | null;
}

export interface ExchangeRateSource {
  readonly id: string;
  load(signal: AbortSignal): Promise<RateTable | null>;
}

/** Default: only same-currency amounts convert. */
export class SameCurrencyOnly implements ExchangeRateProvider {
  convert(amount: number, from: string, to: string): number | null {
    return from === to ? amount : null;
  }
}

/** Explicit rate table (units of `to` per 1 unit of `from`) — tests or an operator-supplied source. */
export class TableExchangeRates implements ExchangeRateProvider {
  constructor(private readonly rates: Readonly<Record<string, number>>, private readonly label = "injected_rate_table", private readonly rateDate: string | null = null) {}
  private rate(from: string, to: string): number | null {
    if (from === to) return 1;
    const direct = this.rates[`${from}/${to}`];
    if (direct && Number.isFinite(direct) && direct > 0) return direct;
    const inverse = this.rates[`${to}/${from}`];
    if (inverse && Number.isFinite(inverse) && inverse > 0) return 1 / inverse;
    return null;
  }
  convert(amount: number, from: string, to: string): number | null {
    const r = this.rate(from, to);
    return r === null ? null : amount * r;
  }
  describe(from: string, to: string) {
    return this.rate(from, to) === null ? null : { source: this.label, rateDate: this.rateDate };
  }
}

/** Cross rates through a table's base currency. */
function crossRate(table: RateTable, from: string, to: string): number | null {
  const rf = from === table.base ? 1 : table.rates[from];
  const rt = to === table.base ? 1 : table.rates[to];
  if (!rf || !rt || !Number.isFinite(rf) || !Number.isFinite(rt) || rf <= 0 || rt <= 0) return null;
  return rt / rf;
}

/** A converter over already-loaded tables (first table that can price the pair wins). */
export class LoadedExchangeRates implements ExchangeRateProvider {
  constructor(private readonly tables: readonly RateTable[]) {}
  private find(from: string, to: string): { rate: number; table: RateTable } | null {
    if (from === to) return null;
    for (const table of this.tables) {
      const rate = crossRate(table, from, to);
      if (rate !== null) return { rate, table };
    }
    return null;
  }
  convert(amount: number, from: string, to: string): number | null {
    if (from === to) return amount;
    const hit = this.find(from, to);
    return hit ? amount * hit.rate : null;
  }
  describe(from: string, to: string) {
    const hit = this.find(from, to);
    return hit ? { source: hit.table.source, rateDate: hit.table.rateDate } : null;
  }
}

// ---- live sources -------------------------------------------------------------------------------

export class EcbRateSource implements ExchangeRateSource {
  readonly id = "ecb";
  constructor(private readonly options: { fetchImpl?: typeof fetch; url?: string } = {}) {}
  async load(signal: AbortSignal): Promise<RateTable | null> {
    const response = await (this.options.fetchImpl ?? fetch)(this.options.url ?? "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml", { signal });
    if (!response.ok) return null;
    return parseEcbXml(await response.text());
  }
}

export function parseEcbXml(xml: string): RateTable | null {
  const date = /time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1] ?? null;
  const rates: Record<string, number> = {};
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]/g)) {
    const v = Number(m[2]);
    if (Number.isFinite(v) && v > 0) rates[m[1]!] = v;
  }
  return Object.keys(rates).length ? { source: "ecb", base: "EUR", rates, rateDate: date } : null;
}

export class ExchangeRateApiSource implements ExchangeRateSource {
  readonly id = "exchangerate_api";
  constructor(private readonly options: { apiKey?: string; fetchImpl?: typeof fetch } = {}) {}
  async load(signal: AbortSignal): Promise<RateTable | null> {
    const url = this.options.apiKey
      ? `https://v6.exchangerate-api.com/v6/${encodeURIComponent(this.options.apiKey)}/latest/USD`
      : "https://open.er-api.com/v6/latest/USD";
    const response = await (this.options.fetchImpl ?? fetch)(url, { signal, headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    return parseExchangeRateApi(await response.json());
  }
}

export function parseExchangeRateApi(body: unknown): RateTable | null {
  const b = body as { result?: string; base_code?: string; rates?: Record<string, number>; conversion_rates?: Record<string, number>; time_last_update_unix?: number };
  if (!b || b.result !== "success") return null;
  const raw = b.conversion_rates ?? b.rates;
  if (!raw || typeof raw !== "object" || typeof b.base_code !== "string") return null;
  const rates: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) if (/^[A-Z]{3}$/.test(k) && Number.isFinite(v) && v > 0) rates[k] = v;
  const date = Number.isFinite(b.time_last_update_unix) ? new Date(b.time_last_update_unix! * 1000).toISOString().slice(0, 10) : null;
  return Object.keys(rates).length ? { source: "exchangerate_api", base: b.base_code, rates, rateDate: date } : null;
}

/**
 * Loads each configured source at most once per `ttlMs` (both publish daily), concurrently and
 * under a timeout; a failing source is skipped (its pairs stay unconvertible), never guessed.
 */
const MAX_STALE_MS = 3 * 24 * 60 * 60 * 1000;

export class ExchangeRateService {
  private cache = new Map<string, { at: number; table: RateTable | null }>();
  constructor(private readonly sources: readonly ExchangeRateSource[], private readonly options: { ttlMs?: number; timeoutMs?: number; now?: () => number } = {}) {}

  get configured(): readonly string[] { return this.sources.map(s => s.id); }

  async prepare(): Promise<LoadedExchangeRates> {
    const now = (this.options.now ?? Date.now)();
    const ttl = this.options.ttlMs ?? 6 * 60 * 60 * 1000;
    const tables = await Promise.all(this.sources.map(async source => {
      const hit = this.cache.get(source.id);
      if (hit && now - hit.at < ttl && hit.table) return hit.table;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 3000);
      try {
        const table = await source.load(controller.signal);
        this.cache.set(source.id, { at: now, table });
        return table;
      } catch {
        // Keep serving a previously loaded table for up to MAX_STALE_MS if a refresh fails.
        return hit && now - hit.at < MAX_STALE_MS ? hit.table : null;
      } finally { clearTimeout(timer); }
    }));
    return new LoadedExchangeRates(tables.filter((t): t is RateTable => t !== null));
  }
}
