import { matchKey } from "./normalization.js";
import type { ScoredComparable } from "./similarity.js";
import { clamp, mad, median, quantile, weightedLeastSquares, weightedMedian } from "./stats.js";
import type { Subject } from "./subject.js";
import type { Condition } from "./types.js";

/**
 * vehicle_value_estimate — the deterministic valuation engine (no LLM, no randomness, no clock).
 *
 * 1. Fit the model-year and mileage effects FROM THE COMPARABLES (weighted least squares on
 *    log-price) when the evidence supports it, shrunk toward the market default by n / (n + 8);
 *    otherwise use the market's conservative defaults (flagged as heuristic, confidence reduced).
 * 2. Normalize every comparable's price to the subject's model year and mileage.
 * 3. Remove outliers on the log of the normalized price (Tukey IQR fences for n ≥ 5, modified
 *    z-score on MAD for n = 4) — never by a hard-coded price threshold — then refit once.
 * 4. Anchor = similarity-weighted median of the year-aligned prices, moved by the mileage effect
 *    from the comparables' weighted median mileage to the subject's (market evidence first).
 * 5. Market-derived adjustments (trim alignment, local market, transmission/drivetrain/fuel) only when the
 *    pool contains enough of both groups to measure the difference; otherwise none is invented.
 * 6. Listing → transaction negotiation, then capped, conservative vehicle-specific adjustments
 *    (condition, accident history, service history, owners, premium options).
 */

export type EffectBasis = "market_derived" | "heuristic";

export interface Adjustment { factor: string; impactAmount: number; impactPercent: number; basis: EffectBasis; reason: string }

export interface EffectFit {
  yearCoef: number; yearBasis: EffectBasis | "not_needed";
  kmCoef: number; kmBasis: EffectBasis | "not_applied";
}

export interface ValuationCore {
  used: ScoredComparable[];
  outliersExcluded: number;
  fit: EffectFit;
  normalizedPrices: number[];
  robustDispersion: number | null;
  /** Fair value before vehicle-specific (heuristic) adjustments. */
  fairBase: number;
  mid: number;
  adjustments: Adjustment[];
  heuristicAdjustmentsUsed: boolean;
  notes: string[];
}

const YEAR_COEF_RANGE = [0.01, 0.35] as const;     // log value change per model year newer
const KM_COEF_RANGE = [-0.06, -0.0005] as const;   // log value change per +10,000 km
/** Pseudo-observations given to the market default when shrinking a derived effect. */
export const SHRINKAGE_PRIOR_STRENGTH = 8;

const CONDITION_PCT: Readonly<Record<Exclude<Condition, "unknown">, number>> = { excellent: 0.04, very_good: 0.02, good: 0, fair: -0.06, poor: -0.15 };
const CONDITION_ORDER: readonly Exclude<Condition, "unknown">[] = ["poor", "fair", "good", "very_good", "excellent"];
const ACCIDENT_PCT = { none: 0, minor_cosmetic: -0.03, repaired: -0.10, structural: -0.25, reported: -0.10, unknown: 0 } as const;
const SERVICE_PCT = { full: 0.015, partial: 0, none: -0.04, unknown: 0 } as const;
/** Vehicle-specific heuristic adjustments are capped in total so they can never dominate the market evidence. */
const HEURISTIC_TOTAL_RANGE = [-0.35, 0.06] as const;

