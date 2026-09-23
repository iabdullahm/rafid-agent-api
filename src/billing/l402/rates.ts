/**
 * BTC/USD rate for converting each capability's catalog USD price (billing/catalog.ts — still the
 * one source of truth for price) into sats at challenge time, so an L402 call costs the same as
 * the x402 call for the same tool. Public, keyless spot-price endpoints only; a short in-process
 * cache keeps a burst of 402 challenges from hammering them.
 *
 * Resolution order: fresh cache → Coinbase → Kraken → last good rate if not older than
 * MAX_STALE_MS → L402_BTC_USD_FALLBACK → null. null means "no honest rate available": the caller
 * returns 503 rather than guessing a price.
 */
export interface BtcUsdQuote {
  btcUsd: number;
  source: "coinbase" | "kraken" | "stale_cache" | "configured_fallback";
  fetchedAt: string;
}

export interface BtcUsdRateProvider {
  getRate(): Promise<BtcUsdQuote | null>;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Rejects obviously-broken upstream values so a bad API response can never price a call at a
 *  fraction of a cent or at thousands of dollars. */
const MIN_PLAUSIBLE = 1_000, MAX_PLAUSIBLE = 10_000_000;
const MAX_STALE_MS = 15 * 60 * 1000;

function plausible(n: unknown): number | null {
  const v = typeof n === "string" ? Number(n) : typeof n === "number" ? n : NaN;
  return Number.isFinite(v) && v >= MIN_PLAUSIBLE && v <= MAX_PLAUSIBLE ? v : null;
}

export class PublicBtcUsdRateProvider implements BtcUsdRateProvider {
  private cached: { btcUsd: number; source: "coinbase" | "kraken"; at: number } | null = null;

  constructor(private readonly opts: { cacheMs: number; fallbackBtcUsd: number | null; fetchImpl?: FetchLike; now?: () => number; timeoutMs?: number }) {}

  private now(): number { return this.opts.now?.() ?? Date.now(); }

  private async fetchJson(url: string): Promise<unknown> {
    const fetchImpl = this.opts.fetchImpl ?? (fetch as unknown as FetchLike);
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(this.opts.timeoutMs ?? 3000), headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("rate source error");
    return res.json();
  }

  private async fromCoinbase(): Promise<number | null> {
    const body = await this.fetchJson("https://api.coinbase.com/v2/prices/BTC-USD/spot") as { data?: { amount?: unknown } };
    return plausible(body?.data?.amount);
  }

  private async fromKraken(): Promise<number | null> {
    const body = await this.fetchJson("https://api.kraken.com/0/public/Ticker?pair=XBTUSD") as { result?: Record<string, { c?: unknown[] }> };
    const first = body?.result ? Object.values(body.result)[0] : undefined;
    return plausible(first?.c?.[0]);
  }

  async getRate(): Promise<BtcUsdQuote | null> {
    const now = this.now();
    if (this.cached && now - this.cached.at < this.opts.cacheMs) {
      return { btcUsd: this.cached.btcUsd, source: this.cached.source, fetchedAt: new Date(this.cached.at).toISOString() };
    }
    for (const [source, get] of [["coinbase", () => this.fromCoinbase()], ["kraken", () => this.fromKraken()]] as const) {
      try {
        const rate = await get();
        if (rate !== null) {
          this.cached = { btcUsd: rate, source, at: now };
          return { btcUsd: rate, source, fetchedAt: new Date(now).toISOString() };
        }
      } catch { /* try the next source */ }
    }
    if (this.cached && now - this.cached.at < MAX_STALE_MS) {
      return { btcUsd: this.cached.btcUsd, source: "stale_cache", fetchedAt: new Date(this.cached.at).toISOString() };
    }
    if (this.opts.fallbackBtcUsd !== null) {
      return { btcUsd: this.opts.fallbackBtcUsd, source: "configured_fallback", fetchedAt: new Date(now).toISOString() };
    }
    return null;
  }
}

/** USD → sats, always rounded UP (never undercharge because of rounding), minimum 1 sat. */
export function usdToSats(usd: number, btcUsd: number): number {
  return Math.max(1, Math.ceil((usd / btcUsd) * 100_000_000));
}
