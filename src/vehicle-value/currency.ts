import type { ExchangeRateProvider } from "./types.js";

/**
 * vehicle_value_estimate — currency handling.
 *
 * The project has no exchange-rate abstraction, and FX rates must never be hard-coded, so the
 * default provider converts ONLY same-currency amounts. A comparable priced in a different
 * currency is therefore excluded (and CURRENCY_CONVERSION_UNAVAILABLE is flagged) unless a real
 * rate source is injected through this interface — never silently converted with a guessed rate.
 */
export class SameCurrencyOnly implements ExchangeRateProvider {
  convert(amount: number, from: string, to: string): number | null {
    return from === to ? amount : null;
  }
}

/** Explicit rate table (units of `to` per 1 unit of `from`), for an operator-supplied, dated rate
 *  source or for tests. Missing pairs return null; the inverse of a supplied pair is derived. */
export class TableExchangeRates implements ExchangeRateProvider {
  constructor(private readonly rates: Readonly<Record<string, number>>) {}
  convert(amount: number, from: string, to: string): number | null {
    if (from === to) return amount;
    const direct = this.rates[`${from}/${to}`];
    if (direct && Number.isFinite(direct) && direct > 0) return amount * direct;
    const inverse = this.rates[`${to}/${from}`];
    if (inverse && Number.isFinite(inverse) && inverse > 0) return amount / inverse;
    return null;
  }
}