export function fitEffects(subject: Subject, rows: readonly ScoredComparable[]): EffectFit {
  const heuristicYear = -Math.log(1 - subject.market.fallbackAnnualDepreciation);
  const heuristicKm = Math.log(1 - subject.market.fallbackValuePer10000Km);
  const yearNeeded = rows.some(r => r.comparable.year !== subject.year);
  const withKm = rows.filter(r => r.comparable.mileageKm !== undefined);
  const kms = withKm.map(r => r.comparable.mileageKm!);
  const kmSpread = kms.length ? (quantile(kms, 0.75)! - quantile(kms, 0.25)!) : 0;
  const canYear = rows.length >= 6 && new Set(rows.map(r => r.comparable.year)).size >= 2;
  const kmRelevant = subject.mileageKm !== null && withKm.length > 0;
  const canKm = kmRelevant && withKm.length >= 6 && kmSpread >= 10_000;

  let yearCoef: number | null = null;
  let kmCoef: number | null = null;
  const dy = (r: ScoredComparable) => r.comparable.year - subject.year;
  const dk = (r: ScoredComparable) => (r.comparable.mileageKm! - subject.mileageKm!) / 10_000;
  if (canYear && canKm && withKm.length >= 6 && new Set(withKm.map(r => r.comparable.year)).size >= 2) {
    const b = weightedLeastSquares(withKm.map(r => ({ y: Math.log(r.price), x: [dy(r), dk(r)], w: Math.max(r.similarity, 0.05) })));
    if (b) { yearCoef = b[1]!; kmCoef = b[2]!; }
  }
  if (yearCoef === null && canYear) {
    const b = weightedLeastSquares(rows.map(r => ({ y: Math.log(r.price), x: [dy(r)], w: Math.max(r.similarity, 0.05) })));
    if (b) yearCoef = b[1]!;
  }
  if (kmCoef === null && canKm) {
    const b = weightedLeastSquares(withKm.map(r => ({ y: Math.log(r.price), x: [dk(r)], w: Math.max(r.similarity, 0.05) })));
    if (b) kmCoef = b[1]!;
  }
  const yearOk = yearCoef !== null && yearCoef >= YEAR_COEF_RANGE[0] && yearCoef <= YEAR_COEF_RANGE[1];
  const kmOk = kmCoef !== null && kmCoef >= KM_COEF_RANGE[0] && kmCoef <= KM_COEF_RANGE[1];
  // Shrinkage toward the market default: an estimate from n comparables gets weight n / (n + k),
  // so a small or noisy pool cannot swing the effect to an extreme, while a large pool dominates.
  const shrink = (derived: number, prior: number, n: number) => (n * derived + SHRINKAGE_PRIOR_STRENGTH * prior) / (n + SHRINKAGE_PRIOR_STRENGTH);
  return {
    yearCoef: yearOk ? shrink(yearCoef!, heuristicYear, rows.length) : heuristicYear,
    yearBasis: !yearNeeded ? "not_needed" : yearOk ? "market_derived" : "heuristic",
    kmCoef: !kmRelevant ? 0 : kmOk ? shrink(kmCoef!, heuristicKm, withKm.length) : heuristicKm,
    kmBasis: !kmRelevant ? "not_applied" : kmOk ? "market_derived" : "heuristic"
  };
}

function yearFactor(subject: Subject, fit: EffectFit, r: ScoredComparable): number {
  return Math.exp(fit.yearCoef * (subject.year - r.comparable.year));
}
function kmFactor(subject: Subject, fit: EffectFit, r: ScoredComparable): number {
  if (fit.kmBasis === "not_applied" || subject.mileageKm === null || r.comparable.mileageKm === undefined) return 1;
  return Math.exp(fit.kmCoef * (subject.mileageKm - r.comparable.mileageKm) / 10_000);
}

/** Tukey fences (n ≥ 5) or modified z-score > 3.5 on MAD (n = 4) over log values. */
export function outlierMask(logValues: readonly number[]): boolean[] {
  const n = logValues.length;
  if (n >= 5) {
    const q1 = quantile(logValues, 0.25)!;
    const q3 = quantile(logValues, 0.75)!;
    const iqr = Math.max(q3 - q1, 0.02);
    return logValues.map(v => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr);
  }
  if (n === 4) {
    const m = median(logValues)!;
    const d = mad(logValues)!;
    if (d === 0) return logValues.map(() => true);
    return logValues.map(v => Math.abs(0.6745 * (v - m) / d) <= 3.5);
  }
  return logValues.map(() => true);
}

/** Ratio of the median normalized price inside a group to the whole pool — only when both the
 *  group and the rest have ≥ 2 members; otherwise null (no difference is invented). */
function groupRatio(prices: readonly number[], inGroup: readonly boolean[], known: readonly boolean[], limit: number): number | null {
  const group = prices.filter((_, i) => inGroup[i]);
  const others = prices.filter((_, i) => known[i] && !inGroup[i]);
  if (group.length < 2 || others.length < 2) return null;
  const all = prices.filter((_, i) => known[i]);
  return clamp(median(group)! / median(all)!, 1 - limit, 1 + limit);
}

