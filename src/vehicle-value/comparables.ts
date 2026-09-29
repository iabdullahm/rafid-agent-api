import { matchKey } from "./normalization.js";
import { scoreComparable, type ScoredComparable } from "./similarity.js";
import type { Subject } from "./subject.js";
import { FALLBACK_LEVELS, type ExchangeRateProvider, type FallbackLevel, type VehicleComparable } from "./types.js";

/** Stop widening once a level yields this many comparables. */
export const TARGET_COMPARABLES = 5;
/** Below this many comparables (after outlier removal) no valuation is produced. */
export const MIN_COMPARABLES = 3;

export const FALLBACK_DESCRIPTIONS: Readonly<Record<FallbackLevel, string>> = {
  same_trim_same_year: "Same trim and model year in the local market.",
  same_trim_year_plus_minus_1: "Same trim within ±1 model year in the local market.",
  same_model_year_plus_minus_1: "Same model (any trim) within ±1 model year in the local market.",
  same_model_year_plus_minus_2: "Same model (any trim) within ±2 model years in the local market.",
  regional_same_model_year_plus_minus_2: "Same model within ±2 model years across the local and regional markets."
};

export interface PreparedPool {
  /** Eligible, scored, converted evidence (any fallback level). */
  eligible: ScoredComparable[];
  currencyExcluded: number;
  outOfWindowExcluded: number;
}

/**
 * Eligibility: mandatory make/model match, observed on or before the valuation day and within the
 * maximum evidence age, and convertible into the result currency. Anything else is dropped —
 * currency mismatches are COUNTED (CURRENCY_CONVERSION_UNAVAILABLE), never guessed.
 */
export function preparePool(subject: Subject, comparables: readonly VehicleComparable[], fx: ExchangeRateProvider, maxAgeDays: number): PreparedPool {
  const eligible: ScoredComparable[] = [];
  let currencyExcluded = 0;
  let outOfWindowExcluded = 0;
  const allowedCountries = new Set([subject.countryCode, ...subject.market.regionalCountries]);
  for (const c of comparables) {
    if (matchKey(c.make) !== subject.makeKey || matchKey(c.model) !== subject.modelKey) continue;
    if (!allowedCountries.has(c.country) || Math.abs(c.year - subject.year) > 2) continue;
    if (c.observedAt) {
      const t = Date.parse(c.observedAt);
      if (t > subject.valuationEndMs || subject.valuationEndMs - t > maxAgeDays * 86_400_000) { outOfWindowExcluded++; continue; }
    }
    const price = fx.convert(c.askingPrice, c.currency, subject.currency);
    if (price === null || !Number.isFinite(price) || price <= 0) { currencyExcluded++; continue; }
    eligible.push(scoreComparable(subject, c, price));
  }
  return { eligible, currencyExcluded, outOfWindowExcluded };
}

function inLevel(subject: Subject, s: ScoredComparable, level: FallbackLevel): boolean {
  const dy = Math.abs(s.comparable.year - subject.year);
  const local = s.comparable.country === subject.countryCode;
  switch (level) {
    case "same_trim_same_year": return local && s.trimMatch === "exact" && dy === 0;
    case "same_trim_year_plus_minus_1": return local && s.trimMatch === "exact" && dy <= 1;
    case "same_model_year_plus_minus_1": return local && dy <= 1;
    case "same_model_year_plus_minus_2": return local && dy <= 2;
    case "regional_same_model_year_plus_minus_2": return dy <= 2;
  }
}

/**
 * Progressive widening: the narrowest level with ≥ TARGET_COMPARABLES wins. If none reaches the
 * target, the level with the MOST comparables is used (the narrower one on ties) provided it has at
 * least MIN_COMPARABLES. Trim levels are skipped when the subject's trim is unknown; the regional
 * level only exists when the market defines valid regional fallback countries.
 */
export function selectComparables(subject: Subject, eligible: readonly ScoredComparable[]): { level: FallbackLevel | null; selected: ScoredComparable[] } {
  const levels = FALLBACK_LEVELS.filter(l =>
    !(subject.trimKey === null && (l === "same_trim_same_year" || l === "same_trim_year_plus_minus_1"))
    && !(l === "regional_same_model_year_plus_minus_2" && subject.market.regionalCountries.length === 0));
  let best: { level: FallbackLevel; selected: ScoredComparable[] } | null = null;
  for (const level of levels) {
    const selected = eligible.filter(s => inLevel(subject, s, level));
    if (selected.length >= TARGET_COMPARABLES) return { level, selected };
    if (selected.length > (best?.selected.length ?? 0)) best = { level, selected };
  }
  if (best && best.selected.length >= MIN_COMPARABLES) return best;
  return { level: best?.level ?? null, selected: best?.selected ?? [] };
}