/** Trim alignment for model-level pools: each comparable whose trim is measurable (≥ 2 listings of
 *  that trim in the pool) is scaled by median(subject trim) / median(its trim), measured on
 *  year/mileage-normalized prices. Requires ≥ 2 comparables of the subject's own trim; otherwise
 *  every factor is 1 (no trim difference is invented). */
function trimFactors(subject: Subject, rows: readonly ScoredComparable[], normalized: readonly number[], level: string): { factors: number[]; measured: boolean } {
  const ones = rows.map(() => 1);
  if (!subject.trimKey || level.startsWith("same_trim")) return { factors: ones, measured: false };
  const groups = new Map<string, number[]>();
  rows.forEach((r, i) => { if (r.comparable.trim) { const k = matchKey(r.comparable.trim); groups.set(k, [...(groups.get(k) ?? []), normalized[i]!]); } });
  const own = groups.get(subject.trimKey);
  if (!own || own.length < 2 || groups.size < 2) return { factors: ones, measured: false };
  const ref = median(own)!;
  const factors = rows.map(r => {
    const g = r.comparable.trim ? groups.get(matchKey(r.comparable.trim)) : undefined;
    return g && g.length >= 2 ? clamp(ref / median(g)!, 0.7, 1 / 0.7) : 1;
  });
  return { factors, measured: true };
}

interface Aligned { fit: EffectFit; trim: number[]; trimMeasured: boolean; normalized: number[] }

/** Fit → trim-align → refit, so neither the year/mileage fit nor the outlier stage mistakes a
 *  different trim's price level for noise. */
function alignAndFit(subject: Subject, rows: readonly ScoredComparable[], level: string): Aligned {
  const fit0 = fitEffects(subject, rows);
  const norm0 = rows.map(r => r.price * yearFactor(subject, fit0, r) * kmFactor(subject, fit0, r));
  const { factors, measured } = trimFactors(subject, rows, norm0, level);
  const adjusted = rows.map((r, i) => ({ ...r, price: r.price * factors[i]! }));
  const fit = measured ? fitEffects(subject, adjusted) : fit0;
  const normalized = adjusted.map(r => r.price * yearFactor(subject, fit, r) * kmFactor(subject, fit, r));
  return { fit, trim: factors, trimMeasured: measured, normalized };
}

export function runValuation(subject: Subject, selected: readonly ScoredComparable[], level: string): ValuationCore {
  const notes: string[] = [];
  // Align/fit → remove outliers → align/fit again on the inliers.
  const first = alignAndFit(subject, selected, level);
  const keep = outlierMask(first.normalized.map(Math.log));
  const used = selected.filter((_, i) => keep[i]);
  const outliersExcluded = selected.length - used.length;
  const { fit, trim, trimMeasured, normalized } = outliersExcluded > 0 ? alignAndFit(subject, used, level) : first;

  const weights = used.map(r => Math.max(r.similarity, 0.05));
  const raw = weightedMedian(used.map(r => r.price), weights)!;
  // Year: each comparable is aligned to the subject's model year individually (pools can mix years).
  const yearOnly = weightedMedian(used.map(r => r.price * yearFactor(subject, fit, r)), weights)!;
  // Trim: each comparable is aligned to the subject's trim (model-level pools only).
  const yearAligned = weightedMedian(used.map((r, i) => r.price * trim[i]! * yearFactor(subject, fit, r)), weights)!;
  // Mileage: applied once, from the comparables' weighted median mileage to the subject's — so the
  // reported impact always has the sign of (subject mileage − market mileage).
  const withKm = used.filter(r => r.comparable.mileageKm !== undefined);
  const marketKm = withKm.length ? weightedMedian(withKm.map(r => r.comparable.mileageKm!), withKm.map(r => Math.max(r.similarity, 0.05))) : null;
  const mileageImpact = fit.kmBasis !== "not_applied" && marketKm !== null && subject.mileageKm !== null
    ? yearAligned * (Math.exp(fit.kmCoef * (subject.mileageKm - marketKm) / 10_000) - 1) : 0;
  const anchor = yearAligned + mileageImpact;
  const logs = normalized.map(Math.log);
  const robustDispersion = used.length >= 2 ? 1.4826 * mad(logs)! : null;

  const adjustments: Adjustment[] = [];
  const push = (factor: string, amount: number, base: number, basis: EffectBasis, reason: string) => {
    if (Math.abs(amount) < 1e-9) return;
    adjustments.push({ factor, impactAmount: amount, impactPercent: (amount / base) * 100, basis, reason });
  };

  if (fit.yearBasis !== "not_needed") {
    const medianYear = weightedMedian(used.map(r => r.comparable.year), weights)!;
    push("model_year", yearOnly - raw, raw, fit.yearBasis,
      `Comparables span model years ${Math.min(...used.map(r => r.comparable.year))}–${Math.max(...used.map(r => r.comparable.year))} (weighted median ${medianYear}); prices were aligned to ${subject.year} using a ${fit.yearBasis === "market_derived" ? "market-derived" : "conservative default"} year effect of ${((1 - Math.exp(-fit.yearCoef)) * 100).toFixed(1)}% per model year.`);
  }
  if (trimMeasured) {
    const pct = (yearAligned / yearOnly - 1) * 100;
    push("trim", yearAligned - yearOnly, yearOnly, "market_derived", `Comparables of other trims were aligned to the ${subject.trim} trim using the price gap measured in this pool (net effect ${pct.toFixed(1)}%).`);
  } else if (subject.trimKey && !level.startsWith("same_trim")) {
    notes.push(used.some(r => r.trimMatch === "exact")
      ? `Too few ${subject.trim} comparables to measure a trim price gap; other trims were used without a trim adjustment (model-level estimate).`
      : `No comparable with the ${subject.trim} trim was available; the estimate is model-level and does not price trim differences.`);
  }
  if (fit.kmBasis !== "not_applied" && marketKm !== null) {
    const direction = subject.mileageKm! > marketKm ? "above" : subject.mileageKm! < marketKm ? "below" : "equal to";
    push("mileage", mileageImpact, yearAligned, fit.kmBasis,
      `Mileage (${subject.mileageKm!.toLocaleString("en-US")} km) is ${direction} the comparable-market median (${Math.round(marketKm).toLocaleString("en-US")} km); ${fit.kmBasis === "market_derived" ? "the market-derived" : "a conservative default"} mileage effect is ${((Math.exp(fit.kmCoef) - 1) * 100).toFixed(2)}% per 10,000 km.`);
  }

  let base = anchor;
  // Local market: only when regional comparables were needed and local ones are measurable.
  if (level.startsWith("regional")) {
    const local = used.map(r => r.comparable.country === subject.countryCode);
    const ratio = groupRatio(normalized, local, used.map(() => true), 0.15);
    if (ratio !== null) { push("local_market", base * (ratio - 1), base, "market_derived", `${subject.countryName} comparables are priced ${((ratio - 1) * 100).toFixed(1)}% relative to the regional pool.`); base *= ratio; }
    else notes.push(`Too few ${subject.countryName} comparables to measure a local-versus-regional price difference; regional prices were used without a local-market adjustment.`);
  }
  // Transmission / drivetrain / fuel type: derived only when the pool contains both groups.
  for (const [factor, value, get, label] of [
    ["transmission", subject.transmission, (r: ScoredComparable) => r.comparable.transmission, "transmission"],
    ["drivetrain", subject.drivetrain, (r: ScoredComparable) => r.comparable.drivetrain, "drivetrain"],
    ["fuel_type", subject.fuelType, (r: ScoredComparable) => r.comparable.fuelType, "fuel type"]
  ] as const) {
    if (value === null) continue;
    const known = used.map(r => get(r) !== undefined);
    const same = used.map(r => get(r) === value);
    const ratio = groupRatio(normalized, same, known, 0.10);
    if (ratio !== null) { push(factor, base * (ratio - 1), base, "market_derived", `Comparables with the same ${label} (${value}) are priced ${((ratio - 1) * 100).toFixed(1)}% relative to the pool.`); base *= ratio; }
    else if (known.filter(Boolean).length >= 3 && same.filter(Boolean).length === 0) notes.push(`No comparable shares the subject's ${label} (${value}); no ${label} adjustment could be measured.`);
  }

  // Asking price → agreed price (listings only).
  const listingShare = used.filter(r => (r.comparable.priceType ?? "listing") === "listing").length / used.length;
  const negotiation = subject.market.listingNegotiationDiscount * listingShare;
  if (negotiation > 0) push("listing_to_transaction", -base * negotiation, base, "heuristic",
    `Comparable prices are ${listingShare === 1 ? "" : `${Math.round(listingShare * 100)}% `}listing asking prices; a ${(subject.market.listingNegotiationDiscount * 100).toFixed(1)}% typical negotiation margin for ${subject.countryName} converts them to fair market value.`);
  const fairBase = base * (1 - negotiation);

  // Vehicle-specific heuristic adjustments, relative to the comparables' typical profile.
  const specific: { factor: string; pct: number; reason: string }[] = [];
  if (subject.condition !== "unknown") {
    const compConds = used.map(r => r.comparable.condition).filter((c): c is Exclude<Condition, "unknown"> => c !== undefined && c !== "unknown");
    const baseline: Exclude<Condition, "unknown"> = compConds.length >= Math.ceil(used.length / 2)
      ? CONDITION_ORDER[Math.round(median(compConds.map(c => CONDITION_ORDER.indexOf(c)))!)]! : "good";
    const pct = CONDITION_PCT[subject.condition] - CONDITION_PCT[baseline];
    if (pct !== 0) specific.push({ factor: "condition", pct, reason: `Condition "${subject.condition}" versus the comparables' typical "${baseline}" condition (conservative, capped adjustment).` });
  }
  const acc = ACCIDENT_PCT[subject.accidentHistory];
  if (acc !== 0) specific.push({ factor: "accident_history", pct: acc, reason: subject.accidentHistory === "reported"
    ? "An accident was reported without a stated severity; valued as a repaired, non-structural accident. Severity is unverified."
    : `Accident history "${subject.accidentHistory}" typically reduces resale value versus comparables without a disclosed accident.` });
  const svc = SERVICE_PCT[subject.serviceHistory];
  if (svc !== 0) specific.push({ factor: subject.serviceHistory === "full" ? "full_service_history" : "service_history", pct: svc, reason: subject.serviceHistory === "full"
    ? "Documented full service history supports stronger resale value." : "No service history lowers buyer confidence and resale value." });
  if (subject.owners !== null) {
    const pct = subject.owners === 1 ? (subject.ageYears >= 3 ? 0.01 : 0) : subject.owners === 2 ? 0 : subject.owners === 3 ? -0.02 : -0.04;
    if (pct !== 0) specific.push({ factor: "owner_count", pct, reason: subject.owners === 1 ? "Single owner over several years supports resale value." : `${subject.owners} previous owners typically reduce resale value.` });
  }
  if (subject.premiumOptions.length) {
    const pct = Math.min(0.02, 0.005 * subject.premiumOptions.length);
    specific.push({ factor: "major_options", pct, reason: `Premium equipment (${subject.premiumOptions.join(", ")}) — small, capped uplift; comparables do not report equipment, so this is not market-derived.` });
  }
  const total = specific.reduce((s, a) => s + a.pct, 0);
  const cappedTotal = clamp(total, HEURISTIC_TOTAL_RANGE[0], HEURISTIC_TOTAL_RANGE[1]);
  const scale = total === 0 ? 1 : cappedTotal / total;
  if (scale !== 1) notes.push(`Vehicle-specific adjustments were capped at ${(cappedTotal * 100).toFixed(0)}% in total so they cannot dominate the market evidence.`);
  for (const a of specific) push(a.factor, fairBase * a.pct * scale, fairBase, "heuristic", a.reason);

  const mid = fairBase * (1 + cappedTotal);
  return {
    used, outliersExcluded, fit, normalizedPrices: normalized, robustDispersion, fairBase, mid, adjustments,
    heuristicAdjustmentsUsed: specific.length > 0 || fit.yearBasis === "heuristic" || fit.kmBasis === "heuristic",
    notes
  };
}

/** Deterministic rounding step for published prices: coarser for larger values and for weak evidence. */
export function roundingStep(value: number, weakEvidence: boolean): number {
  const base = value < 2_000 ? 10 : value < 20_000 ? 50 : value < 200_000 ? 100 : value < 2_000_000 ? 500 : 1000;
  return weakEvidence ? base * 2 : base;
}

export const roundTo = (value: number, step: number) => Math.round(value / step) * step;

/** Point inside a [min, max] spread picked deterministically from confidence (0–1). */
export const lerp = (range: readonly [number, number], t: number) => range[0] + (range[1] - range[0]) * clamp(t, 0, 1);
